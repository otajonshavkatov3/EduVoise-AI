import { describe, expect, test } from "bun:test";

import {
	type AnalysisTokens,
	costPerMinute,
	GEMINI_LIVE_PROVIDER,
	isProviderPriced,
	OPENAI_REALTIME_PROVIDER,
	priceAnalysis,
	priceSession,
	priceTranscription,
	priceVoiceSession,
	type RateTable,
	ratesForProvider,
	roundMoney,
	type SessionTokens,
	toUzs,
} from "./price";

// ===========================================
// Fixtures
// ===========================================

/**
 * Round numbers, not the shipped defaults: a test that hardcodes real list prices
 * starts failing the day someone corrects a rate, which teaches the next reader to
 * edit the expectation instead of reading it.
 */
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

const ZERO_RATES: RateTable = {
	usdToUzs: 0,
	openaiRealtime: {
		textInputPer1M: 0,
		textInputCachedPer1M: 0,
		audioInputPer1M: 0,
		audioInputCachedPer1M: 0,
		textOutputPer1M: 0,
		audioOutputPer1M: 0,
	},
	geminiLive: {
		textInputPer1M: 0,
		textInputCachedPer1M: 0,
		audioInputPer1M: 0,
		audioInputCachedPer1M: 0,
		textOutputPer1M: 0,
		audioOutputPer1M: 0,
	},
	transcribe: { audioInputPer1M: 0, textOutputPer1M: 0 },
	analysis: { inputPer1M: 0, cachedInputPer1M: 0, outputPer1M: 0 },
};

function tokens(overrides: Partial<SessionTokens> = {}): SessionTokens {
	return {
		promptTokens: 0,
		cachedPromptTokens: 0,
		// The measured 2x2 cells, which only the OpenAI path reports. Null by
		// default so the fixtures exercise the apportionment unless a test opts in.
		cachedAudioTokens: null,
		cachedTextTokens: null,
		inputTextTokens: 0,
		inputAudioTokens: 0,
		completionTokens: 0,
		outputTextTokens: 0,
		outputAudioTokens: 0,
		transcribeAudioTokens: 0,
		transcribeTextTokens: 0,
		...overrides,
	};
}

/** A pre-migration row: the two totals exist, every breakdown column is NULL. */
function legacyTokens(prompt: number, completion: number): SessionTokens {
	return {
		promptTokens: prompt,
		cachedPromptTokens: null,
		cachedAudioTokens: null,
		cachedTextTokens: null,
		inputTextTokens: null,
		inputAudioTokens: null,
		completionTokens: completion,
		outputTextTokens: null,
		outputAudioTokens: null,
		transcribeAudioTokens: null,
		transcribeTextTokens: null,
	};
}

/** Asserts a breakdown cell was reported at all. A null here is the failure, not a 0. */
function reported(value: number | null): number {
	expect(value).not.toBeNull();

	return value ?? 0;
}

// ===========================================
// Rate table plumbing
// ===========================================

describe("ratesForProvider", () => {
	test("resolves the two speech-to-speech providers", () => {
		expect(ratesForProvider(RATES, OPENAI_REALTIME_PROVIDER)).toBe(RATES.openaiRealtime);
		expect(ratesForProvider(RATES, GEMINI_LIVE_PROVIDER)).toBe(RATES.geminiLive);
	});

	test("returns null for the scripted fallback, which burns no tokens", () => {
		expect(ratesForProvider(RATES, "fallback-ivr")).toBeNull();
		expect(ratesForProvider(RATES, "something-new")).toBeNull();
	});
});

describe("isProviderPriced", () => {
	test("false only when every rate is zero", () => {
		expect(isProviderPriced(RATES.openaiRealtime)).toBe(true);
		expect(isProviderPriced(ZERO_RATES.openaiRealtime)).toBe(false);
		expect(isProviderPriced({ ...ZERO_RATES.openaiRealtime, audioOutputPer1M: 0.5 })).toBe(true);
	});
});

// ===========================================
// The arithmetic
// ===========================================

describe("priceVoiceSession - exact cases", () => {
	test("a cold all-text session is exact, not estimated", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 0,
				inputTextTokens: 1_000_000,
				inputAudioTokens: 0,
				completionTokens: 500_000,
				outputTextTokens: 500_000,
				outputAudioTokens: 0,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		// 1M text in @ 10 + 0.5M text out @ 20 = 10 + 10
		expect(cost.costUsd).toBe(20);
		expect(cost.estimated).toBe(false);
		expect(cost.modalityAssumed).toBe(false);
		expect(cost.cachedSharePct).toBe(0);
	});

	test("a cold all-audio session is exact", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 100_000,
				cachedPromptTokens: 0,
				inputAudioTokens: 100_000,
				completionTokens: 50_000,
				outputAudioTokens: 50_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		// 0.1M audio in @ 100 + 0.05M audio out @ 200 = 10 + 10
		expect(cost.costUsd).toBe(20);
		expect(cost.estimated).toBe(false);
	});

	test("a cold session uses the reported marginals rather than re-deriving them", () => {
		// The numbers a real 22 s Gemini call produced. Its marginals do not sum to
		// the prompt total, and apportioning across that gap charged 211 audio tokens
		// where the provider reported 201 - a small overstatement, but one that made
		// the row inexact while it still claimed to be measured.
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 9145,
				cachedPromptTokens: 0,
				inputTextTokens: 8505,
				inputAudioTokens: 201,
				completionTokens: 207,
				outputTextTokens: 0,
				outputAudioTokens: 207,
			}),
			GEMINI_LIVE_PROVIDER,
			RATES
		);

		// The 439 tokens the marginals leave out are charged as text, the cheaper of
		// the two, so an unexplained prompt token can never inflate the bill.
		const expected = (201 * 4 + (8505 + 439) * 2 + 207 * 16) / 1e6;

		expect(cost.costUsd).toBeCloseTo(expected, 9);
		expect(cost.breakdown.freshAudioTokens).toBe(201);
		expect(cost.breakdown.freshTextTokens).toBe(8944);
		// A guessed residual is still a guess, whatever the cache did.
		expect(cost.estimated).toBe(true);
	});

	test("a cold session whose marginals do add up is exact", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 10_000,
				cachedPromptTokens: 0,
				inputTextTokens: 9000,
				inputAudioTokens: 1000,
				completionTokens: 500,
				outputTextTokens: 0,
				outputAudioTokens: 500,
			}),
			GEMINI_LIVE_PROVIDER,
			RATES
		);

		expect(cost.costUsd).toBeCloseTo((1000 * 4 + 9000 * 2 + 500 * 16) / 1e6, 9);
		expect(cost.estimated).toBe(false);
	});

	test("output cost is exact even when the input is apportioned", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 900_000,
				inputAudioTokens: 500_000,
				inputTextTokens: 500_000,
				completionTokens: 100_000,
				outputAudioTokens: 90_000,
				outputTextTokens: 10_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		// audioShare 0.5; fresh 100k -> 50k audio @100 + 50k text @10 = 5 + 0.5
		// cached 900k -> 450k audio @10 + 450k text @1 = 4.5 + 0.45
		// output 90k audio @200 + 10k text @20 = 18 + 0.2
		expect(cost.costUsd).toBeCloseTo(5 + 0.5 + 4.5 + 0.45 + 18 + 0.2, 9);
		expect(cost.estimated).toBe(true);
		expect(cost.cachedSharePct).toBe(90);
	});
});

describe("priceVoiceSession - the cache/modality apportionment", () => {
	test("audioShare comes from the modality marginals, not from the prompt total", () => {
		// A warm session: the prompt total is dominated by the cached prefix, so
		// dividing audio by the PROMPT would report a 10% audio share instead of 80%.
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 900_000,
				inputAudioTokens: 80_000,
				inputTextTokens: 20_000,
				completionTokens: 0,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(cost.breakdown.freshAudioTokens).toBe(80_000);
		expect(cost.breakdown.freshTextTokens).toBe(20_000);
		expect(cost.breakdown.cachedAudioTokens).toBe(720_000);
		expect(cost.breakdown.cachedTextTokens).toBe(180_000);
	});

	test("the two input axes each sum to the prompt total and must not be added together", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 870_000,
				inputAudioTokens: 600_000,
				inputTextTokens: 400_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);
		const { breakdown } = cost;

		expect(reported(breakdown.freshPromptTokens) + reported(breakdown.cachedPromptTokens)).toBe(
			1_000_000
		);
		expect(reported(breakdown.inputAudioTokens) + reported(breakdown.inputTextTokens)).toBe(
			1_000_000
		);
		// The 2x2 cells also reconstruct the same total - that is the invariant that
		// makes the apportionment safe to price with.
		expect(
			reported(breakdown.freshAudioTokens) +
				reported(breakdown.freshTextTokens) +
				reported(breakdown.cachedAudioTokens) +
				reported(breakdown.cachedTextTokens)
		).toBe(1_000_000);
	});

	test("87% cached costs far less than the same tokens priced as fresh", () => {
		// The measured cache hit rate on a real call. Pricing a legacy row's whole
		// prompt at the fresh rate is the ~10x overstatement this guards against.
		const warm = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 870_000,
				inputAudioTokens: 1_000_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);
		const cold = priceVoiceSession(
			tokens({ promptTokens: 1_000_000, cachedPromptTokens: 0, inputAudioTokens: 1_000_000 }),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(cold.costUsd).toBe(100);
		expect(warm.costUsd).toBeCloseTo(0.13 * 100 + 0.87 * 10, 9);
		expect((cold.costUsd ?? 0) / (warm.costUsd ?? 1)).toBeGreaterThan(4);
	});

	test("cached is clamped to the prompt total so a bad report cannot go negative", () => {
		const cost = priceVoiceSession(
			tokens({ promptTokens: 1000, cachedPromptTokens: 5000, inputAudioTokens: 1000 }),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(cost.breakdown.freshPromptTokens).toBe(0);
		expect(cost.breakdown.cachedPromptTokens).toBe(1000);
		expect(cost.costUsd).toBeCloseTo((1000 * 10) / 1e6, 9);
	});
});

describe("priceVoiceSession - the measured 2x2 cells beat the apportionment", () => {
	/**
	 * The shape OpenAI Realtime actually sends, captured from a live response.done
	 * on 2026-08-06 (gpt-realtime): input_token_details carried
	 * `cached_tokens: 6784` next to `cached_tokens_details: { text_tokens: 6784,
	 * audio_tokens: 0 }`, i.e. the cells reconstruct the marginal exactly.
	 */
	test("cached cells are used verbatim and the price stops being an estimate", () => {
		const measured = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 900_000,
				inputAudioTokens: 500_000,
				inputTextTokens: 500_000,
				// Nothing like the 50/50 the marginals would have implied.
				cachedAudioTokens: 400_000,
				cachedTextTokens: 500_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(measured.breakdown.cachedAudioTokens).toBe(400_000);
		expect(measured.breakdown.cachedTextTokens).toBe(500_000);
		// Fresh is what the marginals have left over, not another apportionment.
		expect(measured.breakdown.freshAudioTokens).toBe(100_000);
		expect(measured.breakdown.freshTextTokens).toBe(0);
		expect(measured.estimated).toBe(false);
		expect(measured.costUsd).toBeCloseTo(
			(100_000 * 100 + 0 * 10 + 400_000 * 10 + 500_000 * 1) / 1e6,
			9
		);
	});

	test("the measured cells still reconstruct the prompt total", () => {
		const { breakdown } = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 870_000,
				inputAudioTokens: 600_000,
				inputTextTokens: 400_000,
				cachedAudioTokens: 520_000,
				cachedTextTokens: 350_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(
			reported(breakdown.freshAudioTokens) +
				reported(breakdown.freshTextTokens) +
				reported(breakdown.cachedAudioTokens) +
				reported(breakdown.cachedTextTokens)
		).toBe(1_000_000);
	});

	test("cells that do not decompose the marginals are discarded, not trusted", () => {
		// 400k + 400k != the 900k cached marginal, so this is not a decomposition of
		// it. Believing it would price 100k cached tokens at no rate at all.
		const inconsistent = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 900_000,
				inputAudioTokens: 500_000,
				inputTextTokens: 500_000,
				cachedAudioTokens: 400_000,
				cachedTextTokens: 400_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);
		const apportioned = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 900_000,
				inputAudioTokens: 500_000,
				inputTextTokens: 500_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(inconsistent.costUsd).toBe(apportioned.costUsd);
		expect(inconsistent.estimated).toBe(true);
	});

	test("a provider that reports no cells falls back to the apportionment", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 1_000_000,
				cachedPromptTokens: 900_000,
				inputAudioTokens: 800_000,
				inputTextTokens: 200_000,
			}),
			GEMINI_LIVE_PROVIDER,
			RATES
		);

		expect(cost.breakdown.cachedAudioTokens).toBe(720_000);
		expect(cost.estimated).toBe(true);
	});
});

describe("priceVoiceSession - assumptions are flagged", () => {
	test("no modality marginals means the prompt is assumed to be audio, and said so", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 100_000,
				cachedPromptTokens: 0,
				inputAudioTokens: 0,
				inputTextTokens: 0,
			}),
			GEMINI_LIVE_PROVIDER,
			RATES
		);

		expect(cost.modalityAssumed).toBe(true);
		expect(cost.estimated).toBe(true);
		expect(cost.costUsd).toBeCloseTo((100_000 * 4) / 1e6, 9);
	});

	test("a missing output split is charged as audio and flagged", () => {
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 0,
				cachedPromptTokens: 0,
				completionTokens: 50_000,
				outputAudioTokens: 0,
				outputTextTokens: 0,
			}),
			GEMINI_LIVE_PROVIDER,
			RATES
		);

		expect(cost.breakdown.outputAudioTokens).toBe(50_000);
		expect(cost.modalityAssumed).toBe(true);
		expect(cost.costUsd).toBeCloseTo((50_000 * 16) / 1e6, 9);
	});
});

describe("priceVoiceSession - unknown is null, never zero", () => {
	test("a pre-migration row cannot be priced even though it has totals", () => {
		const cost = priceVoiceSession(legacyTokens(45_000, 850), OPENAI_REALTIME_PROVIDER, RATES);

		expect(cost.costUsd).toBeNull();
		expect(cost.unpricedReason).toBe("no-breakdown");
		// The cached share is unknown, not 0% - "0% cached" would read as a call whose
		// cache never hit, which is a different and much worse story.
		expect(cost.cachedSharePct).toBeNull();
	});

	test("a pre-migration row reports no split at all rather than a fabricated one", () => {
		const cost = priceVoiceSession(legacyTokens(196_798, 2400), OPENAI_REALTIME_PROVIDER, RATES);

		// freshPromptTokens = the whole prompt and cachedPromptTokens = 0 would say
		// "100% fresh, cache never hit" about a row that measured neither - the same
		// ~10x overstatement that keeps the money null two lines above. One object
		// cannot report the split as unknown and as measured at the same time.
		expect(cost.breakdown.freshPromptTokens).toBeNull();
		expect(cost.breakdown.cachedPromptTokens).toBeNull();
		expect(cost.breakdown.inputAudioTokens).toBeNull();
		expect(cost.breakdown.inputTextTokens).toBeNull();
		expect(cost.breakdown.outputAudioTokens).toBeNull();
		expect(cost.breakdown.outputTextTokens).toBeNull();
		expect(cost.breakdown.freshAudioTokens).toBeNull();
		expect(cost.breakdown.cachedAudioTokens).toBeNull();
		expect(cost.cachedSharePct).toBeNull();
	});

	test("a row that measured the split keeps it even when the rates cannot price it", () => {
		// Unknown MONEY is not unknown TOKENS: this row reported its cache split, so
		// the split is reportable and only the price is missing.
		const cost = priceVoiceSession(
			tokens({
				promptTokens: 100_000,
				cachedPromptTokens: 87_000,
				inputAudioTokens: 90_000,
				inputTextTokens: 10_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			ZERO_RATES
		);

		expect(cost.costUsd).toBeNull();
		expect(cost.unpricedReason).toBe("rates-not-set");
		expect(cost.breakdown.freshPromptTokens).toBe(13_000);
		expect(cost.breakdown.cachedPromptTokens).toBe(87_000);
		expect(cost.cachedSharePct).toBe(87);
		// The 2x2 cells are produced by pricing, which did not happen.
		expect(cost.breakdown.cachedAudioTokens).toBeNull();
	});

	test("a cold session genuinely reports a 0% cached share", () => {
		const cost = priceVoiceSession(
			tokens({ promptTokens: 1000, cachedPromptTokens: 0, inputAudioTokens: 1000 }),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(cost.cachedSharePct).toBe(0);
	});

	test("a session that reported nothing is unpriced rather than free", () => {
		const cost = priceVoiceSession(tokens(), OPENAI_REALTIME_PROVIDER, RATES);

		expect(cost.costUsd).toBeNull();
		expect(cost.unpricedReason).toBe("no-usage");
	});

	test("the scripted fallback is unpriced, not zero", () => {
		const cost = priceVoiceSession(
			tokens({ promptTokens: 10, cachedPromptTokens: 0, inputAudioTokens: 10 }),
			"fallback-ivr",
			RATES
		);

		expect(cost.costUsd).toBeNull();
		expect(cost.unpricedReason).toBe("provider-not-priced");
	});

	test("rates left at zero report unpriced instead of a free call", () => {
		const cost = priceVoiceSession(
			tokens({ promptTokens: 1_000_000, cachedPromptTokens: 0, inputAudioTokens: 1_000_000 }),
			OPENAI_REALTIME_PROVIDER,
			ZERO_RATES
		);

		expect(cost.costUsd).toBeNull();
		expect(cost.unpricedReason).toBe("rates-not-set");
	});
});

// ===========================================
// Transcription
// ===========================================

describe("priceTranscription", () => {
	test("prices the OpenAI path from its own model's rates", () => {
		const cost = priceTranscription(
			tokens({ transcribeAudioTokens: 100_000, transcribeTextTokens: 10_000 }),
			OPENAI_REALTIME_PROVIDER,
			RATES
		);

		expect(cost.costUsd).toBeCloseTo((100_000 * 6 + 10_000 * 12) / 1e6, 9);
		expect(cost.notApplicable).toBe(false);
	});

	test("Gemini transcribes inside the session, so the separate line is a true zero", () => {
		const cost = priceTranscription(
			tokens({ transcribeAudioTokens: 0, transcribeTextTokens: 0 }),
			GEMINI_LIVE_PROVIDER,
			RATES
		);

		expect(cost.costUsd).toBe(0);
		expect(cost.notApplicable).toBe(true);
	});

	test("a pre-migration OpenAI row is unknown, not zero", () => {
		const cost = priceTranscription(legacyTokens(1000, 100), OPENAI_REALTIME_PROVIDER, RATES);

		expect(cost.costUsd).toBeNull();
		expect(cost.notApplicable).toBe(false);
	});
});

// ===========================================
// Post-call analysis
// ===========================================

describe("priceAnalysis", () => {
	function analysis(overrides: Partial<AnalysisTokens> = {}): AnalysisTokens {
		return {
			promptTokens: 0,
			cachedPromptTokens: 0,
			completionTokens: 0,
			billedRuns: 1,
			...overrides,
		};
	}

	test("splits fresh and cached prompt tokens", () => {
		const cost = priceAnalysis(
			analysis({ promptTokens: 1_000_000, cachedPromptTokens: 400_000, completionTokens: 100_000 }),
			RATES
		);

		// 600k fresh @1 + 400k cached @0.5 + 100k out @4
		expect(cost.costUsd).toBeCloseTo((600_000 * 1 + 400_000 * 0.5 + 100_000 * 4) / 1e6, 9);
	});

	test("accumulated retries price as the sum they are - three runs cost three times", () => {
		const one = priceAnalysis(analysis({ promptTokens: 1000, completionTokens: 200 }), RATES);
		const three = priceAnalysis(
			analysis({ promptTokens: 3000, completionTokens: 600, billedRuns: 3 }),
			RATES
		);

		expect(three.costUsd).toBeCloseTo((one.costUsd ?? 0) * 3, 9);
		expect(three.billedRuns).toBe(3);
	});

	test("billedRuns of zero is unknown, because the columns predate the counter", () => {
		expect(priceAnalysis(analysis({ billedRuns: 0, promptTokens: 500 }), RATES).costUsd).toBeNull();
		expect(priceAnalysis(null, RATES).costUsd).toBeNull();
	});
});

// ===========================================
// Whole-session total
// ===========================================

describe("priceSession", () => {
	test("adds the three cost centres", () => {
		const cost = priceSession(
			tokens({
				promptTokens: 100_000,
				cachedPromptTokens: 0,
				inputAudioTokens: 100_000,
				completionTokens: 10_000,
				outputAudioTokens: 10_000,
				transcribeAudioTokens: 50_000,
			}),
			OPENAI_REALTIME_PROVIDER,
			{ promptTokens: 2000, cachedPromptTokens: 0, completionTokens: 300, billedRuns: 1 },
			RATES
		);

		const voice = (100_000 * 100 + 10_000 * 200) / 1e6;
		const transcription = (50_000 * 6) / 1e6;
		const analysis = (2000 * 1 + 300 * 4) / 1e6;

		expect(cost.voice.costUsd).toBeCloseTo(voice, 9);
		expect(cost.totalCostUsd).toBeCloseTo(voice + transcription + analysis, 9);
		expect(cost.partial).toBe(false);
	});

	test("an unknown voice line makes the total unknown", () => {
		const cost = priceSession(legacyTokens(45_000, 850), OPENAI_REALTIME_PROVIDER, null, RATES);

		expect(cost.totalCostUsd).toBeNull();
	});

	test("an unknown analysis line is omitted and the total is marked partial", () => {
		const cost = priceSession(
			tokens({ promptTokens: 100_000, cachedPromptTokens: 0, inputAudioTokens: 100_000 }),
			OPENAI_REALTIME_PROVIDER,
			null,
			RATES
		);

		expect(cost.totalCostUsd).toBeCloseTo((100_000 * 100) / 1e6, 9);
		expect(cost.partial).toBe(true);
	});
});

// ===========================================
// Presentation helpers
// ===========================================

describe("toUzs", () => {
	test("converts only when an exchange rate is configured", () => {
		expect(toUzs(1.5, 12_000)).toBe(18_000);
		expect(toUzs(1.5, 0)).toBeNull();
		expect(toUzs(null, 12_000)).toBeNull();
	});
});

describe("costPerMinute", () => {
	test("divides by the real duration", () => {
		expect(costPerMinute(1, 120_000)).toBe(0.5);
	});

	test("is null rather than infinite for a zero-length call", () => {
		expect(costPerMinute(1, 0)).toBeNull();
		expect(costPerMinute(1, null)).toBeNull();
		expect(costPerMinute(null, 60_000)).toBeNull();
	});
});

describe("roundMoney", () => {
	test("keeps float noise out of the response without changing any displayed digit", () => {
		expect(roundMoney(0.1 + 0.2)).toBe(0.3);
		expect(roundMoney(1.23456789)).toBe(1.234568);
	});
});
