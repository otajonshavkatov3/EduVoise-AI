/**
 * Mirrors apps/backend/src/routes/ai-costs/ai-costs.schemas.ts.
 *
 * EVERY `number | null` HERE MEANS "NOT KNOWN". Null is never a zero. A session
 * that reported no usage, or that predates the breakdown columns, has no cost
 * and must render as "ma'lumot yo'q" - showing 0 so'm for it would understate
 * the month and look like a measurement.
 */

export type GroupBy = "day" | "week" | "month";

export type CostSort = "cost" | "duration" | "startedAt";

/** Why a session has no price. Rendered through UNPRICED_REASON_LABELS. */
export type UnpricedReason = "no-usage" | "no-breakdown" | "provider-not-priced" | "rates-not-set";

export interface TokenBuckets {
	/** Raw totals - present on every session, legacy rows included. */
	promptTokens: number;
	completionTokens: number;
	/** How many sessions the split below covers. May be fewer than the session count. */
	breakdownSessions: number;
	cachedPromptTokens: number;
	freshPromptTokens: number;
	inputTextTokens: number;
	inputAudioTokens: number;
	outputTextTokens: number;
	outputAudioTokens: number;
	responseTurns: number;
	cachedSharePct: number | null;
	costUsd: number | null;
	estimated: boolean;
}

export interface TranscriptionBucket {
	audioTokens: number;
	textTokens: number;
	costUsd: number | null;
	notApplicableSessions: number;
}

export interface AnalysisBucket {
	billedRuns: number;
	promptTokens: number;
	cachedPromptTokens: number;
	completionTokens: number;
	costUsd: number | null;
	unmeasuredAnalyses: number;
}

export interface CostRange {
	from: string;
	to: string;
	days: number;
	groupBy: GroupBy;
	/**
	 * Diagramma ustunlari qaysi mintaqa bo'yicha kunlarga bo'lingani
	 * (general.timezone). Kun chegarasi UTC bo'yicha kesilsa, UTC+5 da yarim
	 * tundan 05:00 gacha bo'lgan qo'ng'iroqlar oldingi kunga tushib qolardi.
	 */
	timeZone: string;
}

export interface PricingStatus {
	configured: boolean;
	/** Rates nobody has confirmed - still the shipped defaults. */
	unreviewedCount: number;
	zeroKeys: string[];
	lastReviewedAt: string | null;
	usdToUzs: number;
}

export interface CostTotals {
	sessions: number;
	pricedSessions: number;
	unpricedSessions: number;
	legacySessions: number;
	callSeconds: number;
	pricedCallSeconds: number;
	voice: TokenBuckets;
	transcription: TranscriptionBucket;
	analysis: AnalysisBucket;
	costUsd: number | null;
	costUzs: number | null;
	costPerCallUsd: number | null;
	costPerMinuteUsd: number | null;
}

export interface ProviderSplitRow {
	provider: string;
	model: string | null;
	sessions: number;
	pricedSessions: number;
	callSeconds: number;
	voice: TokenBuckets;
	transcription: TranscriptionBucket;
	analysis: AnalysisBucket;
	costUsd: number | null;
	costPerMinuteUsd: number | null;
}

export interface CostSeriesPoint {
	bucket: string;
	sessions: number;
	voiceCostUsd: number | null;
	transcriptionCostUsd: number | null;
	analysisCostUsd: number | null;
	costUsd: number | null;
}

export interface CostSummary {
	range: CostRange;
	pricing: PricingStatus;
	totals: CostTotals;
	byProvider: ProviderSplitRow[];
	series: CostSeriesPoint[];
	estimateNotes: string[];
}

export interface CostSummaryResponse {
	success: true;
	data: CostSummary;
}

export interface CostCallRow {
	sessionId: string;
	callId: string;
	startedAt: string;
	callerNumber: string;
	durationMs: number | null;
	provider: string;
	model: string | null;
	responseTurns: number | null;
	promptTokens: number | null;
	cachedPromptTokens: number | null;
	cachedSharePct: number | null;
	completionTokens: number | null;
	outputAudioTokens: number | null;
	voiceCostUsd: number | null;
	transcriptionCostUsd: number | null;
	analysisCostUsd: number | null;
	totalCostUsd: number | null;
	costPerMinuteUsd: number | null;
	estimated: boolean;
	unpricedReason: UnpricedReason | null;
}

export interface PaginationMeta {
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

export interface CostCallsResponse {
	success: true;
	data: {
		items: CostCallRow[];
		meta: PaginationMeta;
	};
}

export interface RateItem {
	key: string;
	label: string;
	value: number;
	/** Nobody has confirmed this rate; it is the value the platform shipped with. */
	isDefault: boolean;
}

export interface ObservedModel {
	provider: string;
	model: string | null;
}

export interface CostRatesResponse {
	success: true;
	data: {
		pricing: PricingStatus;
		items: RateItem[];
		observedModels: ObservedModel[];
	};
}

export interface CostSummaryFilters {
	from: string;
	to: string;
	groupBy: GroupBy;
}

export interface CostCallsFilters {
	from: string;
	to: string;
	provider?: string;
	sort: CostSort;
	page: number;
	limit: number;
}
