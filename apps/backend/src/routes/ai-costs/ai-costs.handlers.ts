/**
 * AI cost reporting.
 *
 * COST IS COMPUTED HERE, ON READ, AND IS NEVER STORED. The rates are editable
 * because nothing in this system can verify a vendor's price list, so the first
 * numbers entered will be wrong or will go stale. A stored cost column would mean
 * correcting a rate only fixes future calls while the owner's historical total
 * stays permanently wrong; computing on read re-prices all history the moment a
 * rate is corrected. Do not add an `estimated_cost_usd` column later.
 *
 * All the arithmetic lives in lib/ai-cost/price.ts. This file only fetches rows,
 * feeds them through it, and adds up the results.
 */
import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { aiAnalyses, aiSessions, calls } from "@/db/schema";
import {
	type AnalysisTokens,
	costPerMinute,
	loadRates,
	PRICING_KEYS,
	priceSession,
	type RateTable,
	roundMoney,
	type SessionCost,
	type SessionTokens,
	toUzs,
	type VoiceCostBreakdown,
} from "@/lib/ai-cost";
import { businessError, invalidInput } from "@/lib/errors";
import { getSetting, getSettingDefinition } from "@/lib/settings";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type * as r from "./ai-costs.routes";
import {
	type AnalysisBucket,
	type CostCallRow,
	type CostSeriesPoint,
	type GroupBy,
	MAX_RANGE_DAYS,
	type PricingStatus,
	type ProviderSplitRow,
	type TokenBuckets,
	type TranscriptionBucket,
} from "./ai-costs.schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

interface ResolvedRange {
	start: Date;
	end: Date;
	days: number;
}

function resolveRange(from: string, to: string): ResolvedRange {
	const start = new Date(from);
	const end = new Date(to);

	if (Number.isNaN(start.getTime())) {
		throw invalidInput("from", "ISO sana-vaqt formati kutilgan");
	}
	if (Number.isNaN(end.getTime())) {
		throw invalidInput("to", "ISO sana-vaqt formati kutilgan");
	}
	if (end.getTime() <= start.getTime()) {
		throw invalidInput("to", "'to' qiymati 'from' dan keyin bo'lishi kerak");
	}

	const days = Math.ceil((end.getTime() - start.getTime()) / DAY_MS);

	if (days > MAX_RANGE_DAYS) {
		throw businessError(`Oraliq eng ko'pi bilan ${MAX_RANGE_DAYS} kun bo'lishi mumkin`, [
			{ field: "from/to", reason: `So'ralgan oraliq: ${days} kun` },
		]);
	}

	return { start, end, days };
}

// ===========================================
// Row loading
// ===========================================

/**
 * ai_sessions with the call it belongs to and, when one exists, the post-call
 * analysis of that same call.
 *
 * ai_analyses joins on call_id rather than session id because an analysis can
 * outlive - or precede - any AI session on the call.
 */
const sessionColumns = {
	sessionId: aiSessions.id,
	callId: aiSessions.callId,
	provider: aiSessions.provider,
	model: aiSessions.model,
	startedAt: aiSessions.startedAt,
	durationMs: aiSessions.durationMs,
	promptTokens: aiSessions.promptTokens,
	cachedPromptTokens: aiSessions.cachedPromptTokens,
	cachedAudioTokens: aiSessions.cachedAudioTokens,
	cachedTextTokens: aiSessions.cachedTextTokens,
	inputTextTokens: aiSessions.inputTextTokens,
	inputAudioTokens: aiSessions.inputAudioTokens,
	completionTokens: aiSessions.completionTokens,
	outputTextTokens: aiSessions.outputTextTokens,
	outputAudioTokens: aiSessions.outputAudioTokens,
	responseTurns: aiSessions.responseTurns,
	transcribeAudioTokens: aiSessions.transcribeAudioTokens,
	transcribeTextTokens: aiSessions.transcribeTextTokens,
	callerNumber: calls.callerNumber,
	callDuration: calls.duration,
	analysisModel: aiAnalyses.analysisModel,
	analysisPromptTokens: aiAnalyses.promptTokens,
	analysisCachedPromptTokens: aiAnalyses.cachedPromptTokens,
	analysisCompletionTokens: aiAnalyses.completionTokens,
	analysisBilledRuns: aiAnalyses.billedRuns,
	// Needed to tell "we did not record what this analysis cost" apart from "this
	// analysis failed and produced nothing", which have the same billedRuns of 0.
	analysisStatus: aiAnalyses.status,
};

/**
 * EVERY LEG OF THIS JOIN CARRIES THE TENANT, not just the driving table.
 *
 * Scoping `ai_sessions` alone would look scoped and read correctly today, because
 * a call's session shares its call's tenant. It is written out on all three
 * anyway: an FK does not enforce tenant equality (nothing in the schema does), so
 * the day a child row is written with the wrong tenant - a bug in a writer, a
 * botched backfill, a vendor script - a one-sided join is what turns that single
 * bad row into another customer's caller number and spend appearing on this page.
 * The joined predicates make the query return nothing instead.
 */
function loadSessions(tenantId: TenantId, where: SQL | undefined) {
	return db
		.select(sessionColumns)
		.from(aiSessions)
		.innerJoin(calls, and(eq(aiSessions.callId, calls.id), eq(calls.tenantId, tenantId)))
		.leftJoin(
			aiAnalyses,
			and(eq(aiAnalyses.callId, aiSessions.callId), eq(aiAnalyses.tenantId, tenantId))
		)
		.where(tenantWhere(aiSessions, tenantId, where));
}

type SessionRow = Awaited<ReturnType<typeof loadSessions>>[number];

function rangeCondition(range: ResolvedRange): SQL | undefined {
	return and(gte(aiSessions.startedAt, range.start), lte(aiSessions.startedAt, range.end));
}

function toSessionTokens(row: SessionRow): SessionTokens {
	return {
		promptTokens: row.promptTokens,
		cachedPromptTokens: row.cachedPromptTokens,
		cachedAudioTokens: row.cachedAudioTokens,
		cachedTextTokens: row.cachedTextTokens,
		inputTextTokens: row.inputTextTokens,
		inputAudioTokens: row.inputAudioTokens,
		completionTokens: row.completionTokens,
		outputTextTokens: row.outputTextTokens,
		outputAudioTokens: row.outputAudioTokens,
		transcribeAudioTokens: row.transcribeAudioTokens,
		transcribeTextTokens: row.transcribeTextTokens,
	};
}

function toAnalysisTokens(row: {
	analysisBilledRuns: number | null;
	analysisPromptTokens: number | null;
	analysisCachedPromptTokens: number | null;
	analysisCompletionTokens: number | null;
}): AnalysisTokens | null {
	if (row.analysisBilledRuns === null) {
		return null;
	}

	return {
		promptTokens: row.analysisPromptTokens ?? 0,
		cachedPromptTokens: row.analysisCachedPromptTokens ?? 0,
		completionTokens: row.analysisCompletionTokens ?? 0,
		billedRuns: row.analysisBilledRuns,
	};
}

/** Sessions have a measured duration; fall back to the call's own second count. */
function sessionDurationMs(row: {
	durationMs: number | null;
	callDuration: number | null;
}): number | null {
	if (row.durationMs !== null && row.durationMs > 0) {
		return row.durationMs;
	}

	return row.callDuration !== null && row.callDuration > 0 ? row.callDuration * 1000 : null;
}

// ===========================================
// Accumulators
// ===========================================

/**
 * A running total that knows the difference between "nothing yet" and "zero".
 *
 * `known` flips true the first time a real number is added. A bucket that never
 * saw one reports null, which is what keeps a month with no priced sessions from
 * displaying as $0.00.
 */
export class Money {
	private total = 0;
	private known = false;

	add(value: number | null): void {
		if (value === null) {
			return;
		}

		this.total += value;
		this.known = true;
	}

	get value(): number | null {
		return this.known ? roundMoney(this.total) : null;
	}
}

/**
 * Token counters, split by how much is actually known about the row.
 *
 * `promptTokens` and `completionTokens` are the raw totals and exist on every
 * row, legacy ones included. Everything else is the SPLIT, which only
 * post-migration rows carry - so it is accumulated from those rows alone and
 * `breakdownSessions` says how many that was. Folding a legacy row into the split
 * would book its entire prompt as fresh, uncached audio, which is precisely the
 * ~10x overstatement this feature exists to avoid.
 */
interface VoiceAccumulator {
	promptTokens: number;
	completionTokens: number;
	breakdownSessions: number;
	/** Prompt total of the breakdown rows only - the denominator for the cached share. */
	breakdownPromptTokens: number;
	cachedPromptTokens: number;
	freshPromptTokens: number;
	inputTextTokens: number;
	inputAudioTokens: number;
	outputTextTokens: number;
	outputAudioTokens: number;
	responseTurns: number;
	cost: Money;
	estimated: boolean;
}

export interface Accumulator {
	sessions: number;
	pricedSessions: number;
	unpricedSessions: number;
	legacySessions: number;
	callSeconds: number;
	/**
	 * Duration of the priced sessions only.
	 *
	 * The denominator for cost-per-minute has to cover exactly the sessions the
	 * numerator covers. Dividing priced money by every session's duration - legacy
	 * rows included - understates the rate by the share of calls that could not be
	 * priced, which on a mostly-legacy month is an order of magnitude.
	 */
	pricedCallSeconds: number;
	voice: VoiceAccumulator;
	transcription: {
		audioTokens: number;
		textTokens: number;
		cost: Money;
		notApplicableSessions: number;
	};
	analysis: {
		billedRuns: number;
		promptTokens: number;
		cachedPromptTokens: number;
		completionTokens: number;
		cost: Money;
		unmeasuredAnalyses: number;
		failedAnalyses: number;
	};
	/** Every line of money that is known, whatever else on its session is not. */
	total: Money;
	/**
	 * The subtotal of the sessions whose voice line could be priced.
	 *
	 * The numerator of an average has to cover exactly the rows its denominator
	 * counts, and both averages divide by priced sessions / priced minutes. `total`
	 * is deliberately wider than that - it also carries the analysis and
	 * transcription spend of sessions whose voice line is unknown - so it is the
	 * headline figure and this is what the averages use.
	 */
	pricedTotal: Money;
}

/**
 * The columns `accumulate` reads off a session row.
 *
 * Declared structurally rather than as `SessionRow` so the fold - which is where
 * the summary's money and token totals are actually decided - can be exercised
 * from a unit test without a database. `SessionRow` satisfies it.
 */
export interface AccumulableRow {
	promptTokens: number | null;
	completionTokens: number | null;
	responseTurns: number | null;
	durationMs: number | null;
	callDuration: number | null;
	analysisBilledRuns: number | null;
	analysisStatus: string | null;
}

export function createAccumulator(): Accumulator {
	return {
		sessions: 0,
		pricedSessions: 0,
		unpricedSessions: 0,
		legacySessions: 0,
		callSeconds: 0,
		pricedCallSeconds: 0,
		voice: {
			promptTokens: 0,
			completionTokens: 0,
			breakdownSessions: 0,
			breakdownPromptTokens: 0,
			cachedPromptTokens: 0,
			freshPromptTokens: 0,
			inputTextTokens: 0,
			inputAudioTokens: 0,
			outputTextTokens: 0,
			outputAudioTokens: 0,
			responseTurns: 0,
			cost: new Money(),
			estimated: false,
		},
		transcription: { audioTokens: 0, textTokens: 0, cost: new Money(), notApplicableSessions: 0 },
		analysis: {
			billedRuns: 0,
			promptTokens: 0,
			cachedPromptTokens: 0,
			completionTokens: 0,
			cost: new Money(),
			unmeasuredAnalyses: 0,
			failedAnalyses: 0,
		},
		total: new Money(),
		pricedTotal: new Money(),
	};
}

/**
 * Add one session's token split to a bucket - and nothing at all if it has none.
 *
 * Read off the priced object rather than off the row: a breakdown is present only
 * when every cell of it is, and the null is what says so. Folding a legacy row in
 * here would book its entire prompt as fresh, uncached audio, which is the ~10x
 * overstatement the whole feature exists to avoid.
 */
function accumulateVoiceSplit(
	voice: VoiceAccumulator,
	breakdown: VoiceCostBreakdown,
	responseTurns: number | null
): void {
	if (breakdown.freshPromptTokens === null || breakdown.cachedPromptTokens === null) {
		return;
	}

	voice.breakdownSessions += 1;
	voice.breakdownPromptTokens += breakdown.freshPromptTokens + breakdown.cachedPromptTokens;
	voice.cachedPromptTokens += breakdown.cachedPromptTokens;
	voice.freshPromptTokens += breakdown.freshPromptTokens;
	voice.inputTextTokens += breakdown.inputTextTokens ?? 0;
	voice.inputAudioTokens += breakdown.inputAudioTokens ?? 0;
	voice.outputTextTokens += breakdown.outputTextTokens ?? 0;
	voice.outputAudioTokens += breakdown.outputAudioTokens ?? 0;
	voice.responseTurns += responseTurns ?? 0;
}

/**
 * Add one session's money to a bucket, line by line, wherever that line is known.
 *
 * The post-call analysis and the transcription are separate models on separate
 * price lists, so an unpriceable voice line says nothing about them: dropping
 * their spend because the voice line is legacy hid every re-analysis this month
 * from the headline while still showing it per call. `Money` is what keeps that
 * safe - a bucket that only ever saw nulls reports null, not $0.00.
 */
function accumulateMoney(acc: Accumulator, cost: SessionCost, priced: boolean): void {
	// Same reason the structural zero is kept out of acc.total below: a Gemini row
	// bills no separate transcription, so letting its 0 into the bucket would report
	// a measured "$0.00 transcription" for a window whose transcription spend is
	// mostly unknown. notApplicableSessions is what carries that fact instead.
	if (!cost.transcription.notApplicable) {
		acc.transcription.cost.add(cost.transcription.costUsd);
	}

	acc.analysis.cost.add(cost.analysis.costUsd);

	if (priced) {
		acc.voice.cost.add(cost.voice.costUsd);
		acc.voice.estimated = acc.voice.estimated || cost.voice.estimated;
		// Already voice + transcription + analysis for this row.
		acc.total.add(cost.totalCostUsd);
		acc.pricedTotal.add(cost.totalCostUsd);

		return;
	}

	// cost.totalCostUsd is null here by construction, so the known lines are added
	// on their own rather than through it. `notApplicable` is skipped: Gemini bills
	// no separate transcription at all, and letting that structural zero through
	// would turn an unknown month into a headline "$0.00".
	if (!cost.transcription.notApplicable) {
		acc.total.add(cost.transcription.costUsd);
	}

	acc.total.add(cost.analysis.costUsd);
}

/**
 * Fold one session into a bucket.
 *
 * The token SPLIT is only added for sessions that reported one. Raw prompt and
 * completion totals are added for every session, because those two numbers exist
 * on every row. The money is folded by accumulateMoney above.
 */
export function accumulate(acc: Accumulator, row: AccumulableRow, cost: SessionCost): void {
	acc.sessions += 1;

	const durationMs = sessionDurationMs(row);
	const seconds = durationMs === null ? 0 : Math.round(durationMs / 1000);

	acc.callSeconds += seconds;

	const priced = cost.voice.costUsd !== null;

	if (priced) {
		acc.pricedSessions += 1;
		acc.pricedCallSeconds += seconds;
	} else {
		acc.unpricedSessions += 1;

		if (cost.voice.unpricedReason === "no-breakdown") {
			acc.legacySessions += 1;
		}
	}

	// Raw totals: present on legacy rows too, so they are always reportable.
	acc.voice.promptTokens += row.promptTokens ?? 0;
	acc.voice.completionTokens += row.completionTokens ?? 0;

	accumulateVoiceSplit(acc.voice, cost.voice.breakdown, row.responseTurns);

	acc.transcription.audioTokens += cost.transcription.audioTokens;
	acc.transcription.textTokens += cost.transcription.textTokens;

	if (cost.transcription.notApplicable) {
		acc.transcription.notApplicableSessions += 1;
	}

	acc.analysis.billedRuns += cost.analysis.billedRuns;
	acc.analysis.promptTokens += cost.analysis.promptTokens;
	acc.analysis.cachedPromptTokens += cost.analysis.cachedPromptTokens;
	acc.analysis.completionTokens += cost.analysis.completionTokens;

	// billedRuns 0 means two different things. An analysis that ran before the token
	// columns existed cost real money nobody recorded; one that failed produced
	// nothing and cost nothing worth reporting. Counting them together would tell the
	// owner that money is missing when it is not.
	if (row.analysisBilledRuns === 0) {
		if (row.analysisStatus === "failed") {
			acc.analysis.failedAnalyses += 1;
		} else {
			acc.analysis.unmeasuredAnalyses += 1;
		}
	}

	accumulateMoney(acc, cost, priced);
}

function toVoiceBucket(voice: VoiceAccumulator): TokenBuckets {
	return {
		promptTokens: voice.promptTokens,
		completionTokens: voice.completionTokens,
		breakdownSessions: voice.breakdownSessions,
		cachedPromptTokens: voice.cachedPromptTokens,
		freshPromptTokens: voice.freshPromptTokens,
		inputTextTokens: voice.inputTextTokens,
		inputAudioTokens: voice.inputAudioTokens,
		outputTextTokens: voice.outputTextTokens,
		outputAudioTokens: voice.outputAudioTokens,
		responseTurns: voice.responseTurns,
		// Measured over the rows that actually reported a cache split. Dividing by
		// every prompt token would report 0% cached for a legacy month, which reads
		// as "the cache never hits" rather than "this was never recorded".
		cachedSharePct:
			voice.breakdownPromptTokens > 0
				? Math.round((voice.cachedPromptTokens / voice.breakdownPromptTokens) * 1000) / 10
				: null,
		costUsd: voice.cost.value,
		estimated: voice.estimated,
	};
}

function toTranscriptionBucket(acc: Accumulator): TranscriptionBucket {
	return {
		audioTokens: acc.transcription.audioTokens,
		textTokens: acc.transcription.textTokens,
		costUsd: acc.transcription.cost.value,
		notApplicableSessions: acc.transcription.notApplicableSessions,
	};
}

function toAnalysisBucket(acc: Accumulator): AnalysisBucket {
	return {
		billedRuns: acc.analysis.billedRuns,
		promptTokens: acc.analysis.promptTokens,
		cachedPromptTokens: acc.analysis.cachedPromptTokens,
		completionTokens: acc.analysis.completionTokens,
		costUsd: acc.analysis.cost.value,
		unmeasuredAnalyses: acc.analysis.unmeasuredAnalyses,
		failedAnalyses: acc.analysis.failedAnalyses,
	};
}

// ===========================================
// Grouping
// ===========================================

/**
 * The organisation's zone, which is where a "day" is a day.
 *
 * `general.timezone` is defined in the registry as the setting daily report
 * boundaries are computed in, and the same zone has to cut the trend chart:
 * truncating in UTC on a UTC+5 deployment books every call between midnight and
 * 05:00 onto the previous calendar day, which on the page's own default range
 * moved 8 of 26 sessions - and their money - into the wrong bar.
 */
const FALLBACK_TIME_ZONE = "Asia/Tashkent";

async function resolveTimeZone(tenantId: TenantId): Promise<string> {
	const configured = await getSetting(tenantId, "general.timezone");

	if (configured.trim().length === 0) {
		return FALLBACK_TIME_ZONE;
	}

	try {
		// A zone the runtime does not know would throw once per row below. Built
		// through the cache so the validated formatter is the one the fold reuses.
		zoneFormatter(configured).format(new Date());

		return configured;
	} catch {
		return FALLBACK_TIME_ZONE;
	}
}

/**
 * One formatter per zone, not one per row.
 *
 * bucketKey runs once for every session in the window and the handler prices a
 * whole range in memory (up to MAX_RANGE_DAYS), so constructing the formatter
 * inside it made the fold ~19x slower than it needed to be. The map is bounded by
 * the number of distinct zones a deployment configures, i.e. one.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
	const cached = zoneFormatters.get(timeZone);

	if (cached !== undefined) {
		return cached;
	}

	const created = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	zoneFormatters.set(timeZone, created);

	return created;
}

/** The calendar date this instant falls on in `timeZone`, as {year, month, day}. */
function zonedDate(date: Date, timeZone: string): { year: number; month: number; day: number } {
	const parts = zoneFormatter(timeZone).formatToParts(date);
	const pick = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((part) => part.type === type)?.value ?? "0");

	return { year: pick("year"), month: pick("month"), day: pick("day") };
}

/** ISO date of the bucket a timestamp falls in, in the tenant's zone. Weeks start Monday. */
export function bucketKey(date: Date, groupBy: GroupBy, timeZone: string): string {
	const { year, month, day } = zonedDate(date, timeZone);
	// The zoned wall-clock date re-expressed as UTC midnight: from here on the
	// weekday and month arithmetic is plain calendar arithmetic with no zone left
	// in it, so a DST-shifted week boundary cannot slip a day.
	const value = new Date(Date.UTC(year, month - 1, day));

	if (groupBy === "month") {
		value.setUTCDate(1);
	} else if (groupBy === "week") {
		// getUTCDay(): 0 = Sunday. Shift so Monday is the start of the week.
		const weekday = (value.getUTCDay() + 6) % 7;

		value.setUTCDate(value.getUTCDate() - weekday);
	}

	return value.toISOString().slice(0, 10);
}

// ===========================================
// Notes
// ===========================================

/**
 * The limits of every figure on the page, in Uzbek.
 *
 * These are not decoration. The brief is that no estimate may be presented as a
 * measurement, and several of the numbers here rest on apportionments the
 * providers do not report. Only notes that actually apply to the loaded range are
 * returned, so the list stays short enough to be read.
 */
function buildEstimateNotes(acc: Accumulator, pricing: PricingStatus): string[] {
	const notes: string[] = [];

	if (pricing.unreviewedCount > 0) {
		notes.push(
			`${pricing.unreviewedCount} ta narx hali tasdiqlanmagan — oldindan kiritilgan standart qiymat ishlatilmoqda. ` +
				"Sozlamalar → Narxlar bo'limida o'z hisob-fakturangiz bo'yicha tekshiring."
		);
	}

	if (acc.voice.estimated) {
		notes.push(
			"Keshdan olingan tokenlarning matn/audio nisbatini provayder bermaydi — u e'lon qilingan " +
				"ulushlar asosida taqsimlangan. Shu sababli KIRISH narxi taxminiy; chiqish narxi esa aniq."
		);
	}

	if (acc.legacySessions > 0) {
		notes.push(
			`${acc.legacySessions} ta eski sessiyada faqat umumiy token soni bor, kesh va audio/matn taqsimoti yo'q. ` +
				"Ularning narxi hisoblanmadi (butun promptni yangi token narxida hisoblash xarajatni bir necha barobar oshirib yuborardi)."
		);
	}

	// Whatever is unpriced but not legacy: the row recorded no token usage at all,
	// usually because the model never got to answer. Without this the owner subtracts
	// the legacy count from the unpriced count and is left with a gap the page does
	// not explain.
	const noUsageSessions = acc.unpricedSessions - acc.legacySessions;

	if (noUsageSessions > 0) {
		notes.push(
			`${noUsageSessions} ta sessiya token sarfini umuman qayd etmagan (model javob berishga ulgurmagan) — ` +
				"ularda hisoblanadigan xarajat yo'q."
		);
	}

	if (acc.analysis.unmeasuredAnalyses > 0) {
		notes.push(
			`${acc.analysis.unmeasuredAnalyses} ta tahlil token hisobi qo'shilishidan oldin bajarilgan — ularning narxi noma'lum.`
		);
	}

	if (acc.analysis.failedAnalyses > 0) {
		notes.push(
			`${acc.analysis.failedAnalyses} ta tahlil xatolik bilan tugagan — ular hech narsa ishlab chiqarmagan, shuning uchun xarajatga kirmaydi.`
		);
	}

	if (acc.transcription.notApplicableSessions > 0) {
		notes.push(
			`Gemini transkripsiyani suhbat ichida bajaradi, alohida to'lovsiz — ${acc.transcription.notApplicableSessions} ta sessiyada ` +
				"transkripsiya qatori 0. Transkripsiya va tahlil xarajatlari faqat OpenAI yo'liga tegishli."
		);
	}

	notes.push(
		"Hisob-kitobda chegirmalar, bepul limitlar, minimal to'lov birliklari va soliqlar hisobga olinmagan."
	);
	notes.push(
		"ElevenLabs bilan aytiladigan tayyor jumlalar belgilar bo'yicha to'lanadi va hech qayerda sanalmaydi; " +
			"ElevenLabs standart holatda o'chirilgan, shuning uchun bu yerga kirmagan."
	);

	return notes;
}

function buildPricingStatus(loaded: Awaited<ReturnType<typeof loadRates>>): PricingStatus {
	const anyRateSet = PRICING_KEYS.some(
		(key) => key !== "pricing.usdToUzs" && !loaded.zeroKeys.includes(key)
	);

	return {
		configured: anyRateSet,
		unreviewedCount: loaded.unreviewedKeys.length,
		zeroKeys: loaded.zeroKeys,
		lastReviewedAt: loaded.lastReviewedAt,
		usdToUzs: loaded.rates.usdToUzs,
	};
}

// ===========================================
// GET /summary
// ===========================================

export const summaryHandler: AppRouteHandler<typeof r.summary> = async (c) => {
	const query = c.req.valid("query");
	const range = resolveRange(query.from, query.to);
	const tenantId = currentTenantId(c);
	const loaded = await loadRates(tenantId);
	const rates: RateTable = loaded.rates;
	const timeZone = await resolveTimeZone(tenantId);

	const rows = await loadSessions(tenantId, rangeCondition(range));

	const totals = createAccumulator();
	const byProvider = new Map<string, Accumulator>();
	const byBucket = new Map<string, Accumulator>();
	const providerMeta = new Map<string, { provider: string; model: string | null }>();

	for (const row of rows) {
		const cost = priceSession(toSessionTokens(row), row.provider, toAnalysisTokens(row), rates);

		accumulate(totals, row, cost);

		const providerKey = `${row.provider}::${row.model ?? ""}`;
		let providerAcc = byProvider.get(providerKey);

		if (providerAcc === undefined) {
			providerAcc = createAccumulator();
			byProvider.set(providerKey, providerAcc);
			providerMeta.set(providerKey, { provider: row.provider, model: row.model });
		}

		accumulate(providerAcc, row, cost);

		const key = bucketKey(row.startedAt, query.groupBy, timeZone);
		let bucketAcc = byBucket.get(key);

		if (bucketAcc === undefined) {
			bucketAcc = createAccumulator();
			byBucket.set(key, bucketAcc);
		}

		accumulate(bucketAcc, row, cost);
	}

	const pricing = buildPricingStatus(loaded);
	const totalCost = totals.total.value;
	const pricedCost = totals.pricedTotal.value;
	const pricedMinutes = totals.pricedCallSeconds / 60;

	const providerRows: ProviderSplitRow[] = Array.from(byProvider.entries())
		.map(([key, acc]) => {
			const meta = providerMeta.get(key);

			return {
				provider: meta?.provider ?? "",
				model: meta?.model ?? null,
				sessions: acc.sessions,
				pricedSessions: acc.pricedSessions,
				callSeconds: acc.callSeconds,
				voice: toVoiceBucket(acc.voice),
				transcription: toTranscriptionBucket(acc),
				analysis: toAnalysisBucket(acc),
				costUsd: acc.total.value,
				// Priced subtotal over priced minutes: the two have to describe the
				// same sessions or the rate is diluted by rows the numerator covers
				// and the denominator does not.
				costPerMinuteUsd: costPerMinute(acc.pricedTotal.value, acc.pricedCallSeconds * 1000),
			};
		})
		.sort((left, right) => (right.costUsd ?? -1) - (left.costUsd ?? -1));

	const series: CostSeriesPoint[] = Array.from(byBucket.entries())
		.map(([bucket, acc]) => ({
			bucket,
			sessions: acc.sessions,
			voiceCostUsd: acc.voice.cost.value,
			transcriptionCostUsd: acc.transcription.cost.value,
			analysisCostUsd: acc.analysis.cost.value,
			costUsd: acc.total.value,
		}))
		.sort((left, right) => left.bucket.localeCompare(right.bucket));

	return c.json(
		{
			success: true as const,
			data: {
				range: {
					from: range.start.toISOString(),
					to: range.end.toISOString(),
					days: range.days,
					groupBy: query.groupBy,
					timeZone,
				},
				pricing,
				totals: {
					sessions: totals.sessions,
					pricedSessions: totals.pricedSessions,
					unpricedSessions: totals.unpricedSessions,
					legacySessions: totals.legacySessions,
					callSeconds: totals.callSeconds,
					pricedCallSeconds: totals.pricedCallSeconds,
					voice: toVoiceBucket(totals.voice),
					transcription: toTranscriptionBucket(totals),
					analysis: toAnalysisBucket(totals),
					costUsd: totalCost,
					costUzs: toUzs(totalCost, rates.usdToUzs),
					// Averaged over the sessions that could actually be priced, from the
					// subtotal covering exactly those sessions. Dividing by every session
					// would discount the month by the share of rows whose cost is unknown;
					// dividing the WIDER total by them would inflate it by the analysis
					// spend of the rows the denominator leaves out.
					costPerCallUsd:
						pricedCost !== null && totals.pricedSessions > 0
							? roundMoney(pricedCost / totals.pricedSessions)
							: null,
					costPerMinuteUsd:
						pricedCost !== null && pricedMinutes > 0
							? roundMoney(pricedCost / pricedMinutes)
							: null,
				},
				byProvider: providerRows,
				series,
				estimateNotes: buildEstimateNotes(totals, pricing),
			},
		},
		200
	);
};

// ===========================================
// GET /calls
// ===========================================

export const callsHandler: AppRouteHandler<typeof r.costCalls> = async (c) => {
	const query = c.req.valid("query");
	const range = resolveRange(query.from, query.to);
	const tenantId = currentTenantId(c);
	const loaded = await loadRates(tenantId);

	const filters: (SQL | undefined)[] = [rangeCondition(range)];

	if (query.provider !== undefined && query.provider.trim().length > 0) {
		filters.push(eq(aiSessions.provider, query.provider.trim()));
	}

	const where = and(...filters.filter((item): item is SQL => item !== undefined));

	// Sorting by cost cannot be pushed into SQL: the cost does not exist in the
	// database, it is derived from the current rate table. The range is bounded to
	// a year of AI sessions, so the whole window is priced and then paged in
	// memory - the same shape the summary already does.
	// The whole window is loaded, sorted and paged in memory. The page/limit cursor
	// therefore cannot escape the scope: it indexes into an array that was already
	// filtered by tenant, not into a fresh query.
	const rows = await loadSessions(tenantId, where);
	const priced = rows.map((row) => ({
		row,
		cost: priceSession(toSessionTokens(row), row.provider, toAnalysisTokens(row), loaded.rates),
	}));

	if (query.sort === "cost") {
		// Unpriced rows sink to the bottom rather than sorting as if they were free.
		priced.sort((left, right) => (right.cost.totalCostUsd ?? -1) - (left.cost.totalCostUsd ?? -1));
	} else if (query.sort === "duration") {
		priced.sort(
			(left, right) => (sessionDurationMs(right.row) ?? 0) - (sessionDurationMs(left.row) ?? 0)
		);
	} else {
		priced.sort((left, right) => right.row.startedAt.getTime() - left.row.startedAt.getTime());
	}

	const total = priced.length;
	const offset = (query.page - 1) * query.limit;
	const items: CostCallRow[] = priced.slice(offset, offset + query.limit).map(({ row, cost }) => {
		const durationMs = sessionDurationMs(row);

		return {
			sessionId: row.sessionId,
			callId: row.callId,
			startedAt: row.startedAt.toISOString(),
			callerNumber: row.callerNumber,
			durationMs,
			provider: row.provider,
			model: row.model,
			responseTurns: row.responseTurns,
			promptTokens: row.promptTokens,
			cachedPromptTokens: row.cachedPromptTokens,
			cachedSharePct: cost.voice.cachedSharePct,
			completionTokens: row.completionTokens,
			outputAudioTokens: row.outputAudioTokens,
			voiceCostUsd: cost.voice.costUsd,
			transcriptionCostUsd: cost.transcription.costUsd,
			analysisCostUsd: cost.analysis.costUsd,
			totalCostUsd: cost.totalCostUsd,
			costPerMinuteUsd: costPerMinute(cost.totalCostUsd, durationMs),
			estimated: cost.estimated,
			unpricedReason: cost.voice.unpricedReason,
		};
	});

	return c.json(
		{
			success: true as const,
			data: {
				items,
				meta: {
					total,
					page: query.page,
					limit: query.limit,
					totalPages: Math.ceil(total / query.limit),
				},
			},
		},
		200
	);
};

// ===========================================
// GET /rates
// ===========================================

export const ratesHandler: AppRouteHandler<typeof r.rates> = async (c) => {
	const tenantId = currentTenantId(c);
	const loaded = await loadRates(tenantId);

	const items = PRICING_KEYS.map((key) => ({
		key,
		label: getSettingDefinition(key).label,
		value: key === "pricing.usdToUzs" ? loaded.rates.usdToUzs : readRate(loaded.rates, key),
		isDefault: loaded.unreviewedKeys.includes(key),
	}));

	// Which model each rate is really being applied to is a property of the data,
	// not of the registry: the rate is keyed by provider, so the honest answer is
	// the set of models actually observed on that provider's sessions - scoped to
	// the range the page is showing, or all history when the caller gave none.
	const { from, to } = c.req.valid("query");
	const scoped = from !== undefined && to !== undefined ? resolveRange(from, to) : null;
	const observed = await db
		.selectDistinct({ provider: aiSessions.provider, model: aiSessions.model })
		.from(aiSessions)
		// "Observed on this account" means observed on THIS customer's calls. Unscoped,
		// a customer on Gemini would be shown the models another customer is running.
		.where(tenantWhere(aiSessions, tenantId, scoped === null ? undefined : rangeCondition(scoped)))
		.orderBy(asc(aiSessions.provider), asc(aiSessions.model));

	return c.json(
		{
			success: true as const,
			data: {
				pricing: buildPricingStatus(loaded),
				items,
				observedModels: observed,
			},
		},
		200
	);
};

/** Reads one rate back out of the assembled table, so /rates cannot drift from /summary. */
function readRate(rates: RateTable, key: (typeof PRICING_KEYS)[number]): number {
	const map: Record<string, number> = {
		"pricing.usdToUzs": rates.usdToUzs,
		"pricing.openaiRealtime.textInputPer1M": rates.openaiRealtime.textInputPer1M,
		"pricing.openaiRealtime.textInputCachedPer1M": rates.openaiRealtime.textInputCachedPer1M,
		"pricing.openaiRealtime.audioInputPer1M": rates.openaiRealtime.audioInputPer1M,
		"pricing.openaiRealtime.audioInputCachedPer1M": rates.openaiRealtime.audioInputCachedPer1M,
		"pricing.openaiRealtime.textOutputPer1M": rates.openaiRealtime.textOutputPer1M,
		"pricing.openaiRealtime.audioOutputPer1M": rates.openaiRealtime.audioOutputPer1M,
		"pricing.geminiLive.textInputPer1M": rates.geminiLive.textInputPer1M,
		"pricing.geminiLive.textInputCachedPer1M": rates.geminiLive.textInputCachedPer1M,
		"pricing.geminiLive.audioInputPer1M": rates.geminiLive.audioInputPer1M,
		"pricing.geminiLive.audioInputCachedPer1M": rates.geminiLive.audioInputCachedPer1M,
		"pricing.geminiLive.textOutputPer1M": rates.geminiLive.textOutputPer1M,
		"pricing.geminiLive.audioOutputPer1M": rates.geminiLive.audioOutputPer1M,
		"pricing.transcribe.audioInputPer1M": rates.transcribe.audioInputPer1M,
		"pricing.transcribe.textOutputPer1M": rates.transcribe.textOutputPer1M,
		"pricing.analysis.inputPer1M": rates.analysis.inputPer1M,
		"pricing.analysis.cachedInputPer1M": rates.analysis.cachedInputPer1M,
		"pricing.analysis.outputPer1M": rates.analysis.outputPer1M,
	};

	return map[key] ?? 0;
}
