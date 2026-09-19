/**
 * The only place AI cost arithmetic exists.
 *
 * Deliberately pure: no database, no settings store, no logger. The summary
 * endpoint, the per-call list and the session detail card all call these
 * functions, so a rounding choice or an apportionment rule is made once.
 *
 * TWO RULES GOVERN EVERYTHING HERE.
 *
 * 1. Cost is computed on READ and never frozen into a column. The rates are
 *    editable precisely because this system cannot verify anyone's price list,
 *    which guarantees the first numbers entered will be wrong or will go stale.
 *    With a stored cost column, fixing a rate would only fix future calls and the
 *    owner's historical total would stay permanently wrong. Computing on read
 *    means correcting a rate re-prices all history for free. Do not add an
 *    `estimated_cost_usd` column later.
 *
 * 2. Unknown is null, never zero. A session that reported no usage, or that
 *    predates the breakdown columns, has `costUsd: null` and renders as
 *    "ma'lumot yo'q". Pricing a missing breakdown as zero would quietly
 *    understate a month, and pricing a legacy row's whole prompt at the fresh
 *    rate would overstate it by roughly 10x at the measured 87% cache hit rate.
 *    Both are worse than admitting the number is not known.
 */

/** Rates are quoted per million tokens, which is how every vendor publishes them. */
const TOKENS_PER_RATE_UNIT = 1_000_000;

/**
 * Money is rounded once, here, on the way out - never between terms.
 * Six decimals is a millionth of a dollar: far below anything the page shows,
 * so it cannot change a displayed figure, but it keeps float noise like
 * 0.30000000000000004 out of the JSON.
 */
const MONEY_PRECISION = 1e6;

export function roundMoney(value: number): number {
	return Math.round(value * MONEY_PRECISION) / MONEY_PRECISION;
}

// ===========================================
// Rates
// ===========================================

/** The six rates a speech-to-speech provider needs, in USD per 1M tokens. */
export interface ProviderRates {
	textInputPer1M: number;
	textInputCachedPer1M: number;
	audioInputPer1M: number;
	audioInputCachedPer1M: number;
	textOutputPer1M: number;
	audioOutputPer1M: number;
}

export interface TranscribeRates {
	audioInputPer1M: number;
	textOutputPer1M: number;
}

export interface AnalysisRates {
	inputPer1M: number;
	cachedInputPer1M: number;
	outputPer1M: number;
}

export interface RateTable {
	/** 0 means "show dollars only" - there is no default exchange rate worth inventing. */
	usdToUzs: number;
	openaiRealtime: ProviderRates;
	geminiLive: ProviderRates;
	transcribe: TranscribeRates;
	analysis: AnalysisRates;
}

/** Provider slugs as ai_sessions.provider stores them. */
export const OPENAI_REALTIME_PROVIDER = "openai-realtime";
export const GEMINI_LIVE_PROVIDER = "gemini-live";

/**
 * The rate block for a provider slug, or null when the provider has no model
 * spend to price. `fallback-ivr` lands here: it is the scripted flow, it burns no
 * tokens, and claiming a cost of zero for it would be indistinguishable on screen
 * from a real session whose usage went missing.
 */
export function ratesForProvider(rates: RateTable, provider: string): ProviderRates | null {
	if (provider === OPENAI_REALTIME_PROVIDER) {
		return rates.openaiRealtime;
	}

	if (provider === GEMINI_LIVE_PROVIDER) {
		return rates.geminiLive;
	}

	return null;
}

/** True when every rate in the block is 0, i.e. the owner has priced nothing. */
function allZero(values: readonly number[]): boolean {
	return values.every((value) => value === 0);
}

export function isProviderPriced(rates: ProviderRates): boolean {
	return !allZero([
		rates.textInputPer1M,
		rates.textInputCachedPer1M,
		rates.audioInputPer1M,
		rates.audioInputCachedPer1M,
		rates.textOutputPer1M,
		rates.audioOutputPer1M,
	]);
}

// ===========================================
// Session voice cost
// ===========================================

/**
 * One session's token counters, straight off ai_sessions.
 *
 * Every field is nullable because the columns are: null means the provider never
 * reported that number, which is not the same as reporting zero.
 */
export interface SessionTokens {
	promptTokens: number | null;
	cachedPromptTokens: number | null;
	inputTextTokens: number | null;
	inputAudioTokens: number | null;
	/**
	 * How the cached prefix itself split across modalities, when the provider says.
	 *
	 * OpenAI Realtime reports it as `input_token_details.cached_tokens_details`
	 * and it makes the input price exact; Gemini Live does not report it, and
	 * neither does any row written before the columns existed, so null here means
	 * the split has to be apportioned - see priceVoiceSession.
	 */
	cachedAudioTokens: number | null;
	cachedTextTokens: number | null;
	completionTokens: number | null;
	outputTextTokens: number | null;
	outputAudioTokens: number | null;
	transcribeAudioTokens: number | null;
	transcribeTextTokens: number | null;
}

/** Why a session could not be priced. Rendered as a sentence, so it must be specific. */
export type UnpricedReason =
	/** Pre-migration row: totals exist but the cache and modality split does not. */
	| "no-breakdown"
	/** The session reported no usage at all - it failed before the first response. */
	| "no-usage"
	/** fallback-ivr, or a provider slug with no rate block. */
	| "provider-not-priced"
	/** Every rate for this provider is still 0. */
	| "rates-not-set";

/**
 * The input side split every way the numbers allow.
 *
 * Two independent axes cross here - cache (fresh vs cached) and modality (text vs
 * audio) - and every provider reports both MARGINALS. So
 * `freshPromptTokens + cachedPromptTokens` is the prompt total AND
 * `inputTextTokens + inputAudioTokens` is the prompt total; adding all four
 * double-counts. The UI must render them as two bars, not one five-slice stack.
 *
 * The four cells where the axes cross are reported by OpenAI Realtime
 * (`input_token_details.cached_tokens_details`, confirmed against a live
 * response.done on 2026-08-06) and by nothing else, so on the other paths they
 * are apportioned - `VoiceCost.estimated` says which.
 *
 * EVERY FIELD IS NULLABLE AND NULL MEANS NOT REPORTED. A pre-migration row has
 * no split at all: emitting `fresh = prompt` and `cached = 0` for it would state
 * that the cache never hit, which is the overstatement rule 2 above forbids.
 */
export interface VoiceCostBreakdown {
	freshPromptTokens: number | null;
	cachedPromptTokens: number | null;
	inputTextTokens: number | null;
	inputAudioTokens: number | null;
	outputTextTokens: number | null;
	outputAudioTokens: number | null;
	/** The 2x2 cells. Null until the row is priced, because pricing is what fills them. */
	freshAudioTokens: number | null;
	freshTextTokens: number | null;
	cachedAudioTokens: number | null;
	cachedTextTokens: number | null;
}

export interface VoiceCost {
	costUsd: number | null;
	unpricedReason: UnpricedReason | null;
	/**
	 * The input figure rests on an apportionment this provider does not report.
	 * False on the OpenAI path, which reports the cached cells outright, and on
	 * any cold session, where there is no cache to apportion. The output figure
	 * never rests on one - audio + text output sum to the completion total by
	 * construction.
	 */
	estimated: boolean;
	/**
	 * No modality marginals were reported at all, so the whole prompt was priced at
	 * the audio rate. A far heavier assumption than the cache apportionment: a
	 * speech-to-speech prompt is audio-dominated, so this errs towards overstating
	 * rather than understating, but it is a guess and must be labelled as one.
	 */
	modalityAssumed: boolean;
	breakdown: VoiceCostBreakdown;
	/** Cached share of the prompt, 0..100. Null when there is no prompt to divide. */
	cachedSharePct: number | null;
}

function toCount(value: number | null): number {
	return value === null || !Number.isFinite(value) || value < 0 ? 0 : value;
}

/** Sanitises a counter without inventing one: null stays null. */
function toCountOrNull(value: number | null): number | null {
	return value === null ? null : toCount(value);
}

/** True when the row carries the post-migration breakdown at all. */
function hasBreakdown(tokens: SessionTokens): boolean {
	return tokens.cachedPromptTokens !== null;
}

function hasAnyUsage(tokens: SessionTokens): boolean {
	return (
		toCount(tokens.promptTokens) > 0 ||
		toCount(tokens.completionTokens) > 0 ||
		toCount(tokens.transcribeAudioTokens) > 0 ||
		toCount(tokens.transcribeTextTokens) > 0
	);
}

/**
 * The breakdown of a row that could not be priced: exactly what it reported, and
 * nothing else.
 *
 * A pre-migration row reported no split, so its cache cells are null rather than
 * `fresh = prompt, cached = 0`. That derivation is not a conservative default, it
 * is a claim - "this call never hit the cache" - and it is the same claim that
 * prices the whole prompt at the fresh rate, roughly 10x the truth at the
 * measured 87% hit rate. Guarding it here rather than in each caller is what
 * stops the next consumer from reading a fabricated split out of an object whose
 * own cachedSharePct already says the split is unknown.
 */
function unpricedBreakdown(tokens: SessionTokens): VoiceCostBreakdown {
	const prompt = toCount(tokens.promptTokens);
	const cached = hasBreakdown(tokens) ? Math.min(toCount(tokens.cachedPromptTokens), prompt) : null;

	return {
		freshPromptTokens: cached === null ? null : prompt - cached,
		cachedPromptTokens: cached,
		inputTextTokens: toCountOrNull(tokens.inputTextTokens),
		inputAudioTokens: toCountOrNull(tokens.inputAudioTokens),
		outputTextTokens: toCountOrNull(tokens.outputTextTokens),
		outputAudioTokens: toCountOrNull(tokens.outputAudioTokens),
		// The 2x2 cells are produced by pricing. Nothing was priced here.
		freshAudioTokens: null,
		freshTextTokens: null,
		cachedAudioTokens: null,
		cachedTextTokens: null,
	};
}

function unpriced(tokens: SessionTokens, reason: UnpricedReason): VoiceCost {
	const breakdown = unpricedBreakdown(tokens);
	const prompt = toCount(tokens.promptTokens);
	const cached = breakdown.cachedPromptTokens;

	return {
		costUsd: null,
		unpricedReason: reason,
		estimated: false,
		modalityAssumed: false,
		breakdown,
		// A row that never reported a cache split has an UNKNOWN cached share, not a
		// 0% one - and "0% cached" reads as an expensive call whose cache never hit.
		cachedSharePct: cached !== null && prompt > 0 ? round1((cached / prompt) * 100) : null,
	};
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * True when the row carries the cached prompt already split by modality AND that
 * split is a consistent decomposition of the two marginals.
 *
 * Consistency is checked rather than assumed: the stored cells are sums over
 * every turn of a call, `cached` may have been clamped to the prompt total, and
 * the payload already carries a third modality these two cells do not cover
 * (`image_tokens`, 0 on every voice call but present in the live shape). Cells
 * that do not reconstruct the marginals are not a decomposition of them, so they
 * are discarded in favour of the apportionment instead of being trusted into the
 * price.
 */
function hasMeasuredCacheSplit(
	tokens: SessionTokens,
	values: { cached: number; inputAudio: number; inputText: number; prompt: number }
): boolean {
	const audio = tokens.cachedAudioTokens;
	const text = tokens.cachedTextTokens;

	if (audio === null || text === null) {
		return false;
	}

	return (
		audio >= 0 &&
		text >= 0 &&
		audio <= values.inputAudio &&
		text <= values.inputText &&
		audio + text === values.cached &&
		values.inputAudio + values.inputText === values.prompt
	);
}

/** The four input cells, and whether any of them had to be guessed. */
interface InputCells {
	freshAudio: number;
	freshText: number;
	cachedAudio: number;
	cachedText: number;
	/** Nothing here was apportioned - every cell traces to a reported number. */
	exact: boolean;
}

/**
 * Cross the cache axis with the modality axis.
 *
 * OpenAI Realtime reports the cells outright; when they are present and
 * consistent they are used verbatim and the fresh ones are the marginals minus
 * them, which makes the whole input side exact.
 *
 * With a cold cache there is no cache to apportion, so the reported marginals ARE
 * the fresh cells and no guess is needed - except for the residual. Gemini's
 * marginals do not always sum to the prompt total (a real call reported 201 audio
 * + 8505 text against a prompt of 9145), and those unaccounted tokens are charged
 * at the text rate: in practice they are the system instructions and tool schemas,
 * and text is the cheaper of the two, so this cannot inflate a bill. It is still a
 * guess, which is why a residual makes the row inexact.
 *
 * Everywhere else this is the single judgement call in the file:
 *
 *   audioShare  = audio / (audio + text)          <- the reported marginals
 *   freshAudio  = fresh * audioShare              <- estimated
 *   cachedAudio = cached * audioShare             <- estimated
 *
 * audioShare comes from the modality marginals rather than from the prompt total,
 * because the prompt total also contains the cached prefix - dividing by it would
 * silently shrink the share whenever the cache was warm. With no marginals at all
 * the share is 1, i.e. the prompt is treated as pure audio; `modalityAssumed` on
 * the way out is what says so.
 */
function splitInput(
	tokens: SessionTokens,
	values: { cached: number; fresh: number; inputAudio: number; inputText: number; prompt: number }
): InputCells {
	const { cached, fresh, inputAudio, inputText } = values;

	if (hasMeasuredCacheSplit(tokens, values)) {
		const cachedAudio = tokens.cachedAudioTokens ?? 0;
		const cachedText = tokens.cachedTextTokens ?? 0;

		return {
			freshAudio: inputAudio - cachedAudio,
			freshText: inputText - cachedText,
			cachedAudio,
			cachedText,
			exact: true,
		};
	}

	const modalityTotal = inputAudio + inputText;

	// Cold cache: everything is fresh, so the marginals need no apportioning. Only
	// the residual the marginals do not account for is a guess.
	if (values.cached === 0 && modalityTotal > 0) {
		const residual = Math.max(0, values.prompt - modalityTotal);

		return {
			freshAudio: inputAudio,
			freshText: inputText + residual,
			cachedAudio: 0,
			cachedText: 0,
			exact: residual === 0,
		};
	}

	const audioShare = modalityTotal > 0 ? inputAudio / modalityTotal : 1;
	const freshAudio = fresh * audioShare;
	const cachedAudio = cached * audioShare;

	return {
		freshAudio,
		freshText: fresh - freshAudio,
		cachedAudio,
		cachedText: cached - cachedAudio,
		exact: false,
	};
}

/** The output split. Audio + text sum to the completion total by construction. */
interface OutputCells {
	audio: number;
	text: number;
	/** Neither side was reported, so the whole completion is charged as audio. */
	assumed: boolean;
}

function splitOutput(tokens: SessionTokens): OutputCells {
	const completion = toCount(tokens.completionTokens);
	const audio = toCount(tokens.outputAudioTokens);
	const text = toCount(tokens.outputTextTokens);

	if (completion > 0 && audio + text === 0) {
		return { audio: completion, text: 0, assumed: true };
	}

	return { audio, text, assumed: false };
}

/** Price one session's voice traffic. */
export function priceVoiceSession(
	tokens: SessionTokens,
	provider: string,
	rates: RateTable
): VoiceCost {
	if (!hasAnyUsage(tokens)) {
		return unpriced(tokens, "no-usage");
	}

	if (!hasBreakdown(tokens)) {
		return unpriced(tokens, "no-breakdown");
	}

	const providerRates = ratesForProvider(rates, provider);

	if (providerRates === null) {
		return unpriced(tokens, "provider-not-priced");
	}

	if (!isProviderPriced(providerRates)) {
		return unpriced(tokens, "rates-not-set");
	}

	const prompt = toCount(tokens.promptTokens);
	const cached = Math.min(toCount(tokens.cachedPromptTokens), prompt);
	const fresh = prompt - cached;
	const inputAudio = toCount(tokens.inputAudioTokens);
	const inputText = toCount(tokens.inputTextTokens);

	// No modality marginals: the prompt is assumed to be all audio, which is true of
	// a voice call to a first approximation and overstates rather than understates.
	const modalityAssumed = prompt > 0 && inputAudio + inputText === 0;
	const input = splitInput(tokens, { cached, fresh, inputAudio, inputText, prompt });
	const output = splitOutput(tokens);

	const inputCost =
		(input.freshAudio * providerRates.audioInputPer1M +
			input.freshText * providerRates.textInputPer1M +
			input.cachedAudio * providerRates.audioInputCachedPer1M +
			input.cachedText * providerRates.textInputCachedPer1M) /
		TOKENS_PER_RATE_UNIT;

	const outputCost =
		(output.audio * providerRates.audioOutputPer1M + output.text * providerRates.textOutputPer1M) /
		TOKENS_PER_RATE_UNIT;

	return {
		costUsd: roundMoney(inputCost + outputCost),
		unpricedReason: null,
		// True whenever any input cell was apportioned rather than reported - the
		// cache split, the modality split, or prompt tokens the marginals left out.
		estimated: !input.exact || modalityAssumed || output.assumed,
		modalityAssumed: modalityAssumed || output.assumed,
		breakdown: {
			freshPromptTokens: fresh,
			cachedPromptTokens: cached,
			inputTextTokens: inputText,
			inputAudioTokens: inputAudio,
			outputTextTokens: output.text,
			outputAudioTokens: output.audio,
			freshAudioTokens: Math.round(input.freshAudio),
			freshTextTokens: Math.round(input.freshText),
			cachedAudioTokens: Math.round(input.cachedAudio),
			cachedTextTokens: Math.round(input.cachedText),
		},
		cachedSharePct: prompt > 0 ? round1((cached / prompt) * 100) : null,
	};
}

// ===========================================
// Transcription
// ===========================================

export interface TranscriptionCost {
	costUsd: number | null;
	audioTokens: number;
	textTokens: number;
	/** The provider bills transcription inside the session, so there is no separate line. */
	notApplicable: boolean;
}

/**
 * Input transcription, which OpenAI bills as its own model (gpt-4o-transcribe).
 *
 * Gemini transcribes inside the Live session with no separate charge, so a Gemini
 * row contributes a true 0 rather than an unknown. A pre-migration row of either
 * provider contributes an unknown, because nothing was recorded.
 */
export function priceTranscription(
	tokens: SessionTokens,
	provider: string,
	rates: RateTable
): TranscriptionCost {
	const audio = toCount(tokens.transcribeAudioTokens);
	const text = toCount(tokens.transcribeTextTokens);
	const neverRecorded =
		tokens.transcribeAudioTokens === null && tokens.transcribeTextTokens === null;

	if (provider === GEMINI_LIVE_PROVIDER) {
		return { costUsd: 0, audioTokens: 0, textTokens: 0, notApplicable: true };
	}

	if (neverRecorded) {
		return { costUsd: null, audioTokens: 0, textTokens: 0, notApplicable: false };
	}

	const costUsd =
		(audio * rates.transcribe.audioInputPer1M + text * rates.transcribe.textOutputPer1M) /
		TOKENS_PER_RATE_UNIT;

	return {
		costUsd: roundMoney(costUsd),
		audioTokens: audio,
		textTokens: text,
		notApplicable: false,
	};
}

// ===========================================
// Post-call analysis
// ===========================================

export interface AnalysisTokens {
	promptTokens: number;
	cachedPromptTokens: number;
	completionTokens: number;
	/** Runs that actually called the API. Not retryCount, which also counts free failures. */
	billedRuns: number;
}

export interface AnalysisCost {
	costUsd: number | null;
	billedRuns: number;
	promptTokens: number;
	cachedPromptTokens: number;
	completionTokens: number;
}

/**
 * The gpt-4o-mini summary, whose counters accumulate across retries.
 *
 * billedRuns === 0 is ambiguous - either the call was never analysed, or it was
 * analysed before these columns existed - so it prices as unknown rather than as
 * zero. Callers that need the difference read ai_analyses.status alongside it.
 */
export function priceAnalysis(tokens: AnalysisTokens | null, rates: RateTable): AnalysisCost {
	if (tokens === null || tokens.billedRuns <= 0) {
		return {
			costUsd: null,
			billedRuns: tokens?.billedRuns ?? 0,
			promptTokens: 0,
			cachedPromptTokens: 0,
			completionTokens: 0,
		};
	}

	const cached = Math.min(toCount(tokens.cachedPromptTokens), toCount(tokens.promptTokens));
	const fresh = toCount(tokens.promptTokens) - cached;
	const costUsd =
		(fresh * rates.analysis.inputPer1M +
			cached * rates.analysis.cachedInputPer1M +
			toCount(tokens.completionTokens) * rates.analysis.outputPer1M) /
		TOKENS_PER_RATE_UNIT;

	return {
		costUsd: roundMoney(costUsd),
		billedRuns: tokens.billedRuns,
		promptTokens: toCount(tokens.promptTokens),
		cachedPromptTokens: cached,
		completionTokens: toCount(tokens.completionTokens),
	};
}

// ===========================================
// One row's total
// ===========================================

export interface SessionCost {
	voice: VoiceCost;
	transcription: TranscriptionCost;
	analysis: AnalysisCost;
	/**
	 * Voice + transcription + analysis, or null when the voice line is unknown.
	 *
	 * An unknown voice cost makes the total meaningless, so it propagates. An
	 * unknown transcription or analysis line does not: it is a small addend next to
	 * a known voice figure, so it is treated as 0 and `partial` says so.
	 */
	totalCostUsd: number | null;
	/** A known line was omitted from the total because it could not be priced. */
	partial: boolean;
	estimated: boolean;
}

export function priceSession(
	tokens: SessionTokens,
	provider: string,
	analysis: AnalysisTokens | null,
	rates: RateTable
): SessionCost {
	const voice = priceVoiceSession(tokens, provider, rates);
	const transcription = priceTranscription(tokens, provider, rates);
	const analysisCost = priceAnalysis(analysis, rates);
	const partial = transcription.costUsd === null || analysisCost.costUsd === null;

	if (voice.costUsd === null) {
		return {
			voice,
			transcription,
			analysis: analysisCost,
			totalCostUsd: null,
			partial,
			estimated: false,
		};
	}

	const total = voice.costUsd + (transcription.costUsd ?? 0) + (analysisCost.costUsd ?? 0);

	return {
		voice,
		transcription,
		analysis: analysisCost,
		totalCostUsd: roundMoney(total),
		partial,
		estimated: voice.estimated,
	};
}

// ===========================================
// Currency
// ===========================================

/** Null when no exchange rate is configured - an invented rate is worse than none. */
export function toUzs(usd: number | null, usdToUzs: number): number | null {
	if (usd === null || usdToUzs <= 0) {
		return null;
	}

	return Math.round(usd * usdToUzs);
}

/** Per-minute cost. Null when there is no duration to divide by. */
export function costPerMinute(costUsd: number | null, durationMs: number | null): number | null {
	if (costUsd === null || durationMs === null || durationMs <= 0) {
		return null;
	}

	return roundMoney(costUsd / (durationMs / 60_000));
}
