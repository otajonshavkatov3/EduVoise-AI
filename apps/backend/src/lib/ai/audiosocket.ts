/**
 * AudioSocket TCP server.
 *
 * Asterisk's AudioSocket application dials *out* to us: the dialplan sets AS_UUID
 * and AS_HOST, then `AudioSocket(${AS_UUID},${AS_HOST})` opens a TCP connection
 * to this listener and streams the channel's audio over it. There is no HTTP, no
 * TLS and no framing library - just a 3 byte header in front of every payload:
 *
 *   +--------+------------------+---------------------------+
 *   | type   | payload length   | payload                   |
 *   | 1 byte | 2 bytes, big-end | `length` bytes            |
 *   +--------+------------------+---------------------------+
 *
 * Types: 0x00 terminate, 0x01 UUID (16 raw bytes), 0x02 DTMF (1 ASCII digit),
 * 0x10 audio (slin: signed linear PCM16, 8 kHz, mono, little-endian),
 * 0xff error (1 byte error code).
 *
 * The UUID Asterisk sends is the value the dialplan put in AS_UUID, and this
 * project sets that to the CRM `calls.id`, so `session.uuid` is directly the call
 * row id - no extra lookup table.
 *
 * Everything here is additive: it opens its own listener on AUDIOSOCKET_PORT and
 * touches no existing route, socket or table.
 */
import { Buffer } from "node:buffer";
import net from "node:net";
import pino from "pino";

// ===========================================
// Wire protocol constants
// ===========================================

/** 1 byte type + 2 bytes big-endian length. */
export const AUDIOSOCKET_HEADER_BYTES = 3;

/** A 16-bit length field caps a single payload at 64 KiB - 1. */
export const AUDIOSOCKET_MAX_PAYLOAD_BYTES = 0xffff;

/** Raw bytes in a type 0x01 payload. */
export const AUDIOSOCKET_UUID_BYTES = 16;

/** Asterisk "slin" is 8 kHz mono PCM16. */
export const AUDIOSOCKET_SAMPLE_RATE = 8000;

/** Packetisation used by Asterisk for slin. */
export const AUDIOSOCKET_FRAME_MS = 20;

/** 8000 Hz * 0.020 s * 2 bytes = 320 bytes of audio per frame. */
export const AUDIOSOCKET_FRAME_BYTES = (AUDIOSOCKET_SAMPLE_RATE / 1000) * AUDIOSOCKET_FRAME_MS * 2;

export const AudioSocketPacketType = {
	TERMINATE: 0x00,
	UUID: 0x01,
	DTMF: 0x02,
	AUDIO: 0x10,
	ERROR: 0xff,
} as const;

export type AudioSocketPacketType =
	(typeof AudioSocketPacketType)[keyof typeof AudioSocketPacketType];

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 9092;

/**
 * 3000 frames = 60 s of audio (~1 MB of 323-byte packets per call).
 *
 * This has to hold ONE WHOLE UTTERANCE, because a speech-to-speech model does not
 * stream in real time: it emits a complete spoken answer in a burst - roughly 7 s
 * of audio arriving in about 2 s - while the pacer can only play 50 frames per
 * second. The previous cap of 150 frames (3 s) therefore threw away everything
 * past the first three seconds of every longer answer: a real call logged
 * framesSent=245 against framesDropped=230, i.e. the agent was cut off mid
 * sentence. The cap exists only to bound memory if the far end stops draining
 * (a caller hanging up mid-playback), so it should be generous, not tight.
 */
const DEFAULT_MAX_QUEUED_FRAMES = 3000;

/**
 * If the pacing clock falls further behind than this, resynchronise to now.
 *
 * Replaying every missed slot would produce exactly the burst this pacer exists
 * to avoid, and 100 ms of skipped audio is far less audible than a clump of
 * frames the far end throws away.
 */
const MAX_PACING_SLIP_MS = 100;

/** Two frames closer together than this count as a burst. */
const PACE_BURST_MS = 5;

/** A gap wider than this is a hole the caller hears as a dropout. */
const PACE_STALL_MS = 40;

const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * One pre-encoded 20 ms slin frame of silence.
 *
 * Sent whenever the model has nothing queued, so the outbound stream never has a
 * hole in it. Built once because it is written up to 50 times a second per call.
 */
const SILENCE_FRAME = encodeAudioSocketPacket(
	AudioSocketPacketType.AUDIO,
	Buffer.alloc(AUDIOSOCKET_FRAME_BYTES)
);

/**
 * Best-effort labels for the 0xff error payload. Asterisk treats the byte as a
 * bit field (hangup / frame forwarding / memory); the raw code is always exposed
 * on the error object so an unknown value is never swallowed.
 */
const AUDIOSOCKET_ERROR_LABELS: Record<number, string> = {
	0: "none",
	1: "hangup",
	2: "frame forwarding failed",
	4: "memory allocation failed",
};

// ===========================================
// Public types
// ===========================================

export interface AudioSocketAddress {
	host: string;
	port: number;
}

export type AudioSocketErrorKind = "server" | "socket" | "protocol" | "frame";

/** Every failure surfaced by this module, tagged with where it came from. */
export class AudioSocketError extends Error {
	readonly kind: AudioSocketErrorKind;
	/** The 0xff payload byte when `kind === "protocol"`, otherwise null. */
	readonly code: number | null;

	constructor(
		kind: AudioSocketErrorKind,
		message: string,
		code: number | null = null,
		cause?: unknown
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AudioSocketError";
		this.kind = kind;
		this.code = code;
	}
}

export interface AudioSocketSessionStats {
	/** Protocol packets received on this connection (all types). */
	packetsReceived: number;
	/** Audio payload bytes received from Asterisk. */
	bytesReceived: number;
	/** Audio payload bytes written to Asterisk. */
	bytesSent: number;
	/** 20 ms frames written to Asterisk. */
	framesSent: number;
	/** 20 ms frames discarded because the outbound backlog was full. */
	framesDropped: number;
	/**
	 * 20 ms frames still queued when the session closed, i.e. agent speech the
	 * caller never heard.
	 *
	 * Non-zero means the channel was cut while the agent was still talking - the
	 * usual cause is hanging up on a fixed timer instead of waiting for the audio
	 * to drain, which clips the goodbye.
	 */
	framesAbandoned: number;
	/** Frames still waiting for a pacer slot. */
	framesQueued: number;
	/** Mean ms between outbound frames. Healthy is ~20. */
	paceMeanGapMs: number;
	/**
	 * Share (0-1) of frames written less than 5 ms after the previous one.
	 *
	 * This is the metric that made the "agent is silent live but audible in the
	 * recording" bug measurable: it sat at 0.26 while the pacer emitted bursts,
	 * because a softphone's jitter buffer discards clumped packets whereas
	 * MixMonitor writes them to disk in order regardless of arrival timing.
	 * Healthy is near 0.
	 */
	paceBurstRatio: number;
	/** Share (0-1) of gaps over 40 ms, which the caller hears as a dropout. */
	paceStallRatio: number;
}

/**
 * One Asterisk channel bridged over one TCP connection.
 *
 * `uuid` is the CRM `calls.id`. `send()` is safe to call with audio of any
 * length - it re-frames into 20 ms packets internally.
 */
export interface AudioSocketSession {
	readonly uuid: string;
	readonly socket: net.Socket;
	readonly remoteAddress: string;
	readonly startedAt: Date;
	readonly isClosed: boolean;

	/**
	 * Queue slin 8 kHz PCM16 for playback.
	 *
	 * Audio is split into 20 ms frames and emitted by the session's own pacer, one
	 * frame every 20 ms, regardless of how fast the model produced it. A partial
	 * trailing frame is held until the rest of the audio arrives, so a frame never
	 * contains a discontinuity.
	 */
	send(slin8k: Buffer): void;

	/** Pad any held partial frame with silence and queue it (end of an utterance). */
	flush(): void;

	/**
	 * Drop everything still queued for playback, for barge-in.
	 *
	 * Essential now that the queue holds a whole utterance: when the caller starts
	 * talking, cancelling the model's response is not enough on its own - up to a
	 * minute of already-generated speech is sitting in this queue and would keep
	 * playing over them. Returns how many 20 ms frames were discarded.
	 */
	discardQueuedAudio(): number;

	/** 20 ms frames still waiting for a pacer slot. */
	queuedFrames(): number;

	/**
	 * Resolve once every queued frame has been written to Asterisk.
	 *
	 * The caller needs this before hanging up on the agent's own goodbye: `say()`
	 * returns as soon as the model is asked to speak, and the audio then takes as
	 * long to pace out as it does to listen to. Resolves `true` if the queue
	 * emptied, `false` on timeout or if the session closed with audio still queued.
	 */
	waitForQueueDrain(timeoutMs: number): Promise<boolean>;

	/** Drop queued audio, tell Asterisk to terminate, and close the connection. */
	hangup(): void;

	stats(): AudioSocketSessionStats;

	/** Register a per-session inbound audio listener. Returns an unsubscribe fn. */
	onAudio(listener: (chunk: Buffer) => void): () => void;
	onDtmf(listener: (digit: string) => void): () => void;
	onError(listener: (error: AudioSocketError) => void): () => void;
	onEnd(listener: () => void): () => void;
}

export interface AudioSocketServerEvents {
	listening: [address: AudioSocketAddress];
	/** A UUID packet arrived: the channel is ready for audio in both directions. */
	session: [session: AudioSocketSession];
	audio: [session: AudioSocketSession, slin8k: Buffer];
	dtmf: [session: AudioSocketSession, digit: string];
	/** `session` is null for listener-level failures that predate any session. */
	error: [error: AudioSocketError, session: AudioSocketSession | null];
	end: [session: AudioSocketSession];
	close: [];
}

export interface AudioSocketLogger {
	debug(payload: Record<string, unknown>, message: string): void;
	info(payload: Record<string, unknown>, message: string): void;
	warn(payload: Record<string, unknown>, message: string): void;
	error(payload: Record<string, unknown>, message: string): void;
}

export interface AudioSocketServerOptions {
	/** Defaults to AUDIOSOCKET_HOST, then 0.0.0.0. */
	host?: string;
	/** Defaults to AUDIOSOCKET_PORT, then 9092. Use 0 for an ephemeral port. */
	port?: number;
	/** Outbound backlog cap per session, in 20 ms frames. Default 150 (3 s). */
	maxQueuedFrames?: number;
	/** Destroy a connection that has been silent this long. 0 disables. Default 0. */
	idleTimeoutMs?: number;
	/** `null` silences logging entirely (used by tests). */
	logger?: AudioSocketLogger | null;
}

const noop = (): void => undefined;

/** A logger that discards everything. */
export const silentAudioSocketLogger: AudioSocketLogger = {
	debug: noop,
	info: noop,
	warn: noop,
	error: noop,
};

function createDefaultLogger(): AudioSocketLogger {
	const instance = pino({
		level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
	}).child({ module: "audiosocket" });

	return {
		debug: (payload, message) => instance.debug(payload, message),
		info: (payload, message) => instance.info(payload, message),
		warn: (payload, message) => instance.warn(payload, message),
		error: (payload, message) => instance.error(payload, message),
	};
}

// ===========================================
// Helpers
// ===========================================

/** 16 raw bytes -> canonical dashed lowercase UUID. */
export function formatAudioSocketUuid(bytes: Buffer): string {
	const hex = bytes.toString("hex");

	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20, 32),
	].join("-");
}

/** Build one AudioSocket packet: type, big-endian length, payload. */
export function encodeAudioSocketPacket(type: number, payload: Buffer = EMPTY_BUFFER): Buffer {
	const packet = Buffer.allocUnsafe(AUDIOSOCKET_HEADER_BYTES + payload.length);

	packet[0] = type & 0xff;
	packet.writeUInt16BE(payload.length, 1);
	payload.copy(packet, AUDIOSOCKET_HEADER_BYTES);

	return packet;
}

function describeAudioSocketError(code: number): string {
	return AUDIOSOCKET_ERROR_LABELS[code] ?? `unknown (0x${code.toString(16).padStart(2, "0")})`;
}

function resolvePort(explicit: number | undefined): number {
	const candidate = explicit ?? Number(process.env.AUDIOSOCKET_PORT);

	if (Number.isInteger(candidate) && candidate >= 0 && candidate <= 65535) {
		return candidate;
	}

	return DEFAULT_PORT;
}

/** Rounded quotient, 0 when there is nothing to divide by. */
function ratio(total: number, count: number, decimals: number): number {
	if (count === 0) {
		return 0;
	}

	const factor = 10 ** decimals;

	return Math.round((total / count) * factor) / factor;
}

// ===========================================
// Caller voice activity
// ===========================================

/**
 * RMS of one slin buffer, in int16 units (0 .. 32767).
 *
 * A trailing odd byte cannot happen on the AudioSocket wire (payloads are whole
 * samples) but is ignored rather than trusted, so a malformed frame measures low
 * instead of throwing inside an audio callback.
 */
export function slinRms(slin8k: Buffer): number {
	const samples = Math.floor(slin8k.length / 2);

	if (samples === 0) {
		return 0;
	}

	let sum = 0;

	for (let i = 0; i < samples; i++) {
		const sample = slin8k.readInt16LE(i * 2);
		sum += sample * sample;
	}

	return Math.sqrt(sum / samples);
}

/**
 * WHERE THE "IS SOMEBODY TALKING?" SIGNAL COMES FROM, AND WHY IT LIVES HERE.
 *
 * The orchestrator ends a call after a configured stretch with nothing happening
 * on it. Deciding that needs one fact no provider reliably supplies: whether a
 * person is making sound RIGHT NOW, as opposed to having just finished a sentence.
 *
 * Gemini Live cannot supply it. Measured against gemini-3.1-flash-live-preview by
 * replaying the audio of call 6c5a2006, which was cut off mid-conversation:
 * fifteen seconds of continuous Uzbek speech produced exactly zero server messages
 * - no inputTranscription, no activity marker, nothing but the periodic
 * sessionResumptionUpdate - and then ONE inputTranscription carrying the whole
 * utterance, two seconds after the caller stopped. Input transcription on that
 * model is a turn-BOUNDARY event, so a caller who talks for longer than the
 * silence budget without pausing produces no activity at all. That call was
 * 31.6 s of caller audio, one agent turn, no caller transcript, hung up.
 *
 * Frame arrival cannot supply it either: Asterisk streams 50 frames a second down
 * the AudioSocket whether or not anybody is speaking, so the level of those frames
 * is the only honest evidence. This file is where the frames are, and where the
 * 20 ms frame contract is defined - which is what makes "a run of frames" a
 * duration rather than however much audio Asterisk handed over in one write.
 *
 * So there is exactly ONE caller-voice detector on the platform and it is this
 * one. Providers still forward whatever their own server tells them (OpenAI's
 * input_audio_buffer.speech_started, Gemini's end-of-turn transcription); those
 * are true and welcome, and nothing depends on them.
 */

/**
 * How loud a 20 ms frame must be to be speech at all, and how far above THIS
 * line's own noise it must sit. Both gates apply, because either alone is wrong on
 * real calls from this deployment:
 *
 *   absolute only  Call edd90885 carried 150 s of -38 dBFS band-limited noise with
 *                  no speech anywhere in it. A fixed -45 dBFS gate called every one
 *                  of that call's 1398 frames loud, so a line with nobody on it
 *                  read as a permanently talking caller and the guard was deferred
 *                  six times. Replaying its speech-free stretches through these two
 *                  gates instead: 0 of 3250 frames.
 *   relative only  The quiet hiss of a dead line becomes "talking" the moment it
 *                  wobbles, which is the same failure by the other route.
 *
 * -50 dBFS: call 6c5a2006's line measured -62 dBFS while quiet and -16 dBFS while
 * the caller spoke, so this sits 12 dB clear of the line and ~34 dB under speech.
 *
 * 8 dB over the line rather than the obvious 12: swept over six variants and eight
 * cases built from that call's own audio, mixed under white noise from -45 to
 * -25 dBFS. At 12 dB a caller only 7 dB above their own line went undetected for
 * the whole 20 s and would still have been hung up on. At 8 dB the longest gap on
 * that line is 9 s - and on the unmixed recording of the real call, 2.0 s - while
 * steady noise at every level tested produces no detections at all.
 */
export const CALLER_VOICE_FLOOR_RMS = 32_768 * 10 ** (-50 / 20);
export const CALLER_VOICE_OVER_NOISE = 2.5;

/**
 * The quietest the noise estimate is allowed to get.
 *
 * Chosen so the two gates meet exactly: at this level "8 dB above the line" and
 * "above -50 dBFS" are the same test, and below it the absolute gate is the
 * stricter of the two anyway. Without a clamp a digitally silent stretch - call
 * 002959b3 carried 13 s of literal zeroes - drives the estimate to zero, which
 * makes the relative gate meaningless and the logged figure nonsense (-3164 dBFS
 * was measured).
 */
export const CALLER_VOICE_MIN_NOISE_RMS = CALLER_VOICE_FLOOR_RMS / CALLER_VOICE_OVER_NOISE;

/**
 * How fast the noise estimate follows the line down, and back up.
 *
 * Asymmetric on purpose, per 20 ms frame: 80 ms to settle onto a quieter line, ten
 * seconds to accept a louder one. Speech rides over the slow rise because it is
 * full of gaps, and every gap drags the estimate back to the line within a tenth
 * of a second; a loud sound with NO gaps in it is absorbed inside five seconds, so
 * a radio left by an abandoned handset cannot hold a call open indefinitely.
 */
export const CALLER_VOICE_NOISE_FALL = 0.25;
export const CALLER_VOICE_NOISE_RISE = 0.002;

/**
 * How many loud frames make a speech run: 8 frames = 160 ms of energy.
 *
 * Long enough that a keypad click, a line pop or a single burst of packet loss
 * cannot fake it; short enough to be inside the first syllable the caller says.
 */
export const CALLER_VOICE_RUN_FRAMES = 8;

/**
 * How many quiet frames end a run: 6 frames = 120 ms.
 *
 * Speech is not continuously loud - the closure of a stop consonant is 50-100 ms
 * of near-silence in the middle of a word. Resetting the run on the first quiet
 * frame would mean a caller speaking normally never accumulated a run at all.
 */
export const CALLER_VOICE_GAP_FRAMES = 6;

export interface CallerVoiceActivityStats {
	/** Audio frames measured on this call. Zero means nothing ever arrived. */
	frames: number;
	/** Frames that cleared both gates. */
	loudFrames: number;
	/** Loud frames that were part of a qualifying speech run. */
	voicedFrames: number;
	/** The same, as a duration: how long a voice was actually on this line. */
	voicedMs: number;
	/** Loudest 20 ms frame seen, in int16 RMS. */
	peakRms: number;
	/**
	 * The line's own noise as the detector currently estimates it, in dBFS, or null
	 * before any audio has arrived. Logged after the call because it is the other
	 * half of "was anybody there?": a quiet line with no voice on it is an empty
	 * room, a loud one with no voice on it is a bad connection.
	 */
	noiseFloorDbfs: number | null;
	/** Epoch ms of the last frame of any kind, or null. */
	lastFrameAt: number | null;
	/**
	 * Epoch ms of the last loud frame inside a speech run, or null when the caller
	 * has never been heard.
	 */
	lastVoiceAt: number | null;
}

/**
 * Answers one question about the caller's own channel: is a person talking?
 *
 * This exists because "the caller is silent" and "the model stopped
 * transcribing" are completely different faults that used to look identical to
 * the orchestrator - both simply produced no speech signal, and both ended the
 * call. See the note above for why the evidence has to be the audio itself.
 *
 * The rule is energy against an ADAPTIVE estimate of the line: down fast, up
 * slowly. Speech survives the slow rise because it is full of gaps, while
 * anything loud and unending is absorbed into the estimate and stops counting.
 * Measured on the recording of the cut-off call: 20.6 s of near-continuous speech,
 * longest gap between detections 1.1 s. Measured on call edd90885, 150 s of
 * -38 dBFS noise with nobody speaking: nothing at all.
 *
 * Known and accepted: an echoing handset feeds the agent's own voice back and this
 * counts it as the caller. That keeps a call alive that would otherwise be cut,
 * which is the safer way to be wrong, and the max-duration guard still ends a call
 * nobody is on.
 */
export class CallerVoiceActivity {
	private readonly floorRms: number;
	private readonly overNoise: number;
	private readonly minNoiseRms: number;
	private readonly runFrames: number;
	private readonly gapFrames: number;

	/** This line's own noise, in int16 RMS. Zero until the first frame seeds it. */
	private noiseRms = 0;
	private loudRun = 0;
	private quietRun = 0;

	private frameCount = 0;
	private loudFrameCount = 0;
	private voicedFrameCount = 0;
	private peak = 0;
	private lastFrame: number | null = null;
	private lastVoice: number | null = null;

	/** Audio bytes that do not fill a whole 20 ms frame yet. */
	private tail: Buffer = EMPTY_BUFFER;

	constructor(
		options: {
			floorRms?: number;
			overNoise?: number;
			runFrames?: number;
			gapFrames?: number;
		} = {}
	) {
		this.floorRms = options.floorRms ?? CALLER_VOICE_FLOOR_RMS;
		this.overNoise = options.overNoise ?? CALLER_VOICE_OVER_NOISE;
		this.minNoiseRms = this.floorRms / this.overNoise;
		this.runFrames = options.runFrames ?? CALLER_VOICE_RUN_FRAMES;
		this.gapFrames = options.gapFrames ?? CALLER_VOICE_GAP_FRAMES;
	}

	/**
	 * Feed inbound caller audio. Any length is accepted and re-framed to 20 ms, so
	 * the run lengths above mean the same thing whatever Asterisk packetises at.
	 *
	 * Returns true when this chunk carried at least one frame of qualifying speech,
	 * which is the signal a caller of this class acts on - measuring the audio and
	 * reporting the caller are then one pass, not two.
	 *
	 * `now` is injectable so tests can drive the clock instead of sleeping.
	 */
	push(slin8k: Buffer, now: number = Date.now()): boolean {
		if (slin8k.length === 0) {
			return false;
		}

		this.lastFrame = now;

		const source = this.tail.length === 0 ? slin8k : Buffer.concat([this.tail, slin8k]);
		let offset = 0;
		let voiced = false;

		while (source.length - offset >= AUDIOSOCKET_FRAME_BYTES) {
			// Deliberately not short-circuiting: every frame has to reach `measure`,
			// because the noise estimate is only right if it sees the whole line.
			voiced =
				this.measure(source.subarray(offset, offset + AUDIOSOCKET_FRAME_BYTES), now) || voiced;
			offset += AUDIOSOCKET_FRAME_BYTES;
		}

		// Copy the remainder: `source` may be a view onto a caller-owned buffer.
		this.tail = offset === source.length ? EMPTY_BUFFER : Buffer.from(source.subarray(offset));

		return voiced;
	}

	/** ms since the last qualifying speech run, or null if there has never been one. */
	msSinceVoice(now: number = Date.now()): number | null {
		return this.lastVoice === null ? null : Math.max(0, now - this.lastVoice);
	}

	/** ms since any audio at all arrived, or null if none ever has. */
	msSinceFrame(now: number = Date.now()): number | null {
		return this.lastFrame === null ? null : Math.max(0, now - this.lastFrame);
	}

	/** True when the caller was audibly speaking within the last `windowMs`. */
	spokeWithin(windowMs: number, now: number = Date.now()): boolean {
		const since = this.msSinceVoice(now);

		return since !== null && since <= windowMs;
	}

	stats(): CallerVoiceActivityStats {
		return {
			frames: this.frameCount,
			loudFrames: this.loudFrameCount,
			voicedFrames: this.voicedFrameCount,
			voicedMs: this.voicedFrameCount * AUDIOSOCKET_FRAME_MS,
			peakRms: Math.round(this.peak),
			noiseFloorDbfs:
				this.noiseRms > 0 ? Number((20 * Math.log10(this.noiseRms / 32_768)).toFixed(1)) : null,
			lastFrameAt: this.lastFrame,
			lastVoiceAt: this.lastVoice,
		};
	}

	/** @returns true when this frame completed or extended a qualifying speech run. */
	private measure(frame: Buffer, now: number): boolean {
		const rms = slinRms(frame);

		this.frameCount++;

		if (rms > this.peak) {
			this.peak = rms;
		}

		if (this.noiseRms === 0) {
			// Seeded from the first frame of the call, which is the line at rest. A
			// caller already talking when the socket attaches seeds it high instead,
			// and the fast fall brings it back at their first pause.
			this.noiseRms = Math.max(this.minNoiseRms, rms);
		}

		const loud = rms > this.floorRms && rms > this.noiseRms * this.overNoise;

		// Moved by every frame, loud ones included: a line that never goes quiet has
		// to be allowed to become the estimate, or a tone would hold a call open.
		const follow = rms < this.noiseRms ? CALLER_VOICE_NOISE_FALL : CALLER_VOICE_NOISE_RISE;

		this.noiseRms = Math.max(this.minNoiseRms, this.noiseRms + (rms - this.noiseRms) * follow);

		if (!loud) {
			this.quietRun++;

			// A short gap keeps the RUN alive but is not itself speech: `lastVoice`
			// only ever means "a frame with speech energy in it arrived at this
			// time", so a caller who stops talking is timed from their last real
			// sound rather than from the end of the tolerance window.
			if (this.quietRun >= this.gapFrames) {
				this.loudRun = 0;
			}

			return false;
		}

		this.loudFrameCount++;
		this.quietRun = 0;
		this.loudRun++;

		if (this.loudRun < this.runFrames) {
			return false;
		}

		this.voicedFrameCount++;
		this.lastVoice = now;

		return true;
	}
}

// ===========================================
// Session
// ===========================================

type Listener<A extends unknown[]> = (...args: A) => void;
type OpaqueListener = Listener<never[]>;

/** Fan out to a listener set without letting one throwing listener kill the loop. */
function callListeners<A extends unknown[]>(
	listeners: Set<OpaqueListener> | undefined,
	logger: AudioSocketLogger,
	label: string,
	args: A
): void {
	if (listeners === undefined || listeners.size === 0) {
		return;
	}

	for (const listener of [...listeners]) {
		try {
			(listener as unknown as Listener<A>)(...args);
		} catch (cause) {
			logger.error({ label, err: cause }, "audiosocket listener threw");
		}
	}
}

class Session implements AudioSocketSession {
	readonly uuid: string;
	readonly socket: net.Socket;
	readonly remoteAddress: string;
	readonly startedAt = new Date();

	private readonly logger: AudioSocketLogger;
	private readonly maxQueuedFrames: number;

	/** Self-correcting 20 ms pacer. Null while stopped. */
	private paceTimer: ReturnType<typeof setTimeout> | null = null;
	/** Absolute time the next frame is due, so drift cannot accumulate. */
	private nextSlotAt = 0;

	/** Complete wire frames (header + 320 byte payload), oldest first. */
	private readonly queue: Buffer[] = [];
	/** Audio bytes that do not fill a whole 20 ms frame yet. */
	private tail: Buffer = EMPTY_BUFFER;
	private waitingForSocketDrain = false;
	private closed = false;

	private packetsReceived = 0;
	private bytesReceived = 0;
	private bytesSent = 0;
	private framesSent = 0;
	private framesDropped = 0;
	private framesAbandoned = 0;

	/** Pacing health, so a regression back to bursty writes shows up in the logs. */
	private lastEmitAt = 0;
	private paceGaps = 0;
	private paceGapSumMs = 0;
	private paceBursts = 0;
	private paceStalls = 0;

	/** Callbacks waiting for the outbound queue to empty. */
	private readonly drainWaiters = new Set<(drained: boolean) => void>();

	private readonly audioListeners = new Set<OpaqueListener>();
	private readonly dtmfListeners = new Set<OpaqueListener>();
	private readonly errorListeners = new Set<OpaqueListener>();
	private readonly endListeners = new Set<OpaqueListener>();

	constructor(
		uuid: string,
		socket: net.Socket,
		logger: AudioSocketLogger,
		maxQueuedFrames: number
	) {
		this.uuid = uuid;
		this.socket = socket;
		this.remoteAddress = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
		this.logger = logger;
		this.maxQueuedFrames = maxQueuedFrames;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	send(slin8k: Buffer): void {
		if (this.closed || slin8k.length === 0) {
			return;
		}

		const source = this.tail.length === 0 ? slin8k : Buffer.concat([this.tail, slin8k]);
		let offset = 0;

		while (source.length - offset >= AUDIOSOCKET_FRAME_BYTES) {
			this.enqueueFrame(source.subarray(offset, offset + AUDIOSOCKET_FRAME_BYTES));
			offset += AUDIOSOCKET_FRAME_BYTES;
		}

		// Copy the remainder: `source` may be a view onto a caller-owned buffer.
		this.tail = offset === source.length ? EMPTY_BUFFER : Buffer.from(source.subarray(offset));
	}

	flush(): void {
		if (this.closed || this.tail.length === 0) {
			return;
		}

		const padded = Buffer.alloc(AUDIOSOCKET_FRAME_BYTES);
		this.tail.copy(padded);
		this.tail = EMPTY_BUFFER;

		this.enqueueFrame(padded);
	}

	discardQueuedAudio(): number {
		const dropped = this.queue.length;

		this.queue.length = 0;
		// The held partial frame belongs to the cancelled utterance too; keeping it
		// would splice a fragment of the interrupted sentence onto the next answer.
		this.tail = EMPTY_BUFFER;
		// Anyone waiting for this audio to finish is waiting for audio that will now
		// never play, so release them rather than let them sit until their timeout.
		this.settleDrainWaiters(false);

		return dropped;
	}

	queuedFrames(): number {
		return this.queue.length;
	}

	waitForQueueDrain(timeoutMs: number): Promise<boolean> {
		if (this.closed) {
			return Promise.resolve(false);
		}

		if (this.queue.length === 0) {
			return Promise.resolve(true);
		}

		return new Promise((resolve) => {
			const waiter = (drained: boolean): void => {
				clearTimeout(timer);
				this.drainWaiters.delete(waiter);
				resolve(drained);
			};

			const timer = setTimeout(() => {
				this.drainWaiters.delete(waiter);
				resolve(false);
			}, timeoutMs);

			// Never hold the process open on a wait that is only about audio timing.
			timer.unref?.();

			this.drainWaiters.add(waiter);
		});
	}

	hangup(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.stopPacing();
		this.framesAbandoned += this.queue.length;
		this.queue.length = 0;
		this.tail = EMPTY_BUFFER;
		this.settleDrainWaiters(false);

		if (this.socket.writable) {
			this.socket.write(encodeAudioSocketPacket(AudioSocketPacketType.TERMINATE));
			this.socket.end();
		} else {
			this.socket.destroy();
		}
	}

	stats(): AudioSocketSessionStats {
		return {
			packetsReceived: this.packetsReceived,
			bytesReceived: this.bytesReceived,
			bytesSent: this.bytesSent,
			framesSent: this.framesSent,
			framesDropped: this.framesDropped,
			framesAbandoned: this.framesAbandoned,
			framesQueued: this.queue.length,
			paceMeanGapMs: ratio(this.paceGapSumMs, this.paceGaps, 1),
			paceBurstRatio: ratio(this.paceBursts, this.paceGaps, 3),
			paceStallRatio: ratio(this.paceStalls, this.paceGaps, 3),
		};
	}

	onAudio(listener: (chunk: Buffer) => void): () => void {
		return this.register(this.audioListeners, listener as unknown as OpaqueListener);
	}

	onDtmf(listener: (digit: string) => void): () => void {
		return this.register(this.dtmfListeners, listener as unknown as OpaqueListener);
	}

	onError(listener: (error: AudioSocketError) => void): () => void {
		return this.register(this.errorListeners, listener as unknown as OpaqueListener);
	}

	onEnd(listener: () => void): () => void {
		return this.register(this.endListeners, listener as unknown as OpaqueListener);
	}

	// ---- internal, driven by AudioSocketServer ----

	countPacket(): void {
		this.packetsReceived++;
	}

	deliverAudio(chunk: Buffer): void {
		this.bytesReceived += chunk.length;
		callListeners(this.audioListeners, this.logger, "audio", [chunk]);
	}

	/**
	 * Outbound pacing.
	 *
	 * Asterisk expects the server to stream audio at it proactively; it does NOT
	 * hand out one inbound frame per outbound frame. That was measured the hard
	 * way: an earlier attempt emitted a frame only in reply to an inbound frame,
	 * and Asterisk then delivered nothing beyond the UUID packet
	 * (packetsReceived=1, bytesReceived=0) while 345 frames of model audio were
	 * dropped. So the clock has to be ours.
	 *
	 * The original bug was not the timer, it was BURSTING. The old pacer allowed up
	 * to 3 frames per tick to "catch up" after a late timer, and Bun/Node timers on
	 * Windows fire at ~15.6 ms granularity. Measured on a real call: 26% of
	 * outbound RTP packets left less than 5 ms apart, with gaps up to 52 ms. The
	 * caller's jitter buffer discarded those clumps, so the live call was silent -
	 * while MixMonitor still recorded flawless audio, because it writes frames in
	 * order and ignores arrival time. That is exactly the reported symptom.
	 *
	 * This version therefore:
	 *   - emits EXACTLY ONE frame per tick, never a catch-up burst;
	 *   - schedules the next tick from an absolute slot time, so a late timer does
	 *     not push the whole stream later and later;
	 *   - sends silence when the model has nothing queued, keeping one continuous
	 *     20 ms stream so the far end's jitter buffer stays primed.
	 */
	startPacing(): void {
		if (this.paceTimer !== null || this.closed) {
			return;
		}

		this.nextSlotAt = Date.now() + AUDIOSOCKET_FRAME_MS;
		this.scheduleNextSlot();
	}

	stopPacing(): void {
		if (this.paceTimer === null) {
			return;
		}

		clearTimeout(this.paceTimer);
		this.paceTimer = null;
	}

	private scheduleNextSlot(): void {
		if (this.closed) {
			return;
		}

		// Absolute scheduling: the delay is measured to the next slot, not fixed at
		// 20 ms, so drift cannot accumulate across a long call.
		const delay = Math.max(0, this.nextSlotAt - Date.now());

		this.paceTimer = setTimeout(() => {
			this.paceTimer = null;
			this.emitOneFrame();

			// If the clock fell far behind (a GC pause, a busy event loop), resync to
			// now instead of trying to replay every missed slot as a burst.
			const now = Date.now();
			this.nextSlotAt =
				now - this.nextSlotAt > MAX_PACING_SLIP_MS
					? now + AUDIOSOCKET_FRAME_MS
					: this.nextSlotAt + AUDIOSOCKET_FRAME_MS;

			this.scheduleNextSlot();
		}, delay);
	}

	/** Exactly one 20 ms frame: queued model audio if there is any, else silence. */
	private emitOneFrame(): void {
		if (this.closed || !this.socket.writable) {
			return;
		}

		// Socket backpressure: skip this slot rather than grow the kernel buffer.
		// One missed 20 ms slot is inaudible; an unbounded backlog is not.
		if (this.waitingForSocketDrain) {
			return;
		}

		const queued = this.queue.shift();
		const frame = queued ?? SILENCE_FRAME;
		const accepted = this.socket.write(frame);

		if (queued !== undefined) {
			this.framesSent++;
			this.bytesSent += frame.length - AUDIOSOCKET_HEADER_BYTES;

			// That was the last of the utterance: release anyone waiting to hang up
			// until the agent had finished speaking.
			if (this.queue.length === 0) {
				this.settleDrainWaiters(true);
			}
		}

		// Measure the gap on every write, silence included: the stream's timing is
		// what the far end's jitter buffer judges, and it cannot tell the two apart.
		const now = Date.now();

		if (this.lastEmitAt !== 0) {
			const gap = now - this.lastEmitAt;

			this.paceGaps++;
			this.paceGapSumMs += gap;

			if (gap < PACE_BURST_MS) {
				this.paceBursts++;
			} else if (gap > PACE_STALL_MS) {
				this.paceStalls++;
			}
		}

		this.lastEmitAt = now;

		if (!accepted) {
			this.waitingForSocketDrain = true;
		}
	}

	deliverDtmf(digit: string): void {
		callListeners(this.dtmfListeners, this.logger, "dtmf", [digit]);
	}

	deliverError(error: AudioSocketError): void {
		callListeners(this.errorListeners, this.logger, "error", [error]);
	}

	deliverEnd(): void {
		callListeners(this.endListeners, this.logger, "end", []);
	}

	markClosed(): void {
		this.closed = true;
		this.stopPacing();
		this.framesAbandoned += this.queue.length;
		this.queue.length = 0;
		this.tail = EMPTY_BUFFER;
		this.settleDrainWaiters(false);
	}

	releaseSocketBackpressure(): void {
		this.waitingForSocketDrain = false;
	}

	/** Release every drain waiter exactly once. */
	private settleDrainWaiters(drained: boolean): void {
		if (this.drainWaiters.size === 0) {
			return;
		}

		// Copy first: each waiter removes itself from the set as it settles.
		for (const waiter of [...this.drainWaiters]) {
			waiter(drained);
		}

		this.drainWaiters.clear();
	}

	private register(listeners: Set<OpaqueListener>, listener: OpaqueListener): () => void {
		listeners.add(listener);

		return () => {
			listeners.delete(listener);
		};
	}

	private enqueueFrame(payload: Buffer): void {
		this.queue.push(encodeAudioSocketPacket(AudioSocketPacketType.AUDIO, payload));

		while (this.queue.length > this.maxQueuedFrames) {
			this.queue.shift();
			this.framesDropped++;
		}
	}
}

// ===========================================
// Server
// ===========================================

interface Connection {
	socket: net.Socket;
	/** Bytes received but not yet forming a complete packet. */
	buffer: Buffer;
	session: Session | null;
	/** Set once the socket is gone so parsing and draining stop. */
	closed: boolean;
	/** Guards the single 'end' emission per connection. */
	ended: boolean;
}

export class AudioSocketServer {
	private readonly host: string;
	private readonly configuredPort: number;
	private readonly maxQueuedFrames: number;
	private readonly idleTimeoutMs: number;
	private readonly logger: AudioSocketLogger;

	private readonly server: net.Server;
	private readonly connections = new Set<Connection>();
	private readonly listeners = new Map<keyof AudioSocketServerEvents, Set<OpaqueListener>>();

	private listening = false;

	constructor(options: AudioSocketServerOptions = {}) {
		this.host = options.host ?? process.env.AUDIOSOCKET_HOST ?? DEFAULT_HOST;
		this.configuredPort = resolvePort(options.port);
		this.maxQueuedFrames = Math.max(1, options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES);
		this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 0);

		if (options.logger === null) {
			this.logger = silentAudioSocketLogger;
		} else {
			this.logger = options.logger ?? createDefaultLogger();
		}

		this.server = net.createServer((socket) => {
			this.acceptConnection(socket);
		});

		this.server.on("error", (cause: Error) => {
			this.emit(
				"error",
				new AudioSocketError("server", `AudioSocket listener error: ${cause.message}`, null, cause),
				null
			);
		});
	}

	// ---- events ----

	on<K extends keyof AudioSocketServerEvents>(
		event: K,
		listener: Listener<AudioSocketServerEvents[K]>
	): () => void {
		let set = this.listeners.get(event);

		if (set === undefined) {
			set = new Set();
			this.listeners.set(event, set);
		}

		const opaque = listener as unknown as OpaqueListener;
		set.add(opaque);

		return () => {
			set?.delete(opaque);
		};
	}

	off<K extends keyof AudioSocketServerEvents>(
		event: K,
		listener: Listener<AudioSocketServerEvents[K]>
	): void {
		this.listeners.get(event)?.delete(listener as unknown as OpaqueListener);
	}

	once<K extends keyof AudioSocketServerEvents>(
		event: K,
		listener: Listener<AudioSocketServerEvents[K]>
	): () => void {
		const unsubscribe = this.on(event, (...args: AudioSocketServerEvents[K]) => {
			unsubscribe();
			listener(...args);
		});

		return unsubscribe;
	}

	private emit<K extends keyof AudioSocketServerEvents>(
		event: K,
		...args: AudioSocketServerEvents[K]
	): void {
		callListeners(this.listeners.get(event), this.logger, event, args);
	}

	// ---- lifecycle ----

	/** The address actually bound, or null before start()/after stop(). */
	address(): AudioSocketAddress | null {
		const address = this.server.address();

		if (address === null || typeof address === "string") {
			return null;
		}

		return { host: address.address, port: address.port };
	}

	/** Bound port, or null before start(). Useful when port 0 was requested. */
	get boundPort(): number | null {
		return this.address()?.port ?? null;
	}

	get isListening(): boolean {
		return this.listening;
	}

	get sessionCount(): number {
		let count = 0;

		for (const connection of this.connections) {
			if (connection.session !== null && !connection.session.isClosed) {
				count++;
			}
		}

		return count;
	}

	/** Look up a live session by CRM call id. */
	getSession(uuid: string): AudioSocketSession | null {
		for (const connection of this.connections) {
			if (connection.session !== null && connection.session.uuid === uuid) {
				return connection.session;
			}
		}

		return null;
	}

	async start(): Promise<AudioSocketAddress> {
		if (this.listening) {
			const current = this.address();

			if (current !== null) {
				return current;
			}
		}

		return await new Promise<AudioSocketAddress>((resolve, reject) => {
			const onError = (cause: Error) => {
				this.server.off("listening", onListening);
				reject(
					new AudioSocketError(
						"server",
						`AudioSocket listener failed to bind ${this.host}:${this.configuredPort}: ${cause.message}`,
						null,
						cause
					)
				);
			};

			const onListening = () => {
				this.server.off("error", onError);
				this.listening = true;

				const address = this.address() ?? { host: this.host, port: this.configuredPort };
				this.logger.info({ ...address }, "AudioSocket server listening");
				this.emit("listening", address);
				resolve(address);
			};

			this.server.once("error", onError);
			this.server.once("listening", onListening);
			this.server.listen(this.configuredPort, this.host);
		});
	}

	/** Close every connection and the listener. Safe to call more than once. */
	async stop(): Promise<void> {
		for (const connection of [...this.connections]) {
			connection.closed = true;
			connection.socket.destroy();
		}

		this.connections.clear();

		if (!this.listening) {
			return;
		}

		await new Promise<void>((resolve) => {
			this.server.close(() => {
				resolve();
			});
		});

		this.listening = false;
		this.logger.info({}, "AudioSocket server stopped");
		this.emit("close");
	}

	// ---- connections ----

	private acceptConnection(socket: net.Socket): void {
		// Audio frames are 323 bytes every 20 ms; Nagle would batch them into
		// bursts and add latency for nothing.
		socket.setNoDelay(true);

		const connection: Connection = {
			socket,
			buffer: EMPTY_BUFFER,
			session: null,
			closed: false,
			ended: false,
		};

		this.connections.add(connection);
		this.logger.debug(
			{ remote: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}` },
			"AudioSocket connection accepted"
		);

		if (this.idleTimeoutMs > 0) {
			socket.setTimeout(this.idleTimeoutMs, () => {
				this.logger.warn(
					{ uuid: connection.session?.uuid ?? null, idleTimeoutMs: this.idleTimeoutMs },
					"AudioSocket connection idle, destroying"
				);
				socket.destroy();
			});
		}

		socket.on("data", (chunk: Buffer) => {
			this.consume(connection, chunk);
		});

		socket.on("drain", () => {
			// Backpressure cleared. Nothing to restart: outbound frames are emitted
			// from the inbound frame handler, so the next packet from Asterisk
			// resumes playback on its own clock.
			connection.session?.releaseSocketBackpressure();
		});

		socket.on("error", (cause: Error) => {
			const error = new AudioSocketError(
				"socket",
				`AudioSocket connection error: ${cause.message}`,
				null,
				cause
			);

			connection.session?.deliverError(error);
			this.emit("error", error, connection.session);
		});

		socket.on("close", () => {
			this.closeConnection(connection);
		});
	}

	private closeConnection(connection: Connection): void {
		connection.closed = true;
		connection.buffer = EMPTY_BUFFER;
		this.connections.delete(connection);

		const session = connection.session;

		if (session === null || connection.ended) {
			return;
		}

		connection.ended = true;
		session.markClosed();
		// Info, not debug: this one line per call is how an audio fault is diagnosed
		// after the fact. paceBurstRatio and framesDropped in particular are the
		// difference between "the agent was inaudible" and "the agent said nothing".
		this.logger.info({ uuid: session.uuid, ...session.stats() }, "AudioSocket session ended");
		session.deliverEnd();
		this.emit("end", session);
	}

	/**
	 * Feed raw TCP bytes through the framer.
	 *
	 * The only hard requirement of this function: TCP gives no message
	 * boundaries. A single 3 byte header can arrive as three separate reads, and
	 * five packets can arrive as one read. So bytes accumulate in
	 * `connection.buffer` and we loop while a *complete* packet is present,
	 * keeping whatever is left over for the next read.
	 */
	private consume(connection: Connection, chunk: Buffer): void {
		if (connection.closed) {
			return;
		}

		const buffer =
			connection.buffer.length === 0 ? chunk : Buffer.concat([connection.buffer, chunk]);
		let offset = 0;

		while (buffer.length - offset >= AUDIOSOCKET_HEADER_BYTES) {
			const type = buffer[offset];
			const payloadLength = buffer.readUInt16BE(offset + 1);
			const packetEnd = offset + AUDIOSOCKET_HEADER_BYTES + payloadLength;

			// Header is complete but the payload is not: wait for more bytes.
			if (packetEnd > buffer.length) {
				break;
			}

			const payload =
				payloadLength === 0
					? EMPTY_BUFFER
					: buffer.subarray(offset + AUDIOSOCKET_HEADER_BYTES, packetEnd);

			offset = packetEnd;
			this.handlePacket(connection, type, payload);

			// A terminate packet (or a listener calling hangup()) closed the socket -
			// anything still in the buffer belongs to a connection that no longer
			// exists.
			if (connection.closed) {
				offset = buffer.length;
				break;
			}
		}

		if (offset === 0) {
			// Nothing consumed: keep the bytes, but own them. Retaining the runtime's
			// read buffer across events would be a bet on its allocation strategy.
			connection.buffer = buffer === chunk ? Buffer.from(chunk) : buffer;
			return;
		}

		// Copy the remainder so the (possibly large) accumulated buffer can be
		// garbage collected instead of being retained by a small view.
		connection.buffer =
			offset >= buffer.length ? EMPTY_BUFFER : Buffer.from(buffer.subarray(offset));
	}

	private handlePacket(connection: Connection, type: number, payload: Buffer): void {
		connection.session?.countPacket();

		switch (type) {
			case AudioSocketPacketType.UUID:
				this.handleUuidPacket(connection, payload);
				return;

			case AudioSocketPacketType.AUDIO:
				this.handleAudioPacket(connection, payload);
				return;

			case AudioSocketPacketType.DTMF:
				this.handleDtmfPacket(connection, payload);
				return;

			case AudioSocketPacketType.TERMINATE:
				this.logger.debug(
					{ uuid: connection.session?.uuid ?? null },
					"AudioSocket terminate received"
				);
				connection.closed = true;
				connection.socket.destroy();
				return;

			case AudioSocketPacketType.ERROR: {
				const code = payload.length > 0 ? payload[0] : 0;
				const error = new AudioSocketError(
					"protocol",
					`AudioSocket reported an error: ${describeAudioSocketError(code)}`,
					code
				);

				this.logger.warn({ uuid: connection.session?.uuid ?? null, code }, error.message);
				connection.session?.deliverError(error);
				this.emit("error", error, connection.session);
				return;
			}

			default:
				// Forward compatibility: a future Asterisk packet type must not derail
				// the framer, and the length prefix already told us how to skip it.
				this.logger.warn(
					{ uuid: connection.session?.uuid ?? null, type, payloadLength: payload.length },
					"AudioSocket unknown packet type ignored"
				);
				return;
		}
	}

	private handleUuidPacket(connection: Connection, payload: Buffer): void {
		if (payload.length !== AUDIOSOCKET_UUID_BYTES) {
			const error = new AudioSocketError(
				"frame",
				`AudioSocket UUID packet had ${payload.length} bytes, expected ${AUDIOSOCKET_UUID_BYTES}`
			);

			this.logger.error({ payloadLength: payload.length }, error.message);
			this.emit("error", error, null);
			return;
		}

		if (connection.session !== null) {
			this.logger.warn(
				{ uuid: connection.session.uuid },
				"AudioSocket duplicate UUID packet ignored"
			);
			return;
		}

		const uuid = formatAudioSocketUuid(payload);
		const session = new Session(uuid, connection.socket, this.logger, this.maxQueuedFrames);

		connection.session = session;
		// The UUID packet itself was counted before the session existed.
		session.countPacket();
		// Start the 20 ms outbound clock now: Asterisk expects a continuous stream
		// from us, not a reply per inbound frame.
		session.startPacing();

		this.logger.info({ uuid, remote: session.remoteAddress }, "AudioSocket session started");
		this.emit("session", session);
	}

	private handleAudioPacket(connection: Connection, payload: Buffer): void {
		const session = connection.session;

		if (session === null) {
			this.logger.warn({}, "AudioSocket audio packet before UUID packet, dropped");
			return;
		}

		if (payload.length === 0 || session.isClosed) {
			return;
		}

		// Copy: the payload is a view onto the accumulated read buffer, and
		// consumers (queues, resamplers) may keep it well past this call.
		const audio = Buffer.from(payload);

		session.deliverAudio(audio);
		this.emit("audio", session, audio);
	}

	private handleDtmfPacket(connection: Connection, payload: Buffer): void {
		const session = connection.session;

		if (session === null || payload.length === 0) {
			return;
		}

		const digit = payload.toString("ascii", 0, 1);

		this.logger.debug({ uuid: session.uuid, digit }, "AudioSocket DTMF received");
		session.deliverDtmf(digit);
		this.emit("dtmf", session, digit);
	}
}
