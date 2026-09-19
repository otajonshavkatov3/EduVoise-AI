/**
 * One call's spend, flattened into the object a detail screen renders.
 *
 * price.ts returns the arithmetic in its natural shape: three independent lines
 * plus a token breakdown. Every screen that shows the cost of a SINGLE call then
 * flattens that same tree the same way, and doing the flattening twice is how two
 * pages start quoting different numbers for one call - one of them forgetting that
 * `transcription.notApplicable` is not the same as a zero, or dividing by the call
 * duration instead of the session duration. This is the one flattening.
 *
 * It decides nothing about money and nothing about permissions. Which rates apply
 * is rates.ts, how they multiply is price.ts, and who may see the result is the
 * route's business - /ai-costs is finance and is supervisor-only, so any endpoint
 * that leaks the same figure to a role refused that page has made the two disagree.
 */
import {
	type AnalysisTokens,
	costPerMinute,
	priceSession,
	type RateTable,
	type SessionTokens,
	toUzs,
	type UnpricedReason,
} from "./price";

/**
 * Every field a per-call cost card needs, already flat.
 *
 * Null means "not known", never zero - see the two rules at the top of price.ts.
 */
export interface SessionCostView {
	voiceCostUsd: number | null;
	transcriptionCostUsd: number | null;
	/** The provider bills transcription inside the session, so 0 here is a fact, not a gap. */
	transcriptionNotApplicable: boolean;
	analysisCostUsd: number | null;
	totalCostUsd: number | null;
	costPerMinuteUsd: number | null;
	totalCostUzs: number | null;
	estimated: boolean;
	unpricedReason: UnpricedReason | null;
	cachedSharePct: number | null;
	freshPromptTokens: number | null;
	cachedPromptTokens: number | null;
	freshAudioTokens: number | null;
	freshTextTokens: number | null;
	cachedAudioTokens: number | null;
	cachedTextTokens: number | null;
	analysisBilledRuns: number;
}

export interface SessionCostViewInput {
	tokens: SessionTokens;
	/** ai_sessions.provider. Empty string for a call that never ran a session. */
	provider: string;
	/** The post-call summariser's counters, or null when the call was never analysed. */
	analysis: AnalysisTokens | null;
	rates: RateTable;
	/**
	 * Session duration, for the per-minute figure. The SESSION's own measured
	 * duration where there is one - `calls.duration` also counts the ringing and the
	 * scripted greeting, which no model was billed for.
	 */
	durationMs: number | null;
}

/** A session that reported nothing at all: every counter absent, none of them zero. */
export const NO_SESSION_TOKENS: SessionTokens = {
	promptTokens: null,
	cachedPromptTokens: null,
	cachedAudioTokens: null,
	cachedTextTokens: null,
	inputTextTokens: null,
	inputAudioTokens: null,
	completionTokens: null,
	outputTextTokens: null,
	outputAudioTokens: null,
	transcribeAudioTokens: null,
	transcribeTextTokens: null,
};

export function buildSessionCostView(input: SessionCostViewInput): SessionCostView {
	const cost = priceSession(input.tokens, input.provider, input.analysis, input.rates);

	return {
		voiceCostUsd: cost.voice.costUsd,
		transcriptionCostUsd: cost.transcription.costUsd,
		transcriptionNotApplicable: cost.transcription.notApplicable,
		analysisCostUsd: cost.analysis.costUsd,
		totalCostUsd: cost.totalCostUsd,
		costPerMinuteUsd: costPerMinute(cost.totalCostUsd, input.durationMs),
		totalCostUzs: toUzs(cost.totalCostUsd, input.rates.usdToUzs),
		estimated: cost.estimated,
		unpricedReason: cost.voice.unpricedReason,
		cachedSharePct: cost.voice.cachedSharePct,
		freshPromptTokens: cost.voice.breakdown.freshPromptTokens,
		cachedPromptTokens: cost.voice.breakdown.cachedPromptTokens,
		freshAudioTokens: cost.voice.breakdown.freshAudioTokens,
		freshTextTokens: cost.voice.breakdown.freshTextTokens,
		cachedAudioTokens: cost.voice.breakdown.cachedAudioTokens,
		cachedTextTokens: cost.voice.breakdown.cachedTextTokens,
		analysisBilledRuns: cost.analysis.billedRuns,
	};
}
