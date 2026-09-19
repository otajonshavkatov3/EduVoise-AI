import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	ilike,
	isNotNull,
	isNull,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { Context } from "hono";

import { db } from "@/db";
import { calls, contacts, operatorProfiles, tickets, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { businessError, invalidInput, notFound } from "@/lib/errors";
import { getSetting } from "@/lib/settings";
import type { TenantId } from "@/lib/tenancy";
import { currentTenantId, tenantWhere } from "@/lib/tenancy";
import type { AppBindings, AppRouteHandler } from "@/lib/types";
import {
	buildCallsDocument,
	buildOperatorsDocument,
	buildTicketsDocument,
	describeCallFilters,
	describeOperatorFilters,
	describeRange,
	describeTicketFilters,
	type ReportContext,
} from "./reports.documents";
import {
	type ExportFile,
	type ReportDocument,
	renderCsv,
	renderXlsx,
	toFileResponse,
} from "./reports.export";
import { formatUzPhone, joinName, REPORT_TIME_ZONE } from "./reports.format";
import type * as r from "./reports.routes";
import {
	type CallReportRow,
	type CallsSummary,
	type ExportFormat,
	MAX_EXPORT_ROWS,
	MAX_RANGE_DAYS,
	type OperatorReportRow,
	type OperatorsSummary,
	type ReportRange,
	type TicketReportRow,
	type TicketsSummary,
} from "./reports.schemas";

const DAY_MS = 24 * 60 * 60 * 1000;
const SECONDS_PER_HOUR = 3600;

type ResolvedRange = {
	start: Date;
	end: Date;
	range: ReportRange;
};

/**
 * One report's scope: the tenant, and the filters the request asked for.
 *
 * THE TENANT IS NOT ONE OF THE FILTERS, and in this file that distinction is the
 * whole ball game. Every function here feeds either a page of rows or an EXPORT -
 * a CSV or an xlsx the user downloads in one click and can mail to anybody. A
 * filter that is left out narrows a report; the tenant left out hands one customer
 * a file containing every other customer's calls, contact names and phone numbers.
 * So it travels separately, and each statement below applies it itself: there is no
 * pre-built `where` anywhere in this file that could arrive already missing it.
 */
type ReportQuery = {
	tenantId: TenantId;
	/** Oraliq va foydalanuvchi tanlagan filtrlar. Tenant bu yerda YO'Q. */
	condition: SQL | undefined;
};

/** "answered" va "completed" — ikkisi ham javob berilgan qo'ng'iroq hisoblanadi. */
const answeredCondition = sql`${calls.status} in ('answered', 'completed')`;

/** bigint/numeric ustunlar pg drayverdan satr sifatida keladi. */
function toNumber(value: number | string | null | undefined): number {
	if (value === null || value === undefined) {
		return 0;
	}

	const parsed = typeof value === "number" ? value : Number(value);

	return Number.isFinite(parsed) ? parsed : 0;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Foiz. Bo'luvchi 0 bo'lsa null — "ma'lumot yo'q" 0% dan farq qiladi. */
function rateOf(part: number, total: number): number | null {
	return total > 0 ? round1((part / total) * 100) : null;
}

/** O'rtacha. Namuna bo'lmasa null qaytaradi, 0 emas. */
function averageOf(total: number, sampleCount: number): number | null {
	return sampleCount > 0 ? Math.round(total / sampleCount) : null;
}

/**
 * Sana oralig'ini tekshirish. Oraliq majburiy va MAX_RANGE_DAYS kundan oshmaydi —
 * bu qator sonini cheklashning birinchi qatlami.
 */
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
		throw businessError(`Hisobot oralig'i eng ko'pi bilan ${MAX_RANGE_DAYS} kun bo'lishi mumkin`, [
			{ field: "from/to", reason: `So'ralgan oraliq: ${days} kun` },
		]);
	}

	return {
		start,
		end,
		range: {
			from: start.toISOString(),
			to: end.toISOString(),
			days,
			timeZone: REPORT_TIME_ZONE,
		},
	};
}

/**
 * Eksportning ikkinchi qatlami: fayl yozishdan oldin qator soni sanaladi va
 * chegaradan oshsa umuman generatsiya qilinmaydi (million qatorni stream
 * qilishdan ko'ra tushunarli xato yaxshi).
 */
function assertExportSize(rowCount: number, range: ReportRange): void {
	if (rowCount <= MAX_EXPORT_ROWS) {
		return;
	}

	throw businessError(
		`Tanlangan oraliqda (${describeRange(range)}) ${rowCount} qator topildi. Bitta faylga ${MAX_EXPORT_ROWS} qatordan ko'pi yozilmaydi — sana oralig'ini toraytiring yoki qo'shimcha filtr qo'shing.`,
		[{ field: "from/to", reason: `Qator soni: ${rowCount}, chegara: ${MAX_EXPORT_ROWS}` }]
	);
}

type OperatorRef = {
	label: string;
	userId: string;
};

/**
 * Filtrda ko'rsatilgan operatorni tekshiradi va yorlig'ini tayyorlaydi.
 *
 * operatorId comes from the query string, so this is also the check that stops a
 * report being pointed at another tenant's operator: unscoped it would answer with
 * that operator's extension and NAME in the report header. A foreign id reads as
 * "does not exist".
 */
async function loadOperatorRef(
	tenantId: TenantId,
	operatorProfileId: string
): Promise<OperatorRef> {
	const [row] = await db
		.select({
			extension: operatorProfiles.extension,
			userId: operatorProfiles.userId,
			phone: users.phone,
			username: users.username,
		})
		.from(operatorProfiles)
		.innerJoin(
			users,
			and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, operatorProfiles.tenantId))
		)
		.where(tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, operatorProfileId)))
		.limit(1);

	if (!row) {
		throw notFound("Operator profili", operatorProfileId);
	}

	return {
		label: `${row.extension} — ${row.username ?? formatUzPhone(row.phone)}`,
		userId: row.userId,
	};
}

/** Auditda va fayl xulosasida ko'rinadigan "kim yuklab oldi" matni. */
async function describeCurrentUser(c: Context<AppBindings>): Promise<string> {
	const user = c.get("user");
	// Scoped even though the id comes from the token: users.phone is unique
	// platform-wide, so an id from another tenant is not reachable here - but the
	// rule is that no query in this file reads a tenant-owned table without saying
	// which tenant, and a rule with an exception is not a rule.
	const [row] = await db
		.select({ phone: users.phone, username: users.username })
		.from(users)
		.where(tenantWhere(users, user.tenantId, eq(users.id, user.id)))
		.limit(1);

	if (!row) {
		return `${user.id} (${user.role})`;
	}

	const phone = formatUzPhone(row.phone);

	return row.username ? `${row.username} (${phone}, ${user.role})` : `${phone} (${user.role})`;
}

/**
 * Eksport sarlavhasiga yoziladigan tashkilot nomi.
 *
 * `general.organizationName` sozlamasining yagona iste'molchisi. Sozlama uzoq
 * vaqt "hisobot va eksport fayllari sarlavhasida ishlatiladi" deb turgan, lekin
 * uni hech kim o'qimagan edi.
 */
async function readOrganizationName(tenantId: TenantId): Promise<string> {
	try {
		return (await getSetting(tenantId, "general.organizationName")) ?? "";
	} catch {
		// Sozlamani o'qib bo'lmasa ham eksport tayyor bo'lishi kerak.
		return "";
	}
}

/** ilike naqshida foydalanuvchi kiritgan maxsus belgilar literal bo'lib qolishi kerak. */
function escapeLikePattern(value: string): string {
	return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

async function renderExport<TRow>(
	doc: ReportDocument<TRow>,
	format: ExportFormat
): Promise<ExportFile> {
	return format === "csv" ? renderCsv(doc) : await renderXlsx(doc);
}

// --- Qo'ng'iroqlar hisoboti ---------------------------------------------------

type CallFilters = {
	operatorId?: string;
	status?: "ringing" | "answered" | "missed" | "abandoned" | "completed";
	direction?: "inbound" | "outbound";
};

function buildCallWhere(bounds: ResolvedRange, filters: CallFilters): SQL | undefined {
	const conditions: (SQL | undefined)[] = [
		gte(calls.startedAt, bounds.start),
		lte(calls.startedAt, bounds.end),
	];

	if (filters.operatorId) {
		conditions.push(eq(calls.operatorId, filters.operatorId));
	}
	if (filters.status) {
		conditions.push(eq(calls.status, filters.status));
	}
	if (filters.direction) {
		conditions.push(eq(calls.direction, filters.direction));
	}

	return and(...conditions);
}

async function countCalls(query: ReportQuery): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(calls)
		.where(tenantWhere(calls, query.tenantId, query.condition));

	return toNumber(row?.value);
}

async function loadCallsSummary(query: ReportQuery): Promise<CallsSummary> {
	const [row] = await db
		.select({
			totalCalls: sql<number>`count(*)`,
			inboundCalls: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')`,
			outboundCalls: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')`,
			answeredCalls: sql<number>`count(*) filter (where ${answeredCondition})`,
			missedCalls: sql<number>`count(*) filter (where ${calls.status} = 'missed')`,
			abandonedCalls: sql<number>`count(*) filter (where ${calls.status} = 'abandoned')`,
			talkSampleCount: sql<number>`count(*) filter (where ${answeredCondition} and ${calls.duration} is not null)`,
			totalTalkSeconds: sql<number>`coalesce(sum(${calls.duration}) filter (where ${answeredCondition}), 0)`,
			// answeredAt yangi ustun: eski qatorlarda NULL, shuning uchun namuna
			// alohida sanaladi va o'rtacha faqat shu namuna bo'yicha chiqadi.
			waitSampleCount: sql<number>`count(*) filter (where ${calls.answeredAt} is not null)`,
			totalWaitSeconds: sql<number>`coalesce(sum(extract(epoch from (${calls.answeredAt} - ${calls.startedAt}))) filter (where ${calls.answeredAt} is not null), 0)`,
		})
		.from(calls)
		.where(tenantWhere(calls, query.tenantId, query.condition));

	const totalCalls = toNumber(row?.totalCalls);
	const answeredCalls = toNumber(row?.answeredCalls);
	const talkSampleCount = toNumber(row?.talkSampleCount);
	const totalTalkSeconds = Math.round(toNumber(row?.totalTalkSeconds));
	const waitSampleCount = toNumber(row?.waitSampleCount);
	const totalWaitSeconds = Math.round(toNumber(row?.totalWaitSeconds));

	return {
		totalCalls,
		inboundCalls: toNumber(row?.inboundCalls),
		outboundCalls: toNumber(row?.outboundCalls),
		answeredCalls,
		missedCalls: toNumber(row?.missedCalls),
		abandonedCalls: toNumber(row?.abandonedCalls),
		answeredRate: rateOf(answeredCalls, totalCalls),
		avgTalkSeconds: averageOf(totalTalkSeconds, talkSampleCount),
		totalTalkSeconds,
		talkSampleCount,
		avgWaitSeconds: averageOf(totalWaitSeconds, waitSampleCount),
		totalWaitSeconds,
		waitSampleCount,
	};
}

async function selectCallRows(
	query: ReportQuery,
	limit: number,
	offset: number
): Promise<CallReportRow[]> {
	const rows = await db
		.select({
			id: calls.id,
			startedAt: calls.startedAt,
			answeredAt: calls.answeredAt,
			endedAt: calls.endedAt,
			direction: calls.direction,
			status: calls.status,
			callerNumber: calls.callerNumber,
			calleeExtension: calls.calleeExtension,
			duration: calls.duration,
			aiStatus: calls.aiStatus,
			ticketId: calls.ticketId,
			ticketSubject: tickets.subject,
			contactFirstName: contacts.firstName,
			contactLastName: contacts.lastName,
			contactPhone: contacts.phoneNumber,
			operatorExtension: operatorProfiles.extension,
			operatorPhone: users.phone,
		})
		.from(calls)
		// Four joins, each of which contributes a COLUMN TO THE EXPORT (contact name,
		// contact phone, operator extension, operator phone, ticket subject). Scoping
		// only the driving table would leave four ways for a neighbour's value to land
		// in the file, so every join condition carries the tenant too.
		.leftJoin(
			contacts,
			and(eq(calls.contactId, contacts.id), eq(contacts.tenantId, calls.tenantId))
		)
		.leftJoin(
			operatorProfiles,
			and(eq(calls.operatorId, operatorProfiles.id), eq(operatorProfiles.tenantId, calls.tenantId))
		)
		.leftJoin(
			users,
			and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, operatorProfiles.tenantId))
		)
		.leftJoin(tickets, and(eq(calls.ticketId, tickets.id), eq(tickets.tenantId, calls.tenantId)))
		.where(tenantWhere(calls, query.tenantId, query.condition))
		// id — barqaror sahifalash uchun ikkinchi darajali tartib.
		.orderBy(desc(calls.startedAt), desc(calls.id))
		.limit(limit)
		.offset(offset);

	return rows.map((row) => ({
		id: row.id,
		startedAt: row.startedAt.toISOString(),
		answeredAt: row.answeredAt?.toISOString() ?? null,
		endedAt: row.endedAt?.toISOString() ?? null,
		direction: row.direction,
		status: row.status,
		callerNumber: row.callerNumber,
		calleeExtension: row.calleeExtension,
		durationSeconds: row.duration ?? null,
		waitSeconds: row.answeredAt
			? Math.max(0, Math.round((row.answeredAt.getTime() - row.startedAt.getTime()) / 1000))
			: null,
		contactName: joinName(row.contactFirstName, row.contactLastName),
		contactPhone: row.contactPhone,
		operatorExtension: row.operatorExtension,
		operatorPhone: row.operatorPhone,
		ticketId: row.ticketId,
		ticketSubject: row.ticketSubject,
		aiStatus: row.aiStatus,
	}));
}

export const callsReportHandler: AppRouteHandler<typeof r.callsReport> = async (c) => {
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query");
	const bounds = resolveRange(query.from, query.to);

	// Mavjud bo'lmagan operator uchun bo'sh jadval emas, tushunarli 404.
	if (query.operatorId) {
		await loadOperatorRef(tenantId, query.operatorId);
	}

	const scoped: ReportQuery = { tenantId, condition: buildCallWhere(bounds, query) };
	const offset = (query.page - 1) * query.limit;

	const [total, summary, items] = await Promise.all([
		countCalls(scoped),
		loadCallsSummary(scoped),
		selectCallRows(scoped, query.limit, offset),
	]);

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
				summary,
				range: bounds.range,
			},
		},
		200
	);
};

export const callsExportHandler: AppRouteHandler<typeof r.callsExport> = async (c) => {
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query");
	const bounds = resolveRange(query.from, query.to);
	const operator = query.operatorId ? await loadOperatorRef(tenantId, query.operatorId) : null;
	const scoped: ReportQuery = { tenantId, condition: buildCallWhere(bounds, query) };

	const rowCount = await countCalls(scoped);

	assertExportSize(rowCount, bounds.range);

	const [summary, rows, exportedBy] = await Promise.all([
		loadCallsSummary(scoped),
		selectCallRows(scoped, MAX_EXPORT_ROWS, 0),
		describeCurrentUser(c),
	]);

	const context: ReportContext = {
		range: bounds.range,
		filters: describeCallFilters({
			operatorLabel: operator?.label ?? null,
			status: query.status ?? null,
			direction: query.direction ?? null,
		}),
		exportedBy,
		rowCount,
		organizationName: await readOrganizationName(tenantId),
	};

	const file = await renderExport(buildCallsDocument(rows, summary, context), query.format);

	await audit(c, {
		action: "reports.calls.export",
		entityType: "report",
		details: {
			report: "calls",
			format: query.format,
			from: bounds.range.from,
			to: bounds.range.to,
			days: bounds.range.days,
			rowCount,
			fileName: file.fileName,
			filters: {
				operatorId: query.operatorId ?? null,
				status: query.status ?? null,
				direction: query.direction ?? null,
			},
		},
	});

	return toFileResponse(file);
};

// --- Murojaatlar hisoboti ----------------------------------------------------

type TicketFilters = {
	createdBy?: string;
	status?: "new" | "in_progress" | "resolved" | "closed" | "reopened";
	priority?: "low" | "medium" | "high";
	category?: string;
};

function buildTicketWhere(bounds: ResolvedRange, filters: TicketFilters): SQL | undefined {
	const conditions: (SQL | undefined)[] = [
		eq(tickets.isDeleted, false),
		gte(tickets.createdAt, bounds.start),
		lte(tickets.createdAt, bounds.end),
	];

	if (filters.createdBy) {
		conditions.push(eq(tickets.createdBy, filters.createdBy));
	}
	if (filters.status) {
		conditions.push(eq(tickets.status, filters.status));
	}
	if (filters.priority) {
		conditions.push(eq(tickets.priority, filters.priority));
	}
	if (filters.category) {
		conditions.push(ilike(tickets.category, `%${escapeLikePattern(filters.category)}%`));
	}

	return and(...conditions);
}

async function countTickets(query: ReportQuery): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(tickets)
		.where(tenantWhere(tickets, query.tenantId, query.condition));

	return toNumber(row?.value);
}

async function loadTicketsSummary(query: ReportQuery): Promise<TicketsSummary> {
	const [row] = await db
		.select({
			totalTickets: sql<number>`count(*)`,
			statusNew: sql<number>`count(*) filter (where ${tickets.status} = 'new')`,
			statusInProgress: sql<number>`count(*) filter (where ${tickets.status} = 'in_progress')`,
			statusResolved: sql<number>`count(*) filter (where ${tickets.status} = 'resolved')`,
			statusClosed: sql<number>`count(*) filter (where ${tickets.status} = 'closed')`,
			statusReopened: sql<number>`count(*) filter (where ${tickets.status} = 'reopened')`,
			priorityLow: sql<number>`count(*) filter (where ${tickets.priority} = 'low')`,
			priorityMedium: sql<number>`count(*) filter (where ${tickets.priority} = 'medium')`,
			priorityHigh: sql<number>`count(*) filter (where ${tickets.priority} = 'high')`,
			sentimentPositive: sql<number>`count(*) filter (where ${tickets.aiSentiment} = 'positive')`,
			sentimentNeutral: sql<number>`count(*) filter (where ${tickets.aiSentiment} = 'neutral')`,
			sentimentNegative: sql<number>`count(*) filter (where ${tickets.aiSentiment} = 'negative')`,
			sentimentUnknown: sql<number>`count(*) filter (where ${tickets.aiSentiment} is null)`,
			resolutionSampleCount: sql<number>`count(*) filter (where ${tickets.closedAt} is not null)`,
			totalResolutionSeconds: sql<number>`coalesce(sum(extract(epoch from (${tickets.closedAt} - ${tickets.createdAt}))) filter (where ${tickets.closedAt} is not null), 0)`,
		})
		.from(tickets)
		.where(tenantWhere(tickets, query.tenantId, query.condition));

	const totalTickets = toNumber(row?.totalTickets);
	const statusClosed = toNumber(row?.statusClosed);
	const resolutionSampleCount = toNumber(row?.resolutionSampleCount);
	const totalResolutionSeconds = toNumber(row?.totalResolutionSeconds);

	return {
		totalTickets,
		statusNew: toNumber(row?.statusNew),
		statusInProgress: toNumber(row?.statusInProgress),
		statusResolved: toNumber(row?.statusResolved),
		statusClosed,
		statusReopened: toNumber(row?.statusReopened),
		priorityLow: toNumber(row?.priorityLow),
		priorityMedium: toNumber(row?.priorityMedium),
		priorityHigh: toNumber(row?.priorityHigh),
		sentimentPositive: toNumber(row?.sentimentPositive),
		sentimentNeutral: toNumber(row?.sentimentNeutral),
		sentimentNegative: toNumber(row?.sentimentNegative),
		sentimentUnknown: toNumber(row?.sentimentUnknown),
		closedRate: rateOf(statusClosed, totalTickets),
		avgResolutionHours:
			resolutionSampleCount > 0
				? round1(totalResolutionSeconds / resolutionSampleCount / SECONDS_PER_HOUR)
				: null,
		resolutionSampleCount,
	};
}

async function selectTicketRows(
	query: ReportQuery,
	limit: number,
	offset: number
): Promise<TicketReportRow[]> {
	const rows = await db
		.select({
			id: tickets.id,
			createdAt: tickets.createdAt,
			updatedAt: tickets.updatedAt,
			closedAt: tickets.closedAt,
			subject: tickets.subject,
			category: tickets.category,
			priority: tickets.priority,
			status: tickets.status,
			externalRefId: tickets.externalRefId,
			aiSentiment: tickets.aiSentiment,
			aiConfidence: tickets.aiConfidence,
			contactFirstName: contacts.firstName,
			contactLastName: contacts.lastName,
			contactPhone: contacts.phoneNumber,
			createdByPhone: users.phone,
			createdByUsername: users.username,
		})
		.from(tickets)
		// Ikkala join ham eksport ustunini beradi (kontakt ismi/telefoni, kim yaratgan),
		// shuning uchun tenant join shartida ham bor.
		.leftJoin(
			contacts,
			and(eq(tickets.contactId, contacts.id), eq(contacts.tenantId, tickets.tenantId))
		)
		.leftJoin(users, and(eq(tickets.createdBy, users.id), eq(users.tenantId, tickets.tenantId)))
		.where(tenantWhere(tickets, query.tenantId, query.condition))
		.orderBy(desc(tickets.createdAt), desc(tickets.id))
		.limit(limit)
		.offset(offset);

	return rows.map((row) => ({
		id: row.id,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		closedAt: row.closedAt?.toISOString() ?? null,
		subject: row.subject,
		category: row.category,
		priority: row.priority,
		status: row.status,
		contactName: joinName(row.contactFirstName, row.contactLastName),
		contactPhone: row.contactPhone,
		createdByPhone: row.createdByPhone,
		createdByUsername: row.createdByUsername,
		externalRefId: row.externalRefId,
		aiSentiment: row.aiSentiment,
		aiConfidence: row.aiConfidence,
		resolutionHours: row.closedAt
			? round1((row.closedAt.getTime() - row.createdAt.getTime()) / 1000 / SECONDS_PER_HOUR)
			: null,
	}));
}

export const ticketsReportHandler: AppRouteHandler<typeof r.ticketsReport> = async (c) => {
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query");
	const bounds = resolveRange(query.from, query.to);
	const operator = query.operatorId ? await loadOperatorRef(tenantId, query.operatorId) : null;
	const scoped: ReportQuery = {
		tenantId,
		condition: buildTicketWhere(bounds, {
			createdBy: operator?.userId,
			status: query.status,
			priority: query.priority,
			category: query.category,
		}),
	};
	const offset = (query.page - 1) * query.limit;

	const [total, summary, items] = await Promise.all([
		countTickets(scoped),
		loadTicketsSummary(scoped),
		selectTicketRows(scoped, query.limit, offset),
	]);

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
				summary,
				range: bounds.range,
			},
		},
		200
	);
};

export const ticketsExportHandler: AppRouteHandler<typeof r.ticketsExport> = async (c) => {
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query");
	const bounds = resolveRange(query.from, query.to);
	const operator = query.operatorId ? await loadOperatorRef(tenantId, query.operatorId) : null;
	const scoped: ReportQuery = {
		tenantId,
		condition: buildTicketWhere(bounds, {
			createdBy: operator?.userId,
			status: query.status,
			priority: query.priority,
			category: query.category,
		}),
	};

	const rowCount = await countTickets(scoped);

	assertExportSize(rowCount, bounds.range);

	const [summary, rows, exportedBy] = await Promise.all([
		loadTicketsSummary(scoped),
		selectTicketRows(scoped, MAX_EXPORT_ROWS, 0),
		describeCurrentUser(c),
	]);

	const context: ReportContext = {
		range: bounds.range,
		filters: describeTicketFilters({
			operatorLabel: operator?.label ?? null,
			status: query.status ?? null,
			priority: query.priority ?? null,
			category: query.category ?? null,
		}),
		exportedBy,
		rowCount,
		organizationName: await readOrganizationName(tenantId),
	};

	const file = await renderExport(buildTicketsDocument(rows, summary, context), query.format);

	await audit(c, {
		action: "reports.tickets.export",
		entityType: "report",
		details: {
			report: "tickets",
			format: query.format,
			from: bounds.range.from,
			to: bounds.range.to,
			days: bounds.range.days,
			rowCount,
			fileName: file.fileName,
			filters: {
				operatorId: query.operatorId ?? null,
				status: query.status ?? null,
				priority: query.priority ?? null,
				category: query.category ?? null,
			},
		},
	});

	return toFileResponse(file);
};

// --- Operatorlar hisoboti ----------------------------------------------------

type OperatorFilters = {
	operatorId?: string;
	direction?: "inbound" | "outbound";
};

/**
 * Operator kesimidagi hisobot. Qo'ng'iroq va murojaat jamlanmalari alohida
 * subquery'larda hisoblanadi, so'ng operator profillariga LEFT JOIN qilinadi —
 * shunda faoliyati bo'lmagan operator ham 0 bilan ko'rinadi.
 */
function buildOperatorQueryParts(
	tenantId: TenantId,
	bounds: ResolvedRange,
	filters: OperatorFilters
) {
	// Both aggregates are SUBQUERIES, and a subquery is where an unscoped filter is
	// hardest to see: the outer query looks fine while every operator's totals are
	// summed over the whole platform.
	const callConditions = [
		gte(calls.startedAt, bounds.start),
		lte(calls.startedAt, bounds.end),
		isNotNull(calls.operatorId),
		filters.direction ? eq(calls.direction, filters.direction) : undefined,
	];

	const callAgg = db
		.select({
			operatorId: calls.operatorId,
			totalCalls: sql<number>`count(*)`.as("total_calls"),
			inboundCalls: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')`.as(
				"inbound_calls"
			),
			outboundCalls: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')`.as(
				"outbound_calls"
			),
			answeredCalls: sql<number>`count(*) filter (where ${answeredCondition})`.as("answered_calls"),
			missedCalls: sql<number>`count(*) filter (where ${calls.status} = 'missed')`.as(
				"missed_calls"
			),
			abandonedCalls: sql<number>`count(*) filter (where ${calls.status} = 'abandoned')`.as(
				"abandoned_calls"
			),
			talkSampleCount:
				sql<number>`count(*) filter (where ${answeredCondition} and ${calls.duration} is not null)`.as(
					"talk_sample_count"
				),
			totalTalkSeconds:
				sql<number>`coalesce(sum(${calls.duration}) filter (where ${answeredCondition}), 0)`.as(
					"total_talk_seconds"
				),
			waitSampleCount: sql<number>`count(*) filter (where ${calls.answeredAt} is not null)`.as(
				"wait_sample_count"
			),
			totalWaitSeconds:
				sql<number>`coalesce(sum(extract(epoch from (${calls.answeredAt} - ${calls.startedAt}))) filter (where ${calls.answeredAt} is not null), 0)`.as(
					"total_wait_seconds"
				),
		})
		.from(calls)
		.where(tenantWhere(calls, tenantId, ...callConditions))
		.groupBy(calls.operatorId)
		.as("call_agg");

	const ticketAgg = db
		.select({
			createdBy: tickets.createdBy,
			ticketsCreated: sql<number>`count(*)`.as("tickets_created"),
		})
		.from(tickets)
		.where(
			tenantWhere(
				tickets,
				tenantId,
				eq(tickets.isDeleted, false),
				gte(tickets.createdAt, bounds.start),
				lte(tickets.createdAt, bounds.end)
			)
		)
		.groupBy(tickets.createdBy)
		.as("ticket_agg");

	const conditions: (SQL | undefined)[] = [];

	if (filters.operatorId) {
		conditions.push(eq(operatorProfiles.id, filters.operatorId));
	}

	// O'chirilgan profil tarixdan yo'qolmasligi kerak: oraliqda faoliyati
	// bo'lgan bo'lsa hisobotda qoladi (isDeleted maydoni bilan belgilanadi).
	conditions.push(
		or(
			eq(operatorProfiles.isDeleted, false),
			isNotNull(callAgg.operatorId),
			isNotNull(ticketAgg.createdBy)
		)
	);

	// `where` deliberately holds only the request's own conditions; the tenant is
	// carried alongside and applied by each of the three outer queries below.
	return { tenantId, callAgg, ticketAgg, where: and(...conditions) };
}

/**
 * Operatorga bog'lanmagan qo'ng'iroqlar (operatorId NULL). Bu son xulosada
 * alohida ko'rsatiladi — aks holda operatorlar hisoboti jamlanmasi
 * qo'ng'iroqlar hisoboti jamlanmasidan farq qilib, tushunarsiz bo'lib qoladi.
 */
async function countUnassignedCalls(
	tenantId: TenantId,
	bounds: ResolvedRange,
	filters: OperatorFilters
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(calls)
		.where(
			tenantWhere(
				calls,
				tenantId,
				gte(calls.startedAt, bounds.start),
				lte(calls.startedAt, bounds.end),
				isNull(calls.operatorId),
				filters.direction ? eq(calls.direction, filters.direction) : undefined
			)
		);

	return toNumber(row?.value);
}

type OperatorQueryParts = ReturnType<typeof buildOperatorQueryParts>;

async function countOperatorRows(parts: OperatorQueryParts): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(operatorProfiles)
		.innerJoin(
			users,
			and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, operatorProfiles.tenantId))
		)
		.leftJoin(parts.callAgg, eq(parts.callAgg.operatorId, operatorProfiles.id))
		.leftJoin(parts.ticketAgg, eq(parts.ticketAgg.createdBy, operatorProfiles.userId))
		.where(tenantWhere(operatorProfiles, parts.tenantId, parts.where));

	return toNumber(row?.value);
}

async function selectOperatorRows(
	parts: OperatorQueryParts,
	limit: number,
	offset: number
): Promise<OperatorReportRow[]> {
	const rows = await db
		.select({
			operatorId: operatorProfiles.id,
			userId: operatorProfiles.userId,
			extension: operatorProfiles.extension,
			currentStatus: operatorProfiles.currentStatus,
			isDeleted: operatorProfiles.isDeleted,
			userPhone: users.phone,
			username: users.username,
			totalCalls: parts.callAgg.totalCalls,
			inboundCalls: parts.callAgg.inboundCalls,
			outboundCalls: parts.callAgg.outboundCalls,
			answeredCalls: parts.callAgg.answeredCalls,
			missedCalls: parts.callAgg.missedCalls,
			abandonedCalls: parts.callAgg.abandonedCalls,
			talkSampleCount: parts.callAgg.talkSampleCount,
			totalTalkSeconds: parts.callAgg.totalTalkSeconds,
			waitSampleCount: parts.callAgg.waitSampleCount,
			totalWaitSeconds: parts.callAgg.totalWaitSeconds,
			ticketsCreated: parts.ticketAgg.ticketsCreated,
		})
		.from(operatorProfiles)
		.innerJoin(
			users,
			and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, operatorProfiles.tenantId))
		)
		.leftJoin(parts.callAgg, eq(parts.callAgg.operatorId, operatorProfiles.id))
		.leftJoin(parts.ticketAgg, eq(parts.ticketAgg.createdBy, operatorProfiles.userId))
		.where(tenantWhere(operatorProfiles, parts.tenantId, parts.where))
		.orderBy(desc(sql`coalesce(${parts.callAgg.totalCalls}, 0)`), asc(operatorProfiles.extension))
		.limit(limit)
		.offset(offset);

	return rows.map((row) => {
		const totalCalls = toNumber(row.totalCalls);
		const answeredCalls = toNumber(row.answeredCalls);
		const talkSampleCount = toNumber(row.talkSampleCount);
		const totalTalkSeconds = Math.round(toNumber(row.totalTalkSeconds));
		const waitSampleCount = toNumber(row.waitSampleCount);
		const totalWaitSeconds = Math.round(toNumber(row.totalWaitSeconds));

		return {
			operatorId: row.operatorId,
			userId: row.userId,
			extension: row.extension,
			userPhone: row.userPhone,
			username: row.username,
			currentStatus: row.currentStatus,
			isDeleted: row.isDeleted,
			totalCalls,
			inboundCalls: toNumber(row.inboundCalls),
			outboundCalls: toNumber(row.outboundCalls),
			answeredCalls,
			missedCalls: toNumber(row.missedCalls),
			abandonedCalls: toNumber(row.abandonedCalls),
			answeredRate: rateOf(answeredCalls, totalCalls),
			avgTalkSeconds: averageOf(totalTalkSeconds, talkSampleCount),
			totalTalkSeconds,
			talkSampleCount,
			avgWaitSeconds: averageOf(totalWaitSeconds, waitSampleCount),
			waitSampleCount,
			ticketsCreated: toNumber(row.ticketsCreated),
		};
	});
}

/**
 * Jamlanma sahifadan emas, butun to'plamdan hisoblanadi. O'rtachalar namuna
 * yig'indilari orqali chiqariladi — o'rtachalarning o'rtachasi olinmaydi.
 */
async function loadOperatorsSummary(
	parts: OperatorQueryParts,
	bounds: ResolvedRange,
	filters: OperatorFilters
): Promise<OperatorsSummary> {
	const [rows, unassignedCalls] = await Promise.all([
		db
			.select({
				operatorCount: sql<number>`count(*)`,
				totalCalls: sql<number>`coalesce(sum(coalesce(${parts.callAgg.totalCalls}, 0)), 0)`,
				inboundCalls: sql<number>`coalesce(sum(coalesce(${parts.callAgg.inboundCalls}, 0)), 0)`,
				outboundCalls: sql<number>`coalesce(sum(coalesce(${parts.callAgg.outboundCalls}, 0)), 0)`,
				answeredCalls: sql<number>`coalesce(sum(coalesce(${parts.callAgg.answeredCalls}, 0)), 0)`,
				missedCalls: sql<number>`coalesce(sum(coalesce(${parts.callAgg.missedCalls}, 0)), 0)`,
				abandonedCalls: sql<number>`coalesce(sum(coalesce(${parts.callAgg.abandonedCalls}, 0)), 0)`,
				talkSampleCount: sql<number>`coalesce(sum(coalesce(${parts.callAgg.talkSampleCount}, 0)), 0)`,
				totalTalkSeconds: sql<number>`coalesce(sum(coalesce(${parts.callAgg.totalTalkSeconds}, 0)), 0)`,
				waitSampleCount: sql<number>`coalesce(sum(coalesce(${parts.callAgg.waitSampleCount}, 0)), 0)`,
				totalWaitSeconds: sql<number>`coalesce(sum(coalesce(${parts.callAgg.totalWaitSeconds}, 0)), 0)`,
				ticketsCreated: sql<number>`coalesce(sum(coalesce(${parts.ticketAgg.ticketsCreated}, 0)), 0)`,
			})
			.from(operatorProfiles)
			.innerJoin(
				users,
				and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, operatorProfiles.tenantId))
			)
			.leftJoin(parts.callAgg, eq(parts.callAgg.operatorId, operatorProfiles.id))
			.leftJoin(parts.ticketAgg, eq(parts.ticketAgg.createdBy, operatorProfiles.userId))
			.where(tenantWhere(operatorProfiles, parts.tenantId, parts.where)),
		countUnassignedCalls(parts.tenantId, bounds, filters),
	]);

	const row = rows[0];
	const totalCalls = toNumber(row?.totalCalls);
	const answeredCalls = toNumber(row?.answeredCalls);
	const talkSampleCount = toNumber(row?.talkSampleCount);
	const totalTalkSeconds = Math.round(toNumber(row?.totalTalkSeconds));
	const waitSampleCount = toNumber(row?.waitSampleCount);
	const totalWaitSeconds = Math.round(toNumber(row?.totalWaitSeconds));

	return {
		operatorCount: toNumber(row?.operatorCount),
		totalCalls,
		inboundCalls: toNumber(row?.inboundCalls),
		outboundCalls: toNumber(row?.outboundCalls),
		answeredCalls,
		missedCalls: toNumber(row?.missedCalls),
		abandonedCalls: toNumber(row?.abandonedCalls),
		answeredRate: rateOf(answeredCalls, totalCalls),
		avgTalkSeconds: averageOf(totalTalkSeconds, talkSampleCount),
		totalTalkSeconds,
		talkSampleCount,
		avgWaitSeconds: averageOf(totalWaitSeconds, waitSampleCount),
		waitSampleCount,
		ticketsCreated: toNumber(row?.ticketsCreated),
		unassignedCalls,
	};
}

export const operatorsReportHandler: AppRouteHandler<typeof r.operatorsReport> = async (c) => {
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query");
	const bounds = resolveRange(query.from, query.to);

	if (query.operatorId) {
		await loadOperatorRef(tenantId, query.operatorId);
	}

	const parts = buildOperatorQueryParts(tenantId, bounds, query);
	const offset = (query.page - 1) * query.limit;

	const [total, summary, items] = await Promise.all([
		countOperatorRows(parts),
		loadOperatorsSummary(parts, bounds, query),
		selectOperatorRows(parts, query.limit, offset),
	]);

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
				summary,
				range: bounds.range,
			},
		},
		200
	);
};

export const operatorsExportHandler: AppRouteHandler<typeof r.operatorsExport> = async (c) => {
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query");
	const bounds = resolveRange(query.from, query.to);
	const operator = query.operatorId ? await loadOperatorRef(tenantId, query.operatorId) : null;
	const parts = buildOperatorQueryParts(tenantId, bounds, query);

	const rowCount = await countOperatorRows(parts);

	assertExportSize(rowCount, bounds.range);

	const [summary, rows, exportedBy] = await Promise.all([
		loadOperatorsSummary(parts, bounds, query),
		selectOperatorRows(parts, MAX_EXPORT_ROWS, 0),
		describeCurrentUser(c),
	]);

	const context: ReportContext = {
		range: bounds.range,
		filters: describeOperatorFilters({
			operatorLabel: operator?.label ?? null,
			direction: query.direction ?? null,
		}),
		exportedBy,
		rowCount,
		organizationName: await readOrganizationName(tenantId),
	};

	const file = await renderExport(buildOperatorsDocument(rows, summary, context), query.format);

	await audit(c, {
		action: "reports.operators.export",
		entityType: "report",
		details: {
			report: "operators",
			format: query.format,
			from: bounds.range.from,
			to: bounds.range.to,
			days: bounds.range.days,
			rowCount,
			fileName: file.fileName,
			filters: {
				operatorId: query.operatorId ?? null,
				direction: query.direction ?? null,
			},
		},
	});

	return toFileResponse(file);
};
