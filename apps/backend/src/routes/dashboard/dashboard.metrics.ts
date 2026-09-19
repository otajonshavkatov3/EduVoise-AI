/**
 * Dashboard uchun haqiqiy SQL agregatsiyalari (TZ 3.1).
 *
 * Bu faylda hech qanday to'qib chiqarilgan son yo'q: har bir ko'rsatkich
 * Postgres'dan `GROUP BY` / `FILTER` orqali olinadi. Ma'lumot bo'lmasa 0 emas,
 * `null` qaytariladi — UI "ma'lumot yo'q" deb ko'rsatadi. Barcha qatorlar
 * bo'yicha JS'da aylanish yo'q; faqat tayyor agregatlar o'qiladi.
 *
 * WHY THE TENANT IS NOT PART OF THE PASSED-IN CONDITION. Every function here used
 * to take a ready-made `where` and trust it. An aggregate is the worst place for
 * that: a count(*) with no tenant filter does not look broken, it looks like a
 * bigger business - it silently reports the whole PLATFORM's numbers as one
 * customer's, and nobody notices until two customers compare screenshots. So the
 * tenant travels separately (CallsFilter) and every statement below applies it
 * itself, which also means the tenant is visible at each query site instead of
 * three call frames away.
 */
import type { TenantId, UserRoleType } from "@shared/types";
import { and, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";

import { db } from "@/db";
import { aiAnalyses, calls, contacts, operatorProfiles, tickets, users } from "@/db/schema";
import { tenantWhere } from "@/lib/tenancy";
import type { AuthUser } from "@/lib/types";

/** Admin va supervisor butun call-center raqamlarini ko'radi; manager faqat o'zinikini. */
const CAN_SEE_ALL_METRICS: UserRoleType[] = ["admin", "supervisor"];

/** Hech qachon mos kelmaydigan uuid — operator profili yo'q manager bo'sh natija oladi. */
const MATCHES_NOTHING_UUID = "00000000-0000-0000-0000-000000000000";

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
const HOURS_PER_DAY = 24;
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;

/** Diagramma o'qilishi uchun ro'yxatlar cheklanadi. */
const TOP_OPERATORS_LIMIT = 12;
const TOP_CATEGORIES_LIMIT = 8;

export type DashboardPeriod = "day" | "week" | "month";

export interface PeriodRange {
	period: DashboardPeriod;
	/** Oraliq boshi (mahalliy yarim tun). */
	from: Date;
	/** Oraliq oxiri (bugungi kunning oxiri). */
	to: Date;
	/** Solishtirish uchun oldingi teng uzunlikdagi oraliq. */
	previousFrom: Date;
	previousTo: Date;
	/** Vaqt qatoridagi bitta ustun kengligi (sekund). */
	bucketSeconds: number;
	/** Ustunlar soni — kelajakdagi soat/kun uchun ustun chizilmaydi. */
	bucketCount: number;
	granularity: "hour" | "day";
}

export interface DashboardScope {
	/**
	 * The customer whose numbers these are. Taken from the request's token, never
	 * from a query parameter - a dashboard that could be pointed at another tenant
	 * by a URL is not a dashboard, it is a report on somebody else's business.
	 */
	tenantId: TenantId;
	/** true — faqat shu operatorning raqamlari ko'rsatiladi (manager). */
	operatorScoped: boolean;
	/** operatorProfiles.id; manager profilga ega bo'lmasa null. */
	operatorId: string | null;
	/** users.id — ticketlarni createdBy bo'yicha filtrlash uchun. */
	userId: string;
}

/**
 * A calls aggregate's inputs: the tenant, and the period + RBAC condition.
 *
 * Deliberately two fields rather than one pre-built `where`. The condition is what
 * the request asked for; the tenant is what the request is ALLOWED to see, and it
 * is applied by each query below so that no aggregate can be handed a filter that
 * quietly forgot it.
 */
export interface CallsFilter {
	tenantId: TenantId;
	/** Oraliq + RBAC sharti. Tenant bu yerda YO'Q — uni har bir so'rov o'zi qo'shadi. */
	condition: SQL;
}

export interface CallStats {
	total: number;
	inbound: number;
	outbound: number;
	/** status IN ('answered','completed') — telefoniya qatlami javob berilgan qo'ng'iroqni tugaganda 'completed' qiladi. */
	answered: number;
	missed: number;
	abandoned: number;
	/** Hozir jiringlab turgan qo'ng'iroqlar. */
	ringing: number;
	/** missed + abandoned. */
	unanswered: number;
	/** answered / (answered + unanswered) * 100; yakunlangan qo'ng'iroq bo'lmasa null. */
	answerRate: number | null;
	/** calls.duration o'rtachasi (sekund); namuna bo'lmasa null. */
	avgTalkTimeSec: number | null;
	totalTalkTimeSec: number;
	talkTimeSampleSize: number;
	/** answeredAt - startedAt o'rtachasi (sekund). answeredAt NULL qatorlar hisobga olinmaydi. */
	avgWaitingTimeSec: number | null;
	waitingTimeSampleSize: number;
}

export interface VolumeBucket {
	bucketStart: string;
	label: string;
	total: number;
	inbound: number;
	outbound: number;
	answered: number;
	missed: number;
	abandoned: number;
	unanswered: number;
}

export interface OperatorStatusBreakdown {
	total: number;
	/** online + busy. */
	active: number;
	online: number;
	busy: number;
	pause: number;
	offline: number;
}

export type OperatorStatus = "online" | "offline" | "pause" | "busy";

export interface OperatorWorkloadRow {
	operatorId: string;
	extension: string;
	name: string;
	currentStatus: OperatorStatus;
	totalCalls: number;
	answeredCalls: number;
	missedCalls: number;
	avgTalkTimeSec: number | null;
	totalTalkTimeSec: number;
}

export interface SentimentBreakdown {
	positive: number;
	neutral: number;
	negative: number;
	/** sentiment yozilgan tahlillar soni. */
	analyzed: number;
}

export interface CategoryCount {
	/** tickets.category NULL bo'lishi mumkin — UI "Kategoriyasiz" deb ko'rsatadi. */
	category: string | null;
	count: number;
}

export interface UnansweredCallRow {
	id: string;
	callerNumber: string;
	contactId: string | null;
	contactName: string | null;
	direction: "inbound" | "outbound";
	/** Faqat javobsiz statuslar — so'rov shu ikkisi bilan filtrlangan. */
	status: "missed" | "abandoned";
	calleeExtension: string | null;
	operatorExtension: string | null;
	startedAt: string;
	endedAt: string | null;
	/** Qo'ng'iroq yo'qolgunga qadar necha sekund jiringladi (endedAt bo'lmasa null). */
	ringSec: number | null;
}

// ===========================================
// Qayta ishlatiladigan SQL bo'laklari
// ===========================================

const ANSWERED_FILTER = sql`${calls.status} in ('answered', 'completed')`;

/**
 * Muloqot vaqti faqat yakunlangan qo'ng'iroqlardan olinadi: hali davom etayotgan
 * qo'ng'iroqning duration'i 0 bo'lib turadi va o'rtachani pastga tortadi.
 */
const TALK_TIME_FILTER = sql`${calls.status} in ('answered', 'completed') and ${calls.endedAt} is not null and ${calls.duration} is not null`;

/**
 * Kutish vaqti: answeredAt yangi ustun, tarixiy qatorlarda NULL. NULL'lar
 * o'rtachaga kirmaydi; teskari (answeredAt < startedAt) buzuq qatorlar ham.
 */
const WAITING_FILTER = sql`${calls.answeredAt} is not null and ${calls.answeredAt} >= ${calls.startedAt}`;

const COUNT_ALL = sql<number>`count(*)::int`;

function toNumber(value: unknown): number {
	const parsed = Number(value ?? 0);

	return Number.isFinite(parsed) ? parsed : 0;
}

/** Namuna bo'lmasa null qaytaradi — 0 ko'rsatish "ma'lumot yo'q"ni yashirgan bo'lardi. */
function averageOrNull(sum: unknown, sampleSize: number): number | null {
	if (sampleSize <= 0) {
		return null;
	}

	return Math.round(toNumber(sum) / sampleSize);
}

function startOfDay(date: Date): Date {
	const copy = new Date(date);
	copy.setHours(0, 0, 0, 0);

	return copy;
}

function endOfDay(date: Date): Date {
	const copy = new Date(date);
	copy.setHours(23, 59, 59, 999);

	return copy;
}

function shiftDays(date: Date, days: number): Date {
	const copy = new Date(date);
	copy.setDate(copy.getDate() + days);

	return copy;
}

/**
 * Oraliqni hisoblaydi.
 *
 * - day — bugun 00:00 dan boshlab, soatlik ustunlar (faqat o'tgan soatlar).
 * - week — oxirgi 7 kun (bugun ham kiradi), kunlik ustunlar.
 * - month — oxirgi 30 kun, kunlik ustunlar.
 *
 * Solishtirish oraliqlari teng uzunlikda va "o'tgan vaqt" bo'yicha kesiladi:
 * bugungi yarim kunni to'liq kechagi kun bilan solishtirmaslik uchun.
 *
 * Ustun chegaralari epoch sekundlari bo'yicha hisoblanadi — Asia/Tashkent'da
 * DST yo'q, shuning uchun kunlik ustunlar mahalliy yarim tunga to'g'ri tushadi.
 */
export function resolvePeriodRange(period: DashboardPeriod, now = new Date()): PeriodRange {
	const dayStart = startOfDay(now);
	const to = endOfDay(now);

	const windowDays = period === "day" ? 1 : period === "week" ? WEEK_DAYS : MONTH_DAYS;
	const from = period === "day" ? dayStart : shiftDays(dayStart, -(windowDays - 1));

	const previousFrom = shiftDays(from, -windowDays);
	const elapsedMs = Math.max(0, now.getTime() - from.getTime());
	const previousTo = new Date(previousFrom.getTime() + elapsedMs);

	if (period === "day") {
		return {
			period,
			from,
			to,
			previousFrom,
			previousTo,
			bucketSeconds: HOUR_SECONDS,
			// Kelajakdagi soatlar uchun ustun chizilmaydi.
			bucketCount: Math.min(HOURS_PER_DAY, now.getHours() + 1),
			granularity: "hour",
		};
	}

	return {
		period,
		from,
		to,
		previousFrom,
		previousTo,
		bucketSeconds: DAY_SECONDS,
		bucketCount: windowDays,
		granularity: "day",
	};
}

export async function resolveDashboardScope(user: AuthUser): Promise<DashboardScope> {
	// user.tenantId comes from the verified token (see lib/auth/middleware.ts).
	if (CAN_SEE_ALL_METRICS.includes(user.role)) {
		return { tenantId: user.tenantId, operatorScoped: false, operatorId: null, userId: user.id };
	}

	const profile = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			user.tenantId,
			eq(operatorProfiles.userId, user.id),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: { id: true },
	});

	return {
		tenantId: user.tenantId,
		operatorScoped: true,
		operatorId: profile?.id ?? null,
		userId: user.id,
	};
}

/** calls jadvali uchun oraliq + RBAC sharti (tenant alohida olib yuriladi). */
export function callsFilter(from: Date, to: Date, scope: DashboardScope): CallsFilter {
	const conditions: SQL[] = [gte(calls.startedAt, from), lte(calls.startedAt, to)];

	if (scope.operatorScoped) {
		// Profili yo'q manager hech qanday qo'ng'iroqni ko'rmaydi (0, to'qima emas).
		conditions.push(eq(calls.operatorId, scope.operatorId ?? MATCHES_NOTHING_UUID));
	}

	return { tenantId: scope.tenantId, condition: and(...conditions) ?? sql`true` };
}

// ===========================================
// Agregatsiyalar
// ===========================================

export async function loadCallStats(filter: CallsFilter): Promise<CallStats> {
	const [row] = await db
		.select({
			total: COUNT_ALL,
			inbound: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')::int`,
			outbound: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')::int`,
			answered: sql<number>`count(*) filter (where ${ANSWERED_FILTER})::int`,
			missed: sql<number>`count(*) filter (where ${calls.status} = 'missed')::int`,
			abandoned: sql<number>`count(*) filter (where ${calls.status} = 'abandoned')::int`,
			ringing: sql<number>`count(*) filter (where ${calls.status} = 'ringing')::int`,
			talkTimeSum: sql<string>`coalesce(sum(${calls.duration}) filter (where ${TALK_TIME_FILTER}), 0)::bigint`,
			talkTimeSamples: sql<number>`count(*) filter (where ${TALK_TIME_FILTER})::int`,
			waitingSum: sql<string>`coalesce(sum(extract(epoch from (${calls.answeredAt} - ${calls.startedAt}))) filter (where ${WAITING_FILTER}), 0)::numeric`,
			waitingSamples: sql<number>`count(*) filter (where ${WAITING_FILTER})::int`,
		})
		.from(calls)
		.where(tenantWhere(calls, filter.tenantId, filter.condition));

	const missed = toNumber(row?.missed);
	const abandoned = toNumber(row?.abandoned);
	const answered = toNumber(row?.answered);
	const unanswered = missed + abandoned;
	const settled = answered + unanswered;
	const talkTimeSamples = toNumber(row?.talkTimeSamples);
	const waitingSamples = toNumber(row?.waitingSamples);

	return {
		total: toNumber(row?.total),
		inbound: toNumber(row?.inbound),
		outbound: toNumber(row?.outbound),
		answered,
		missed,
		abandoned,
		ringing: toNumber(row?.ringing),
		unanswered,
		answerRate: settled > 0 ? Math.round((answered / settled) * 1000) / 10 : null,
		avgTalkTimeSec: averageOrNull(row?.talkTimeSum, talkTimeSamples),
		totalTalkTimeSec: toNumber(row?.talkTimeSum),
		talkTimeSampleSize: talkTimeSamples,
		avgWaitingTimeSec: averageOrNull(row?.waitingSum, waitingSamples),
		waitingTimeSampleSize: waitingSamples,
	};
}

function bucketLabel(bucketStart: Date, granularity: PeriodRange["granularity"]): string {
	if (granularity === "hour") {
		return `${String(bucketStart.getHours()).padStart(2, "0")}:00`;
	}

	const day = String(bucketStart.getDate()).padStart(2, "0");
	const month = String(bucketStart.getMonth() + 1).padStart(2, "0");

	return `${day}.${month}`;
}

/**
 * Vaqt qatori. Ustun indeksi Postgres'da hisoblanadi (`floor((started_at - from) / kenglik)`)
 * va `GROUP BY` shu indeks bo'yicha ketadi — barcha qatorlar JS'ga tortilmaydi.
 * Bo'sh ustunlar nol bilan to'ldiriladi, chunki grafikning o'qi uzluksiz bo'lishi kerak.
 */
export async function loadCallVolume(
	range: PeriodRange,
	filter: CallsFilter
): Promise<VolumeBucket[]> {
	const bucketIndex = sql<number>`floor(extract(epoch from (${calls.startedAt} - ${range.from.toISOString()}::timestamptz)) / ${sql.raw(String(range.bucketSeconds))})::int`;

	const rows = await db
		.select({
			bucket: bucketIndex,
			total: COUNT_ALL,
			inbound: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')::int`,
			outbound: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')::int`,
			answered: sql<number>`count(*) filter (where ${ANSWERED_FILTER})::int`,
			missed: sql<number>`count(*) filter (where ${calls.status} = 'missed')::int`,
			abandoned: sql<number>`count(*) filter (where ${calls.status} = 'abandoned')::int`,
		})
		.from(calls)
		.where(tenantWhere(calls, filter.tenantId, filter.condition))
		// Ordinal bo'yicha guruhlash: drizzle select ro'yxatida ustunni jadval
		// prefiksisiz ("started_at"), GROUP BY'da esa prefiks bilan chiqaradi va
		// Postgres ikki ifodani bir xil deb tanimaydi. `group by 1` — birinchi
		// select ifodasi, ya'ni ustun indeksi.
		.groupBy(sql`1`);

	// Kelajakdagi ustun chizilmagani uchun (bucketCount o'tgan soat/kunlar bilan
	// cheklangan) soat farqi tufayli oxiridan chiqib ketgan qator yo'qolmasin:
	// indeks oxirgi ustunga qisiladi. Shu bilan "ustunlar yig'indisi = oraliqdagi
	// jami" tengligi buzilmaydi.
	const lastIndex = Math.max(0, range.bucketCount - 1);
	const totals = new Map<number, VolumeBucket>();

	for (let index = 0; index < range.bucketCount; index += 1) {
		const bucketStart = new Date(range.from.getTime() + index * range.bucketSeconds * 1000);

		totals.set(index, {
			bucketStart: bucketStart.toISOString(),
			label: bucketLabel(bucketStart, range.granularity),
			total: 0,
			inbound: 0,
			outbound: 0,
			answered: 0,
			missed: 0,
			abandoned: 0,
			unanswered: 0,
		});
	}

	for (const row of rows) {
		const index = Math.min(lastIndex, Math.max(0, toNumber(row.bucket)));
		const bucket = totals.get(index);

		if (!bucket) {
			continue;
		}

		const missed = toNumber(row.missed);
		const abandoned = toNumber(row.abandoned);

		bucket.total += toNumber(row.total);
		bucket.inbound += toNumber(row.inbound);
		bucket.outbound += toNumber(row.outbound);
		bucket.answered += toNumber(row.answered);
		bucket.missed += missed;
		bucket.abandoned += abandoned;
		bucket.unanswered += missed + abandoned;
	}

	const buckets: VolumeBucket[] = [];

	for (let index = 0; index < range.bucketCount; index += 1) {
		const bucket = totals.get(index);

		if (bucket) {
			buckets.push(bucket);
		}
	}

	return buckets;
}

export async function loadOperatorStatuses(
	scope: DashboardScope
): Promise<OperatorStatusBreakdown> {
	const conditions: SQL[] = [eq(operatorProfiles.isDeleted, false)];

	if (scope.operatorScoped) {
		conditions.push(eq(operatorProfiles.id, scope.operatorId ?? MATCHES_NOTHING_UUID));
	}

	// "How many of my operators are online" must count MY operators. Unscoped, a
	// small customer would see the platform's whole staff.
	const [row] = await db
		.select({
			total: COUNT_ALL,
			online: sql<number>`count(*) filter (where ${operatorProfiles.currentStatus} = 'online')::int`,
			busy: sql<number>`count(*) filter (where ${operatorProfiles.currentStatus} = 'busy')::int`,
			pause: sql<number>`count(*) filter (where ${operatorProfiles.currentStatus} = 'pause')::int`,
			offline: sql<number>`count(*) filter (where ${operatorProfiles.currentStatus} = 'offline')::int`,
		})
		.from(operatorProfiles)
		.where(tenantWhere(operatorProfiles, scope.tenantId, ...conditions));

	const online = toNumber(row?.online);
	const busy = toNumber(row?.busy);

	return {
		total: toNumber(row?.total),
		// "Faol" = suhbatga tayyor yoki suhbatda; tanaffus va offline kirmaydi.
		active: online + busy,
		online,
		busy,
		pause: toNumber(row?.pause),
		offline: toNumber(row?.offline),
	};
}

/**
 * Operator yuklamasi — qo'ng'iroq yozuvi bor operatorlar bo'yicha, ko'pdan kamga.
 *
 * Both sides of both joins carry the tenant. A join scoped on one table only reads
 * as "scoped" to any reviewer and to the query-site scanner, so the rule here is
 * the explicit one: if a table is in the query, its tenant is in the query.
 */
export async function loadOperatorWorkload(filter: CallsFilter): Promise<OperatorWorkloadRow[]> {
	const rows = await db
		.select({
			operatorId: operatorProfiles.id,
			extension: operatorProfiles.extension,
			currentStatus: operatorProfiles.currentStatus,
			username: users.username,
			phone: users.phone,
			totalCalls: COUNT_ALL,
			answeredCalls: sql<number>`count(*) filter (where ${ANSWERED_FILTER})::int`,
			missedCalls: sql<number>`count(*) filter (where ${calls.status} in ('missed', 'abandoned'))::int`,
			talkTimeSum: sql<string>`coalesce(sum(${calls.duration}) filter (where ${TALK_TIME_FILTER}), 0)::bigint`,
			talkTimeSamples: sql<number>`count(*) filter (where ${TALK_TIME_FILTER})::int`,
		})
		.from(calls)
		.innerJoin(
			operatorProfiles,
			and(eq(operatorProfiles.id, calls.operatorId), eq(operatorProfiles.tenantId, calls.tenantId))
		)
		.innerJoin(
			users,
			and(eq(users.id, operatorProfiles.userId), eq(users.tenantId, calls.tenantId))
		)
		.where(tenantWhere(calls, filter.tenantId, filter.condition))
		.groupBy(
			operatorProfiles.id,
			operatorProfiles.extension,
			operatorProfiles.currentStatus,
			users.username,
			users.phone
		)
		.orderBy(desc(COUNT_ALL))
		.limit(TOP_OPERATORS_LIMIT);

	return rows.map((row) => {
		const samples = toNumber(row.talkTimeSamples);

		return {
			operatorId: row.operatorId,
			extension: row.extension,
			// Ism yo'q bo'lsa raqam, u ham yo'q bo'lsa extension — to'qima ism yozilmaydi.
			name: row.username?.trim() || row.phone || `Ext ${row.extension}`,
			currentStatus: row.currentStatus,
			totalCalls: toNumber(row.totalCalls),
			answeredCalls: toNumber(row.answeredCalls),
			missedCalls: toNumber(row.missedCalls),
			avgTalkTimeSec: averageOrNull(row.talkTimeSum, samples),
			totalTalkTimeSec: toNumber(row.talkTimeSum),
		};
	});
}

/** AI kayfiyat taqsimoti — tahlil qilingan qo'ng'iroqlar bo'yicha. */
export async function loadSentiment(filter: CallsFilter): Promise<SentimentBreakdown> {
	const [row] = await db
		.select({
			positive: sql<number>`count(*) filter (where ${aiAnalyses.sentiment} = 'positive')::int`,
			neutral: sql<number>`count(*) filter (where ${aiAnalyses.sentiment} = 'neutral')::int`,
			negative: sql<number>`count(*) filter (where ${aiAnalyses.sentiment} = 'negative')::int`,
			analyzed: sql<number>`count(*) filter (where ${aiAnalyses.sentiment} is not null)::int`,
		})
		.from(aiAnalyses)
		.innerJoin(calls, and(eq(calls.id, aiAnalyses.callId), eq(calls.tenantId, aiAnalyses.tenantId)))
		.where(tenantWhere(aiAnalyses, filter.tenantId, filter.condition));

	return {
		positive: toNumber(row?.positive),
		neutral: toNumber(row?.neutral),
		negative: toNumber(row?.negative),
		analyzed: toNumber(row?.analyzed),
	};
}

/** Murojaat kategoriyalari — tickets.category bo'yicha. */
export async function loadTicketCategories(
	from: Date,
	to: Date,
	scope: DashboardScope
): Promise<CategoryCount[]> {
	const conditions: SQL[] = [
		eq(tickets.isDeleted, false),
		gte(tickets.createdAt, from),
		lte(tickets.createdAt, to),
	];

	if (scope.operatorScoped) {
		// tickets.handlers.ts bilan bir xil qoida: manager o'zi yaratgan ticketlarni ko'radi.
		conditions.push(eq(tickets.createdBy, scope.userId));
	}

	const rows = await db
		.select({ category: tickets.category, count: COUNT_ALL })
		.from(tickets)
		.where(tenantWhere(tickets, scope.tenantId, ...conditions))
		.groupBy(tickets.category)
		.orderBy(desc(COUNT_ALL))
		.limit(TOP_CATEGORIES_LIMIT);

	return rows.map((row) => ({
		category: row.category?.trim() || null,
		count: toNumber(row.count),
	}));
}

/** db.execute generigi Record<string, unknown> talab qiladi. */
interface AiCategoryRow {
	category: string | null;
	count: number;
	[key: string]: unknown;
}

/**
 * AI aniqlagan mavzular — aiAnalyses.categories jsonb massivi.
 *
 * `jsonb_array_elements_text` LATERAL bilan yoyiladi va Postgres'ning o'zida
 * guruhlanadi. Massiv bo'lmagan qiymatlar (buzuq yozuv) SRF'ni xato qilmasligi
 * uchun ichki so'rovda `jsonb_typeof` bilan filtrlanadi.
 *
 * RAW SQL, so nothing here type-checks against the tenancy seam and no scanner can
 * read it: the tenant predicate below is built with tenantWhere() and interpolated,
 * and the join carries tenant equality, so this string is scoped for the same
 * reason the typed queries are - but it is the one query in this file that has to
 * be verified by eye.
 */
export async function loadAiCategories(filter: CallsFilter): Promise<CategoryCount[]> {
	const scopedWhere = tenantWhere(aiAnalyses, filter.tenantId, filter.condition);
	const result = await db.execute<AiCategoryRow>(sql`
		select cat.value as category, count(*)::int as count
		from (
			select ${aiAnalyses.categories} as categories
			from ${aiAnalyses}
			inner join ${calls}
				on ${calls.id} = ${aiAnalyses.callId} and ${calls.tenantId} = ${aiAnalyses.tenantId}
			where ${scopedWhere} and jsonb_typeof(${aiAnalyses.categories}) = 'array'
		) as src
		cross join lateral jsonb_array_elements_text(src.categories) as cat(value)
		group by cat.value
		order by count(*) desc, cat.value asc
		limit ${sql.raw(String(TOP_CATEGORIES_LIMIT))}
	`);

	return result.rows
		.map((row) => ({ category: row.category?.trim() || null, count: toNumber(row.count) }))
		.filter((row) => row.category !== null);
}

/** Javobsiz qo'ng'iroqlar ro'yxati — yangilaridan boshlab, kontakt ismi bilan. */
export async function loadUnansweredCalls(
	filter: CallsFilter,
	limit: number
): Promise<{ items: UnansweredCallRow[]; total: number }> {
	const unanswered = and(filter.condition, sql`${calls.status} in ('missed', 'abandoned')`);

	const [rows, countRows] = await Promise.all([
		db
			.select({
				id: calls.id,
				callerNumber: calls.callerNumber,
				contactId: calls.contactId,
				firstName: contacts.firstName,
				lastName: contacts.lastName,
				direction: calls.direction,
				status: calls.status,
				calleeExtension: calls.calleeExtension,
				operatorExtension: operatorProfiles.extension,
				startedAt: calls.startedAt,
				endedAt: calls.endedAt,
				ringSec: sql<
					number | null
				>`case when ${calls.endedAt} is null then null else greatest(0, extract(epoch from (${calls.endedAt} - ${calls.startedAt}))::int) end`,
			})
			.from(calls)
			// The contact's name and the operator's extension are joined in, so both
			// joins carry the tenant as well as the id.
			.leftJoin(
				contacts,
				and(eq(contacts.id, calls.contactId), eq(contacts.tenantId, calls.tenantId))
			)
			.leftJoin(
				operatorProfiles,
				and(
					eq(operatorProfiles.id, calls.operatorId),
					eq(operatorProfiles.tenantId, calls.tenantId)
				)
			)
			// Applied per statement, not shared: the list and its total must be the same
			// question, and the tenant is part of the question in both.
			.where(tenantWhere(calls, filter.tenantId, unanswered))
			.orderBy(desc(calls.startedAt))
			.limit(limit),
		db
			.select({ count: COUNT_ALL })
			.from(calls)
			.where(tenantWhere(calls, filter.tenantId, unanswered)),
	]);

	const items = rows.map((row) => {
		const fullName = [row.firstName, row.lastName]
			.map((part) => part?.trim())
			.filter((part): part is string => Boolean(part))
			.join(" ");

		return {
			id: row.id,
			callerNumber: row.callerNumber,
			contactId: row.contactId,
			// Kontakt yo'q bo'lsa null — UI raqamni ko'rsatadi, to'qima ism yozilmaydi.
			contactName: fullName || null,
			direction: row.direction,
			// SQL filtri 'missed'/'abandoned' bilan cheklangan, boshqa status kelmaydi.
			status: row.status as "missed" | "abandoned",
			calleeExtension: row.calleeExtension,
			operatorExtension: row.operatorExtension,
			startedAt: row.startedAt.toISOString(),
			endedAt: row.endedAt?.toISOString() ?? null,
			ringSec: row.ringSec === null ? null : toNumber(row.ringSec),
		};
	});

	return { items, total: toNumber(countRows[0]?.count) };
}
