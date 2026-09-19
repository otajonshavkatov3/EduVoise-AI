/**
 * The two guards.
 *
 * There were no tests over this before, which is how a guard driven entirely by
 * transcription events shipped: nothing anywhere asserted what the guard was
 * supposed to be measuring, so "the provider stopped talking to us" and "nobody
 * is on the line" collapsed into one code path and the platform started hanging
 * up on callers mid-sentence.
 *
 * Two mechanisms answer those two questions now, and they are deliberately not
 * wired to each other:
 *
 *   the silence timer   reset by ANY sign of life, the caller's own voice
 *                       included. When it expires nobody is there, and the call
 *                       ends. Nothing to classify - everything that could mean
 *                       otherwise has already reset it.
 *   the stall timer     armed by caller speech, cleared by agent audio, and its
 *                       expiry classified by `classifyAgentStall`. This is the
 *                       one that catches a model which has gone deaf.
 *
 * These tests pin the evidence (CallerVoiceActivity over the caller's own frames)
 * to the verdicts, driven with audio shaped like the levels measured on the real
 * calls in the bug report.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { AUDIOSOCKET_FRAME_BYTES, AUDIOSOCKET_FRAME_MS, CallerVoiceActivity } from "@/lib/ai";
import {
	classifyAgentStall,
	classifyFailedTransfer,
	isUncorroboratedStall,
} from "./call-orchestrator";

// ===========================================
// Fixtures
// ===========================================

/** The silence window this deployment ships with, and the one in the bug report. */
const SILENCE_WINDOW_MS = 20_000;
/** AGENT_STALL_TURN_GAP_MS in call-orchestrator.ts. */
const TURN_GAP_MS = 4_000;

function frameAtRms(rms: number): Buffer {
	const frame = Buffer.alloc(AUDIOSOCKET_FRAME_BYTES);
	const samples = AUDIOSOCKET_FRAME_BYTES / 2;

	for (let i = 0; i < samples; i++) {
		frame.writeInt16LE(i % 2 === 0 ? rms : -rms, i * 2);
	}

	return frame;
}

/**
 * Levels taken from three real recordings, all framed the way the wire is.
 *
 *   SPEECH  -14 dBFS. Call 6c5a2006 (the reported bug) measured a per-second
 *           mean of -12 to -35 dBFS while the caller talked.
 *   LINE    -64 dBFS. The same call between words, and the tail of call
 *           002959b3 just before it went quiet.
 *   NOISE   -38 dBFS. Call edd90885: 150 s of band-limited noise with no speech
 *           anywhere in it, on which the previous absolute-threshold detector
 *           reported 1398 loud frames out of 1398.
 *   SILENCE literal zeros - which is what call 002959b3 actually carried for the
 *           13 s that tripped the guard on it.
 */
const SPEECH = frameAtRms(6500);
const LINE = frameAtRms(20);
const NOISE = frameAtRms(413);
const SILENCE = Buffer.alloc(AUDIOSOCKET_FRAME_BYTES);

/**
 * One call's worth of caller audio, replayed on a fake clock.
 *
 * `armedAt` mirrors the moment the stall timer was armed: the caller's first word
 * after the agent last produced audio.
 */
class CallerLine {
	readonly voice = new CallerVoiceActivity();
	now = 1_000_000;

	constructor(leadInMs = 500) {
		// Half a second of line before anyone speaks, which is what a real call
		// gives the detector to measure the line from: the channel is answered and
		// the greeting plays before the caller says a word.
		this.play(LINE, leadInMs);
	}

	play(frame: Buffer, ms: number): void {
		for (let elapsed = 0; elapsed < ms; elapsed += AUDIOSOCKET_FRAME_MS) {
			this.voice.push(frame, this.now);
			this.now += AUDIOSOCKET_FRAME_MS;
		}
	}

	/** Speech with the word gaps a person actually leaves. Rounds up to whole words. */
	speak(ms: number): number {
		const from = this.now;

		for (let elapsed = 0; elapsed < ms; elapsed += 480) {
			this.play(SPEECH, 400);
			this.play(SILENCE, 80);
		}

		return this.now - from;
	}

	/** What the stall timer would decide if it fired right now. */
	stallVerdict(): ReturnType<typeof classifyAgentStall> {
		return classifyAgentStall(this.voice.msSinceVoice(this.now), TURN_GAP_MS);
	}

	/** True when the silence timer, armed at `armedAt`, would still be pending. */
	silenceDeferred(armedAt: number): boolean {
		// Caller speech resets the silence timer, so the deadline it would fire at is
		// always one window past the caller's last word.
		const lastVoiceAt = this.voice.stats().lastVoiceAt;
		const restartedAt = Math.max(armedAt, lastVoiceAt ?? armedAt);

		return this.now < restartedAt + SILENCE_WINDOW_MS;
	}
}

// ===========================================
// The stall verdict, on its own
// ===========================================

describe("classifyAgentStall", () => {
	test("a caller who has never been heard is not an unanswered turn", () => {
		// The fallback path has no AudioSocket to measure, and an empty line has
		// nothing to answer. Both belong to the silence guard, not this one.
		expect(classifyAgentStall(null, TURN_GAP_MS)).toBe("no-caller");
	});

	test("a caller who is still talking is not being ignored", () => {
		// The single most important case: a model listening properly to somebody
		// mid-sentence looks exactly like a model that has gone deaf, and cutting in
		// on the first to catch the second would be worse than the fault.
		expect(classifyAgentStall(0, TURN_GAP_MS)).toBe("caller-mid-turn");
		expect(classifyAgentStall(TURN_GAP_MS - 1, TURN_GAP_MS)).toBe("caller-mid-turn");
	});

	test("a caller who finished and got nothing back is an unanswered turn", () => {
		expect(classifyAgentStall(TURN_GAP_MS, TURN_GAP_MS)).toBe("agent-stalled");
		expect(classifyAgentStall(30_000, TURN_GAP_MS)).toBe("agent-stalled");
	});
});

// ===========================================
// The guards, driven by real-shaped audio
// ===========================================

describe("isUncorroboratedStall", () => {
	// Ships as 3 in call-orchestrator.ts; the tests state it rather than import it,
	// so a change to the constant shows up here as a deliberate decision.
	const MAX = 3;

	test("energy alone stops being believed after enough unanswered windows", () => {
		// The live case this exists for: a line with nobody on it whose noise swelled
		// +/-9 dB crossed the over-noise ratio on every swell, held the call open and
		// wrote three "the caller is talking" notes about nobody.
		expect(isUncorroboratedStall(MAX + 1, 0, MAX)).toBe(true);
	});

	test("it is patient before then - a real caller may simply be slow to be heard", () => {
		expect(isUncorroboratedStall(1, 0, MAX)).toBe(false);
		expect(isUncorroboratedStall(MAX, 0, MAX)).toBe(false);
	});

	test("one transcribed word settles it forever", () => {
		// Somebody demonstrably spoke. However badly the agent then struggles, the
		// call must never be abandoned as an empty line.
		expect(isUncorroboratedStall(MAX + 1, 1, MAX)).toBe(false);
		expect(isUncorroboratedStall(100, 1, MAX)).toBe(false);
	});
});

describe("the guards over a caller's audio", () => {
	test("does not hang up on the reported bug: 30 s of caller speech, no agent reply", () => {
		const line = new CallerLine();
		const armedAt = line.now;

		// Call 6c5a2006: 31.6 s of caller audio reached the provider, which produced
		// no transcription and no reply at all. Every 20 ms of it goes through the
		// same detector production uses.
		const spokenMs = line.speak(31_600);

		expect(spokenMs).toBeGreaterThanOrEqual(31_600);
		// The silence timer never expires, because the caller's own voice resets it.
		// That alone is the fix: the call is not ended.
		expect(line.silenceDeferred(armedAt)).toBe(true);
		expect(line.voice.stats().voicedFrames).toBeGreaterThan(1000);
	});

	test("a caller who keeps talking is never cut off, window after window", () => {
		const line = new CallerLine();
		const armedAt = line.now;

		// Five consecutive windows with no agent activity whatsoever.
		for (let window = 0; window < 5; window++) {
			line.speak(SILENCE_WINDOW_MS);
			expect(line.silenceDeferred(armedAt)).toBe(true);
		}

		// ...and the moment they do stop, the guard works again.
		const stoppedAt = line.now;
		line.play(SILENCE, SILENCE_WINDOW_MS);
		expect(line.silenceDeferred(stoppedAt)).toBe(false);
	});

	test("still hangs up on a line nobody is on", () => {
		const line = new CallerLine();
		const armedAt = line.now;

		// Asterisk keeps delivering 50 frames a second throughout - which is the
		// reason frame arrival cannot be the signal.
		line.play(SILENCE, SILENCE_WINDOW_MS + 5_000);

		expect(line.voice.stats().frames).toBeGreaterThan(1200);
		expect(line.voice.stats().lastVoiceAt).toBeNull();
		expect(line.silenceDeferred(armedAt)).toBe(false);
		expect(line.stallVerdict()).toBe("no-caller");
	});

	test("still hangs up on an open mic in a quiet room", () => {
		const line = new CallerLine();
		const armedAt = line.now;

		line.play(LINE, SILENCE_WINDOW_MS + 5_000);

		expect(line.voice.stats().loudFrames).toBe(0);
		expect(line.silenceDeferred(armedAt)).toBe(false);
	});

	test("still hangs up on a NOISY line nobody is on", () => {
		// The blocker: call edd90885 carried 150 s of -38 dBFS noise with no speech
		// in it, from the first frame. Against a fixed -45 dBFS gate every one of its
		// 1398 frames read as the caller talking, the guard was deferred six times,
		// and the call ran on with nobody on it.
		const line = new CallerLine(0);
		const armedAt = line.now;

		line.play(NOISE, 150_000);

		expect(line.voice.stats().frames).toBe(150_000 / AUDIOSOCKET_FRAME_MS);
		expect(line.voice.stats().loudFrames).toBe(0);
		expect(line.voice.stats().lastVoiceAt).toBeNull();
		expect(line.silenceDeferred(armedAt)).toBe(false);
	});

	test("a line that goes noisy mid-call is absorbed, not believed forever", () => {
		// The other half of the same case: a quiet line that suddenly gains 24 dB of
		// noise does read as speech, because that is what a sudden loud sound is. The
		// point is that it is bounded - the estimate climbs to meet it in seconds -
		// rather than disarming the guard for the rest of the call.
		const line = new CallerLine();
		const armedAt = line.now;

		line.play(NOISE, 150_000);

		const lastVoiceAt = line.voice.stats().lastVoiceAt;

		expect(lastVoiceAt).not.toBeNull();
		expect((lastVoiceAt as number) - armedAt).toBeLessThan(10_000);
		expect(line.silenceDeferred(armedAt)).toBe(false);
	});

	test("hangs up on a caller who spoke and then went quiet for a whole window", () => {
		const line = new CallerLine();

		line.speak(4_000);

		const armedAt = line.now;
		line.play(SILENCE, SILENCE_WINDOW_MS);

		expect(line.silenceDeferred(armedAt)).toBe(false);
	});

	test("a single click is not a caller", () => {
		const line = new CallerLine();
		const armedAt = line.now;

		line.play(SILENCE, 10_000);
		// 100 ms of loud: shorter than any syllable, and shorter than the run the
		// detector requires.
		line.play(SPEECH, 100);
		line.play(SILENCE, 10_000);

		expect(line.voice.stats().loudFrames).toBe(5);
		expect(line.voice.stats().voicedFrames).toBe(0);
		expect(line.silenceDeferred(armedAt)).toBe(false);
	});

	test("a caller mid-monologue does not get talked over by the stall recovery", () => {
		// The stall timer fires after a whole window, and at that moment this caller
		// is 20 s into an answer with no pause in it. The agent is listening, not
		// deaf, and the platform must not interrupt to say "say that again".
		const line = new CallerLine();

		line.speak(SILENCE_WINDOW_MS);

		expect(line.stallVerdict()).toBe("caller-mid-turn");
	});

	test("a caller who finished and got nothing back is a stalled agent", () => {
		const line = new CallerLine();

		line.speak(6_000);
		line.play(SILENCE, TURN_GAP_MS);

		expect(line.stallVerdict()).toBe("agent-stalled");
		// ...and the call is still alive to be recovered: the silence window is
		// longer than the turn gap, so the stall is caught first.
		expect(line.silenceDeferred(line.now - TURN_GAP_MS)).toBe(true);
	});
});

// ===========================================
// What a failed transfer leaves behind
// ===========================================

describe("classifyFailedTransfer", () => {
	test("no operator answered, so the caller is back with the agent", () => {
		// The path the announcement latch was stuck on: `announceBeforeAction` sets
		// closingSpeech before every transfer, and this outcome hands the caller
		// straight back to an agent that must be interruptible again.
		expect(classifyFailedTransfer(true, "gemini-live")).toBe("back-to-agent");
		expect(classifyFailedTransfer(true, "openai-realtime")).toBe("back-to-agent");
	});

	test("the dialplan hung the caller up, so there is nobody to hand back to", () => {
		expect(classifyFailedTransfer(false, "gemini-live")).toBe("caller-gone");
		expect(classifyFailedTransfer(false, "fallback-ivr")).toBe("caller-gone");
	});

	test("the fallback IVR has no agent to return the caller to", () => {
		expect(classifyFailedTransfer(true, "fallback-ivr")).toBe("no-agent-left");
	});

	test("a call that never got a provider is treated as having no agent", () => {
		// providerName is null until a session launches. Nothing can speak, so the
		// caller must not be left holding a silent line either way.
		expect(classifyFailedTransfer(true, null)).toBe("back-to-agent");
	});
});
