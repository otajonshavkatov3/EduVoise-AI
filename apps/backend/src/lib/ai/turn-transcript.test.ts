import { describe, expect, test } from "bun:test";
import {
	DEFAULT_INTERIM_MIN_INTERVAL_MS,
	DEFAULT_INTERIM_WINDOW_MS,
	TurnTranscriptStream,
} from "./turn-transcript";

/**
 * The consumer's interim write interval, from call-orchestrator.ts. The whole
 * point of the interim window is to stay under this, so the number is restated
 * here: if the orchestrator ever lowers it, this test is what fails.
 */
const CONSUMER_WRITE_INTERVAL_MS = 2_000;

describe("TurnTranscriptStream interim emissions", () => {
	test("emits the first fragment immediately, so the live view is live", () => {
		const stream = new TurnTranscriptStream();

		expect(stream.pushDelta("resp_1", "Assalomu ", 1_000)).toBe("Assalomu ");
	});

	test("coalesces fragments that arrive inside the throttle window", () => {
		const stream = new TurnTranscriptStream();

		expect(stream.pushDelta("resp_1", "Assalomu ", 1_000)).toBe("Assalomu ");
		expect(stream.pushDelta("resp_1", "alaykum", 1_050)).toBeNull();
		expect(stream.pushDelta("resp_1", "! ", 1_100)).toBeNull();

		// The coalesced text is not lost - it goes out with the next allowed emission.
		expect(stream.pushDelta("resp_1", "Eshitaman", 1_000 + DEFAULT_INTERIM_MIN_INTERVAL_MS)).toBe(
			"alaykum! Eshitaman"
		);
	});

	test("stops emitting interims before the consumer would persist one", () => {
		const stream = new TurnTranscriptStream();
		const emittedAtMs: number[] = [];

		// A long turn: one delta every 100 ms for six seconds. This is the shape of
		// the greeting that was being stored twice.
		for (let index = 0; index < 60; index += 1) {
			const atMs = 1_000 + index * 100;

			if (stream.pushDelta("resp_long", `word${index} `, atMs) !== null) {
				emittedAtMs.push(atMs);
			}
		}

		const first = emittedAtMs.at(0);
		const last = emittedAtMs.at(-1);

		expect(emittedAtMs.length).toBeGreaterThan(1);
		expect(first).toBeDefined();
		expect(last).toBeDefined();

		// THE FIX: no interim event is emitted late enough in the turn for the
		// consumer's write interval to have elapsed since the first one, so the
		// consumer never persists an interim row that the final row then duplicates.
		const span = (last ?? 0) - (first ?? 0);

		expect(span).toBeLessThanOrEqual(DEFAULT_INTERIM_WINDOW_MS);
		expect(span).toBeLessThan(CONSUMER_WRITE_INTERVAL_MS);

		// The text that was not streamed is still delivered, once, by the final line.
		const final = stream.finalise("resp_long", null);

		expect(final).toContain("word59");
	});
});

describe("TurnTranscriptStream finals", () => {
	test("the final line is the server transcript, emitted exactly once", () => {
		const stream = new TurnTranscriptStream();

		stream.pushDelta("resp_1", "Assalomu ", 1_000);
		stream.pushDelta("resp_1", "alaykum", 1_050);

		expect(stream.finalise("resp_1", "Assalomu alaykum!")).toBe("Assalomu alaykum!");
		// The duplicate the greeting bug produced: a second final for the same turn.
		expect(stream.finalise("resp_1", "Assalomu alaykum!")).toBeNull();
	});

	test("falls back to the accumulated deltas when the wire sends no transcript", () => {
		const stream = new TurnTranscriptStream();

		stream.pushDelta("resp_1", "Suv ", 1_000);
		stream.pushDelta("resp_1", "yo'q", 1_100);

		expect(stream.finalise("resp_1", null)).toBe("Suv yo'q");
	});

	test("finalises a turn that produced no deltas at all (the whisper-1 path)", () => {
		const stream = new TurnTranscriptStream();

		expect(stream.finalise("item_1", "Suv kelmayapti")).toBe("Suv kelmayapti");
	});

	test("drops deltas that arrive after the turn was finalised", () => {
		const stream = new TurnTranscriptStream();

		stream.pushDelta("resp_1", "Bir daqiqa", 1_000);
		expect(stream.finalise("resp_1", "Bir daqiqa")).toBe("Bir daqiqa");

		// OpenAI keeps sending deltas briefly after a cancel; they must not re-open
		// the turn, or the consumer's role-keyed buffer would be live again.
		expect(stream.pushDelta("resp_1", ", yozib olaman", 1_200)).toBeNull();
		expect(stream.hasOpenTurn).toBe(false);
	});

	test("an empty turn produces no final at all", () => {
		const stream = new TurnTranscriptStream();

		expect(stream.finalise("resp_1", "   ")).toBeNull();
	});
});

describe("TurnTranscriptStream barge-in", () => {
	test("abandon finalises what was said and blocks the later duplicate", () => {
		const stream = new TurnTranscriptStream();

		stream.pushDelta("resp_1", "Murojaatingizni ", 1_000);
		stream.pushDelta("resp_1", "ro'yxatga olaman", 1_100);

		expect(stream.abandon()).toBe("Murojaatingizni ro'yxatga olaman");
		// The `.done` that arrives after the cancel must not store the line twice.
		expect(stream.finalise("resp_1", "Murojaatingizni ro'yxatga olaman va")).toBeNull();
	});

	test("abandon with nothing open is a no-op", () => {
		const stream = new TurnTranscriptStream();

		expect(stream.abandon()).toBeNull();
	});

	test("a new turn never inherits the previous turn's text", () => {
		const stream = new TurnTranscriptStream();

		stream.pushDelta("resp_1", "Birinchi javob", 1_000);
		stream.abandon();

		stream.pushDelta("resp_2", "Ikkinchi javob", 2_000);

		expect(stream.currentText).toBe("Ikkinchi javob");
		expect(stream.finalise("resp_2", null)).toBe("Ikkinchi javob");
	});

	test("a turn the wire never finalised does not glue onto the next one", () => {
		const stream = new TurnTranscriptStream();

		stream.pushDelta("resp_1", "Yarim gap", 1_000);
		// No finalise, no abandon: a `.done` was simply never delivered.
		stream.pushDelta("resp_2", "Yangi gap", 2_000);

		expect(stream.currentText).toBe("Yangi gap");
	});
});

describe("TurnTranscriptStream limits", () => {
	test("caps a runaway turn instead of growing without bound", () => {
		const stream = new TurnTranscriptStream({ maxTurnChars: 10 });

		stream.pushDelta("resp_1", "12345", 1_000);
		stream.pushDelta("resp_1", "67890abc", 1_500);

		expect(stream.currentText).toBe("1234567890");
	});

	test("reset forgets the open turn and the finalised ids", () => {
		const stream = new TurnTranscriptStream();

		stream.pushDelta("resp_1", "Gap", 1_000);
		stream.reset();

		expect(stream.hasOpenTurn).toBe(false);
		// The id is forgotten too, so a reconnected session may reuse it.
		expect(stream.finalise("resp_1", "Gap")).toBe("Gap");
	});
});
