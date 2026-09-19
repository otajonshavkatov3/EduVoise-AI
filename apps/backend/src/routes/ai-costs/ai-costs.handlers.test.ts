/**
 * The summary's two folds: which money reaches which total, and which day a call
 * is booked to.
 *
 * lib/ai-cost/price.test.ts covers one row's price. This file covers what happens
 * when many rows are added up, which is where two separate defects lived: analysis
 * spend disappearing behind an unpriceable voice line, and a UTC day boundary
 * cutting a UTC+5 calendar in the wrong place.
 */
import { describe, expect, test } from "bun:test";

import {
	type AnalysisTokens,
	GEMINI_LIVE_PROVIDER,
	OPENAI_REALTIME_PROVIDER,
	priceSession,
	type RateTable,
	type SessionTokens,
} from "@/lib/ai-cost";

import {
	type AccumulableRow,
	type Accumulator,
	accumulate,
	bucketKey,
	createAccumulator,
} from "./ai-costs.handlers";

// ===========================================
// Fixtures
// ===========================================

/** Round numbers rather than the shipped defaults, so a corrected rate cannot fail a test. */
const RATES: RateTable = {
	usdToUzs: 0,
	openaiRealtime: {
		textInputPer1M: 10,
		textInputCachedPer1M: 1,
		audioInputPer1M: 100,
		audioInputCachedPer1M: 10,
		textOutputPer1M: 20,
		audioOutputPer1M: 200,
	},
	geminiLive: {
		textInputPer1M: 2,
		textInputCachedPer1M: 2,
		audioInputPer1M: 4,
		audioInputCachedPer1M: 4,
		textOutputPer1M: 8,
		audioOutputPer1M: 16,
	},
	transcribe: { audioInputPer1M: 6, textOutputPer1M: 12 },
	analysis: { inputPer1M: 1, cachedInputPer1M: 0.5, outputPer1M: 4 },
};

/** A pre-migration session: the two totals exist, every breakdown column is NULL. */
const LEGACY_TOKENS: SessionTokens = {
	promptTokens: 121_633,
	cachedPromptTokens: null,
	cachedAudioTokens: null,
	cachedTextTokens: null,
	inputTextTokens: null,
	inputAudioTokens: null,
	completionTokens: 2400,
	outputTextTokens: null,
	outputAudioTokens: null,
	transcribeAudioTokens: null,
	transcribeTextTokens: null,
};

/** A post-migration session that prices exactly: cold, all audio, both sides reported. */
const PRICED_TOKENS: SessionTokens = {
	promptTokens: 100_000,
	cachedPromptTokens: 0,
	cachedAudioTokens: null,
	cachedTextTokens: null,
	inputTextTokens: 0,
	inputAudioTokens: 100_000,
	completionTokens: 10_000,
	outputTextTokens: 0,
	outputAudioTokens: 10_000,
	transcribeAudioTokens: 0,
	transcribeTextTokens: 0,
};

/** 100k audio in @ 100 + 10k audio out @ 200. Transcription is a reported 0. */
const PRICED_VOICE_USD = (100_000 * 100 + 10_000 * 200) / 1e6;

/** Two billed runs of the summariser: the shape the retry handler records. */
const ANALYSIS: AnalysisTokens = {
	promptTokens: 40_000,
	cachedPromptTokens: 10_000,
	completionTokens: 2000,
	billedRuns: 2,
};

/** 30k fresh @ 1 + 10k cached @ 0.5 + 2k out @ 4. */
const ANALYSIS_USD = (30_000 * 1 + 10_000 * 0.5 + 2000 * 4) / 1e6;

function row(overrides: Partial<AccumulableRow> = {}): AccumulableRow {
	return {
		promptTokens: null,
		completionTokens: null,
		responseTurns: null,
		durationMs: null,
		callDuration: null,
		analysisBilledRuns: null,
		analysisStatus: null,
		...overrides,
	};
}

// ===========================================
// Which money reaches which total
// ===========================================

describe("accumulate - the analysis line is priced on its own list", () => {
	test("analysis spend survives a voice line that could not be priced", () => {
		// The post-call summary is an independent gpt-4o-mini call: whether the voice
		// session predates the breakdown columns says nothing about what it cost.
		const cost = priceSession(LEGACY_TOKENS, OPENAI_REALTIME_PROVIDER, ANALYSIS, RATES);
		const acc = createAccumulator();

		accumulate(
			acc,
			row({ promptTokens: 121_633, completionTokens: 2400, analysisBilledRuns: 2 }),
			cost
		);

		expect(cost.voice.costUsd).toBeNull();
		expect(cost.totalCostUsd).toBeNull();
		expect(acc.analysis.cost.value).toBeCloseTo(ANALYSIS_USD, 9);
		// The headline reports the money that IS known rather than dropping it because
		// a different line on the same row is not.
		expect(acc.total.value).toBeCloseTo(ANALYSIS_USD, 9);
	});

	test("that spend stays out of the averages, whose denominator is priced sessions", () => {
		// costPerCall = total / pricedSessions and costPerMinute = total / pricedMinutes,
		// so their numerator has to cover exactly the rows the denominator counts.
		const acc = createAccumulator();

		accumulate(
			acc,
			row({ analysisBilledRuns: 2, durationMs: 186_000 }),
			priceSession(LEGACY_TOKENS, OPENAI_REALTIME_PROVIDER, ANALYSIS, RATES)
		);
		accumulate(
			acc,
			row({ promptTokens: 100_000, completionTokens: 10_000, durationMs: 60_000 }),
			priceSession(PRICED_TOKENS, OPENAI_REALTIME_PROVIDER, null, RATES)
		);

		expect(acc.sessions).toBe(2);
		expect(acc.pricedSessions).toBe(1);
		expect(acc.callSeconds).toBe(246);
		expect(acc.pricedCallSeconds).toBe(60);
		// Wider: every known dollar in the window.
		expect(acc.total.value).toBeCloseTo(PRICED_VOICE_USD + ANALYSIS_USD, 9);
		// Narrower: only the session the denominators count.
		expect(acc.pricedTotal.value).toBeCloseTo(PRICED_VOICE_USD, 9);
	});

	test("an unmeasured analysis contributes no tokens either, so none can sit beside an unknown price", () => {
		// billedRuns 0 is "analysed before the counters existed". Counting its tokens
		// while its money stays null is what put 40 000 tokens next to "ma'lumot yo'q"
		// in the same card.
		const acc = createAccumulator();

		accumulate(
			acc,
			row({ analysisBilledRuns: 0 }),
			priceSession(LEGACY_TOKENS, OPENAI_REALTIME_PROVIDER, { ...ANALYSIS, billedRuns: 0 }, RATES)
		);

		expect(acc.analysis.cost.value).toBeNull();
		expect(acc.analysis.promptTokens).toBe(0);
		expect(acc.analysis.cachedPromptTokens).toBe(0);
		expect(acc.analysis.completionTokens).toBe(0);
		expect(acc.analysis.billedRuns).toBe(0);
		expect(acc.analysis.unmeasuredAnalyses).toBe(1);
	});

	test("Gemini's structural transcription zero cannot turn an unknown month into $0.00", () => {
		// Gemini transcribes inside the session with no separate charge. That 0 is
		// real, but letting it into an otherwise empty bucket would make Money report
		// a total of zero instead of "not known".
		const cost = priceSession(LEGACY_TOKENS, GEMINI_LIVE_PROVIDER, null, RATES);
		const acc = createAccumulator();

		accumulate(acc, row({ promptTokens: 121_633 }), cost);

		expect(cost.transcription.notApplicable).toBe(true);
		expect(cost.transcription.costUsd).toBe(0);
		expect(acc.total.value).toBeNull();
		// Same reasoning one level down: the transcription bucket itself must not
		// report a measured $0.00 for a window whose transcription spend is unknown.
		expect(acc.transcription.cost.value).toBeNull();
		expect(acc.transcription.notApplicableSessions).toBe(1);
	});

	test("a failed analysis is not counted as spend nobody recorded", () => {
		// Both carry billedRuns 0, but they mean opposite things: one cost real money
		// that went unrecorded, the other produced nothing. Reporting a failure as
		// "narxi noma'lum" tells the owner money is missing when none was spent.
		const acc = createAccumulator();
		const cost = priceSession(
			LEGACY_TOKENS,
			OPENAI_REALTIME_PROVIDER,
			{ ...ANALYSIS, billedRuns: 0 },
			RATES
		);

		accumulate(acc, row({ analysisBilledRuns: 0, analysisStatus: "failed" }), cost);
		accumulate(acc, row({ analysisBilledRuns: 0, analysisStatus: "completed" }), cost);

		expect(acc.analysis.failedAnalyses).toBe(1);
		expect(acc.analysis.unmeasuredAnalyses).toBe(1);
	});

	test("every unpriced session falls into a bucket the notes can name", () => {
		// The notes explain legacy rows and no-usage rows separately, so the two
		// counters have to add up to unpricedSessions - otherwise the owner subtracts
		// and is left with a gap the page never accounts for.
		const acc = createAccumulator();

		accumulate(
			acc,
			row({ promptTokens: 121_633 }),
			priceSession(LEGACY_TOKENS, OPENAI_REALTIME_PROVIDER, null, RATES)
		);
		accumulate(
			acc,
			row(),
			priceSession(
				{ ...LEGACY_TOKENS, promptTokens: null, completionTokens: null },
				OPENAI_REALTIME_PROVIDER,
				null,
				RATES
			)
		);

		expect(acc.unpricedSessions).toBe(2);
		expect(acc.legacySessions).toBe(1);
		// What buildEstimateNotes reports as "token sarfini umuman qayd etmagan".
		expect(acc.unpricedSessions - acc.legacySessions).toBe(1);
	});

	test("a legacy row contributes its raw totals and no fabricated split", () => {
		const acc = createAccumulator();

		accumulate(
			acc,
			row({ promptTokens: 121_633, completionTokens: 2400, responseTurns: 31 }),
			priceSession(LEGACY_TOKENS, OPENAI_REALTIME_PROVIDER, null, RATES)
		);

		expect(acc.voice.promptTokens).toBe(121_633);
		expect(acc.voice.completionTokens).toBe(2400);
		expect(acc.legacySessions).toBe(1);
		// Folding this row into the split would book its whole prompt as fresh audio.
		expect(acc.voice.breakdownSessions).toBe(0);
		expect(acc.voice.freshPromptTokens).toBe(0);
		expect(acc.voice.cachedPromptTokens).toBe(0);
		expect(acc.voice.responseTurns).toBe(0);
	});
});

// ===========================================
// Which day a call is booked to
// ===========================================

const TASHKENT = "Asia/Tashkent";

describe("bucketKey - days are cut in the tenant's zone", () => {
	test("a call just after local midnight belongs to that local day", () => {
		// 02:30 in Tashkent is 21:30 the PREVIOUS day in UTC. Truncating in UTC moved
		// every call between 00:00 and 05:00 into the wrong bar.
		const justAfterMidnight = new Date("2026-08-06T02:30:00+05:00");

		expect(justAfterMidnight.toISOString()).toBe("2026-08-05T21:30:00.000Z");
		expect(bucketKey(justAfterMidnight, "day", TASHKENT)).toBe("2026-08-06");
		expect(bucketKey(justAfterMidnight, "day", "UTC")).toBe("2026-08-05");
	});

	test("the first and last instants of a local day share one bucket", () => {
		expect(bucketKey(new Date("2026-08-05T00:00:00+05:00"), "day", TASHKENT)).toBe("2026-08-05");
		expect(bucketKey(new Date("2026-08-05T23:59:59+05:00"), "day", TASHKENT)).toBe("2026-08-05");
		expect(bucketKey(new Date("2026-08-06T00:00:00+05:00"), "day", TASHKENT)).toBe("2026-08-06");
	});

	test("a call on the first local day of a month stays inside that month", () => {
		// The page's own default range starts 2026-07-31T19:00Z, so this is the call
		// that produced a bar labelled 31.07 inside an August month view.
		const firstOfAugust = new Date("2026-08-01T00:30:00+05:00");

		expect(bucketKey(firstOfAugust, "day", TASHKENT)).toBe("2026-08-01");
		expect(bucketKey(firstOfAugust, "month", TASHKENT)).toBe("2026-08-01");
		expect(bucketKey(new Date("2026-07-31T23:30:00+05:00"), "month", TASHKENT)).toBe("2026-07-01");
	});

	test("weeks start on the local Monday", () => {
		// 2026-08-03 is a Monday in Tashkent.
		expect(bucketKey(new Date("2026-08-06T02:30:00+05:00"), "week", TASHKENT)).toBe("2026-08-03");
		expect(bucketKey(new Date("2026-08-03T00:10:00+05:00"), "week", TASHKENT)).toBe("2026-08-03");
		// Sunday 2026-08-02 still belongs to the week that began 2026-07-27.
		expect(bucketKey(new Date("2026-08-02T23:50:00+05:00"), "week", TASHKENT)).toBe("2026-07-27");
	});

	test("an unknown zone is not silently accepted by the formatter", () => {
		// resolveTimeZone validates before this point; if it ever stopped, the throw
		// has to be loud rather than producing a plausible-looking wrong key.
		expect(() => bucketKey(new Date(), "day", "Mars/Olympus")).toThrow();
	});
});

describe("the trend series and the headline agree on the boundary", () => {
	test("the per-day buckets add up to the same money as the total", () => {
		// The chart and the tile are two folds over one set of rows. A boundary that
		// dropped a row out of every bucket would show here as a shortfall.
		const startedAt = [
			new Date("2026-08-05T23:30:00+05:00"),
			new Date("2026-08-06T01:00:00+05:00"),
			new Date("2026-08-06T14:00:00+05:00"),
		];
		const totals = createAccumulator();
		const buckets = new Map<string, Accumulator>();

		for (const at of startedAt) {
			const cost = priceSession(PRICED_TOKENS, OPENAI_REALTIME_PROVIDER, ANALYSIS, RATES);
			const sessionRow = row({ promptTokens: 100_000, analysisBilledRuns: 2, durationMs: 60_000 });
			const key = bucketKey(at, "day", TASHKENT);
			let bucket = buckets.get(key);

			if (bucket === undefined) {
				bucket = createAccumulator();
				buckets.set(key, bucket);
			}

			accumulate(totals, sessionRow, cost);
			accumulate(bucket, sessionRow, cost);
		}

		// 01:00 local on the 6th is 20:00 UTC on the 5th: in UTC these would be 1 + 2.
		expect([...buckets.keys()].sort()).toEqual(["2026-08-05", "2026-08-06"]);
		expect(buckets.get("2026-08-05")?.sessions).toBe(1);
		expect(buckets.get("2026-08-06")?.sessions).toBe(2);

		const seriesSum = [...buckets.values()].reduce((sum, acc) => sum + (acc.total.value ?? 0), 0);

		expect(seriesSum).toBeCloseTo(totals.total.value ?? 0, 9);
		expect(totals.total.value).toBeCloseTo(3 * (PRICED_VOICE_USD + ANALYSIS_USD), 9);
	});
});
