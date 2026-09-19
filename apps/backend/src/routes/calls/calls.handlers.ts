import type { UserRoleType } from "@shared/types";
import { and, count, desc, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	aiAnalyses,
	aiSessions,
	callRecordings,
	calls,
	callTranscripts,
	contacts,
	operatorProfiles,
	users,
} from "@/db/schema";
import { buildSessionCostView, loadRates, type RateTable } from "@/lib/ai-cost";
import { notFound } from "@/lib/errors";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import {
	costDurationMs,
	displayName,
	toAnalysisTokens,
	toSessionTokens,
} from "./calls.full.handlers";
import type * as r from "./calls.routes";
import type { ExportQuery, ListQuery } from "./calls.schemas";

const CAN_SEE_ALL_CALLS: UserRoleType[] = ["admin", "supervisor"];

/**
 * Who may see what a call cost.
 *
 * The same two roles /ai-costs and GET /calls/{id}/full are gated to. A figure a
 * manager is refused on the detail page must not be readable by scrolling the
 * list, or the restriction is decorative.
 */
const CAN_SEE_COST: UserRoleType[] = ["admin", "supervisor"];

/**
 * "This call produced audio."
 *
 * Two sources, because two things write recordings: the AI/ARI path inserts a
 * `call_recordings` row, while the legacy FreePBX call-end webhook only sets
 * `calls.recording_path`. Reading one of them would hide half the recordings -
 * the same fallback GET /calls/{id}/full already makes.
 */
const hasRecordingExpr = sql<number>`(
	${calls.recordingPath} is not null
	or exists (
		select 1 from ${callRecordings}
		where ${callRecordings.callId} = ${calls.id}
			and ${callRecordings.tenantId} = ${calls.tenantId}
	)
)::int`;

const hasTranscriptExpr = sql<number>`(
	exists (
		select 1 from ${callTranscripts}
		where ${callTranscripts.callId} = ${calls.id}
			and ${callTranscripts.tenantId} = ${calls.tenantId}
	)
)::int`;

/** Postgres booleans arrive as booleans, but the ::int cast makes it true either way. */
function toBool(value: number | string | boolean): boolean {
	return value === true || Number(value) === 1;
}

/**
 * Every column the list row and its cost need, in one row per call.
 *
 * ai_analyses and ai_sessions are unique on call_id and the rest are plain
 * foreign keys, so no join here can duplicate a call.
 */
function listSelection() {
	return {
		id: calls.id,
		direction: calls.direction,
		callerNumber: calls.callerNumber,
		calleeExtension: calls.calleeExtension,
		contactId: calls.contactId,
		operatorId: calls.operatorId,
		ticketId: calls.ticketId,
		status: calls.status,
		duration: calls.duration,
		recordingPath: calls.recordingPath,
		aiStatus: calls.aiStatus,
		startedAt: calls.startedAt,
		endedAt: calls.endedAt,
		createdAt: calls.createdAt,

		contactFirstName: contacts.firstName,
		contactLastName: contacts.lastName,

		operatorExtension: operatorProfiles.extension,
		operatorUsername: users.username,
		operatorPhone: users.phone,

		analysisSentiment: aiAnalyses.sentiment,

		hasRecording: hasRecordingExpr,
		hasTranscript: hasTranscriptExpr,

		analysisId: aiAnalyses.id,
		analysisPromptTokens: aiAnalyses.promptTokens,
		analysisCachedPromptTokens: aiAnalyses.cachedPromptTokens,
		analysisCompletionTokens: aiAnalyses.completionTokens,
		analysisBilledRuns: aiAnalyses.billedRuns,

		sessionId: aiSessions.id,
		sessionProvider: aiSessions.provider,
		sessionDurationMs: aiSessions.durationMs,
		sessionPromptTokens: aiSessions.promptTokens,
		sessionCompletionTokens: aiSessions.completionTokens,
		sessionCachedPromptTokens: aiSessions.cachedPromptTokens,
		sessionCachedAudioTokens: aiSessions.cachedAudioTokens,
		sessionCachedTextTokens: aiSessions.cachedTextTokens,
		sessionInputTextTokens: aiSessions.inputTextTokens,
		sessionInputAudioTokens: aiSessions.inputAudioTokens,
		sessionOutputTextTokens: aiSessions.outputTextTokens,
		sessionOutputAudioTokens: aiSessions.outputAudioTokens,
		sessionTranscribeAudioTokens: aiSessions.transcribeAudioTokens,
		sessionTranscribeTextTokens: aiSessions.transcribeTextTokens,
	};
}

type ListRow = Awaited<ReturnType<typeof queryRows>>[number];

function queryRows(where: ReturnType<typeof buildWhere>, limit: number, offset: number) {
	return (
		db
			.select(listSelection())
			.from(calls)
			// Every join names the tenant as well as the foreign key. The keys are already
			// consistent, so no result changes today: it is here because a join is the blind
			// spot both the type system and the query scanner admit to - scoping `calls` and
			// joining `contacts` on the id alone READS as scoped - and this is the platform's
			// most-read screen.
			.leftJoin(
				contacts,
				and(eq(calls.contactId, contacts.id), eq(contacts.tenantId, calls.tenantId))
			)
			.leftJoin(
				operatorProfiles,
				and(
					eq(calls.operatorId, operatorProfiles.id),
					eq(operatorProfiles.tenantId, calls.tenantId)
				)
			)
			.leftJoin(
				users,
				and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, calls.tenantId))
			)
			.leftJoin(
				aiAnalyses,
				and(eq(aiAnalyses.callId, calls.id), eq(aiAnalyses.tenantId, calls.tenantId))
			)
			.leftJoin(
				aiSessions,
				and(eq(aiSessions.callId, calls.id), eq(aiSessions.tenantId, calls.tenantId))
			)
			.where(where)
			.orderBy(desc(calls.startedAt))
			.limit(limit)
			.offset(offset)
	);
}

/**
 * The same predicate as the page query.
 *
 * ai_analyses has to be joined here too - `sentiment` lives there, and a count
 * that ignored the sentiment filter would page a list that has fewer rows than
 * the pager claims.
 */
function queryCount(where: ReturnType<typeof buildWhere>) {
	return db
		.select({ count: count() })
		.from(calls)
		.leftJoin(
			aiAnalyses,
			and(eq(aiAnalyses.callId, calls.id), eq(aiAnalyses.tenantId, calls.tenantId))
		)
		.where(where);
}

/** "Has audio" / "has no audio", over both places a recording can be recorded. */
function recordingCondition(wanted: "true" | "false") {
	// The correlated subqueries compare `tenant_id` against `calls.tenant_id` rather
	// than a bound parameter: the row they are correlated to is already scoped, so
	// comparing the two columns says "the same customer's recording" without a second
	// place for the request's tenant to be threaded - or forgotten.
	if (wanted === "true") {
		return or(
			isNotNull(calls.recordingPath),
			sql`exists (
				select 1 from ${callRecordings}
				where ${callRecordings.callId} = ${calls.id}
					and ${callRecordings.tenantId} = ${calls.tenantId}
			)`
		);
	}

	return and(
		isNull(calls.recordingPath),
		sql`not exists (
			select 1 from ${callRecordings}
			where ${callRecordings.callId} = ${calls.id}
				and ${callRecordings.tenantId} = ${calls.tenantId}
		)`
	);
}

/**
 * Match a number however Asterisk happened to write it.
 *
 * `calls.caller_number` is whatever arrived on the wire, and this database alone
 * holds four shapes for it: "201" (an internal extension), "anonymous" (caller ID
 * withheld), "905706507" (national, no country code) and "998905706507" (with
 * one). The filter's own placeholder asks for "+998901234567", which under exact
 * equality matched nothing at all - the control looked broken because it was.
 *
 * So the comparison is on the last nine digits, which is the part that identifies
 * an Uzbek subscriber whatever prefix precedes it. A short internal extension is
 * compared whole, since it has no nine-digit tail to take.
 *
 * "anonymous" is deliberately NOT handled: the query schema only accepts an E.164
 * shape, so a branch for it here would be unreachable. Filtering for withheld
 * numbers needs the schema widened first, and that is a decision about the input
 * contract rather than a line of SQL.
 */
function phoneCondition(raw: string | undefined) {
	const digits = (raw ?? "").replace(/\D/g, "");

	if (digits.length === 0) {
		return undefined;
	}

	const tail = digits.length > 9 ? digits.slice(-9) : digits;

	return sql`regexp_replace(${calls.callerNumber}, '\D', '', 'g') like ${`%${tail}`}`;
}

function buildWhere(query: ListQuery | ExportQuery, tenantId: TenantId, scope: CallScope) {
	const conditions = [
		// The tenant first, matching idx_calls_tenant_created. Everything after it only
		// narrows: the list is ANDed, so no filter, sort or page parameter can widen the
		// set back out past the customer.
		eq(calls.tenantId, tenantId),
		scopeCondition(scope),
		phoneCondition(query.phoneNumber),
		query.status ? eq(calls.status, query.status) : undefined,
		query.direction ? eq(calls.direction, query.direction) : undefined,
		query.operatorId ? eq(calls.operatorId, query.operatorId) : undefined,
		query.from ? gte(calls.startedAt, new Date(query.from)) : undefined,
		query.to ? lte(calls.startedAt, new Date(query.to)) : undefined,
		query.aiStatus ? eq(calls.aiStatus, query.aiStatus) : undefined,
		query.sentiment ? eq(aiAnalyses.sentiment, query.sentiment) : undefined,
		query.hasRecording ? recordingCondition(query.hasRecording) : undefined,
	].filter((condition) => condition !== undefined);

	return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Which calls a caller may see.
 *
 * `calls.operator_id` points at `operator_profiles`, not at `users` - scoping by
 * the user id silently matches nothing.
 *
 * The three cases are kept apart deliberately. A bare `string | null` collapsed
 * "privileged, no filter needed" and "not privileged and has no profile" into the
 * same null, and the caller turned that null into no condition at all - so a
 * manager whose operator profile was soft-deleted saw every call in the company.
 * A missing profile now scopes to nothing, which is the safe reading of "we
 * cannot tell which calls are theirs".
 */
type CallScope = { kind: "all" } | { kind: "operator"; profileId: string } | { kind: "none" };

async function resolveCallScope(
	tenantId: TenantId,
	userId: string,
	role: UserRoleType
): Promise<CallScope> {
	if (CAN_SEE_ALL_CALLS.includes(role)) {
		return { kind: "all" };
	}

	const profile = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.userId, userId),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: { id: true },
	});

	return profile === undefined ? { kind: "none" } : { kind: "operator", profileId: profile.id };
}

/** The scope as a where-clause fragment: undefined for "all", never-true for "none". */
function scopeCondition(scope: CallScope) {
	if (scope.kind === "all") {
		return undefined;
	}

	if (scope.kind === "none") {
		return sql`false`;
	}

	return eq(calls.operatorId, scope.profileId);
}

/**
 * A call's total spend, or null.
 *
 * Null means "nothing to price": no AI session and no analysis ever ran, so the
 * call cost nothing to the models and a 0 would read as a measurement. The
 * arithmetic itself is the shared one - same rates, same flattening as the
 * detail page and /ai-costs, so the three cannot quote different numbers.
 */
function rowCostUsd(row: ListRow, rates: RateTable | null): number | null {
	if (rates === null) {
		return null;
	}

	const analysisTokens = toAnalysisTokens(row);

	if (row.sessionId === null && analysisTokens === null) {
		return null;
	}

	return buildSessionCostView({
		tokens: toSessionTokens(row),
		provider: row.sessionProvider ?? "",
		analysis: analysisTokens,
		rates,
		durationMs: costDurationMs(row.sessionDurationMs, row.duration),
	}).totalCostUsd;
}

function toItem(row: ListRow, rates: RateTable | null) {
	const contactName = [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ") || null;

	return {
		id: row.id,
		direction: row.direction,
		callerNumber: row.callerNumber,
		calleeExtension: row.calleeExtension,
		contactId: row.contactId,
		contactName,
		operatorId: row.operatorId,
		ticketId: row.ticketId,
		status: row.status,
		duration: row.duration,
		recordingPath: row.recordingPath,
		aiStatus: row.aiStatus,
		startedAt: row.startedAt.toISOString(),
		endedAt: row.endedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		operatorName:
			row.operatorId === null ? null : displayName(row.operatorUsername, row.operatorPhone),
		operatorExtension: row.operatorExtension,
		hasRecording: toBool(row.hasRecording),
		hasTranscript: toBool(row.hasTranscript),
		sentiment: row.analysisSentiment,
		costUsd: rowCostUsd(row, rates),
	};
}

/** One page of calls, priced when the caller is allowed to see money. */
async function listPage(
	tenantId: TenantId,
	query: ListQuery,
	scope: CallScope,
	costVisible: boolean
) {
	const { page, limit } = query;
	const offset = (page - 1) * limit;
	const where = buildWhere(query, tenantId, scope);

	const [rows, countResult, rates] = await Promise.all([
		queryRows(where, limit, offset),
		queryCount(where),
		costVisible ? loadRates(tenantId).then((loaded) => loaded.rates) : Promise.resolve(null),
	]);

	const totalCount = Number(countResult[0]?.count ?? 0);

	return {
		items: rows.map((row) => toItem(row, rates)),
		meta: { total: totalCount, page, limit, totalPages: Math.ceil(totalCount / limit) },
		costVisible,
	};
}

export const listHandler: AppRouteHandler<typeof r.list> = async (c) => {
	const user = c.get("user");
	const query = c.req.valid("query") as ListQuery;
	const scope = await resolveCallScope(user.tenantId, user.id, user.role);

	return c.json(
		{
			success: true as const,
			data: await listPage(user.tenantId, query, scope, CAN_SEE_COST.includes(user.role)),
		},
		200
	);
};

export const missedHandler: AppRouteHandler<typeof r.missed> = async (c) => {
	const user = c.get("user");
	const query = c.req.valid("query") as ListQuery;
	const scope = await resolveCallScope(user.tenantId, user.id, user.role);

	return c.json(
		{
			success: true as const,
			data: await listPage(
				user.tenantId,
				{ ...query, status: "missed" },
				scope,
				CAN_SEE_COST.includes(user.role)
			),
		},
		200
	);
};

export const getMeStatsHandler: AppRouteHandler<typeof r.getMeStats> = async (c) => {
	const user = c.get("user");

	const profile = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			user.tenantId,
			eq(operatorProfiles.userId, user.id),
			eq(operatorProfiles.isDeleted, false)
		),
	});

	if (!profile) {
		return c.json(
			{
				success: true as const,
				data: {
					totalCalls: 0,
					answeredCalls: 0,
					missedCalls: 0,
					avgTalkTime: 0,
					totalTalkTime: 0,
				},
			},
			200
		);
	}

	const today = new Date();
	today.setHours(0, 0, 0, 0);

	const myCalls = await db
		.select({
			status: calls.status,
			duration: calls.duration,
		})
		.from(calls)
		.where(
			tenantWhere(
				calls,
				user.tenantId,
				eq(calls.operatorId, profile.id),
				gte(calls.startedAt, today)
			)
		);

	const stats = {
		totalCalls: myCalls.length,
		answeredCalls: myCalls.filter((c) => c.status === "completed" || c.status === "answered")
			.length,
		missedCalls: myCalls.filter((c) => c.status === "missed").length,
		totalTalkTime: myCalls.reduce((acc, c) => acc + (c.duration || 0), 0),
		avgTalkTime: 0,
	};

	stats.avgTalkTime =
		stats.answeredCalls > 0 ? Math.floor(stats.totalTalkTime / stats.answeredCalls) : 0;

	return c.json({ success: true as const, data: stats }, 200);
};

export const getHandler: AppRouteHandler<typeof r.get> = async (c) => {
	const user = c.get("user");
	const id = c.req.valid("param").id;

	const rowWithRelations = await db.query.calls.findFirst({
		// Another customer's call is not found rather than refused: the 404 below is the
		// same answer an id that never existed gets.
		where: tenantWhere(calls, user.tenantId, eq(calls.id, id)),
		columns: {
			id: true,
			direction: true,
			callerNumber: true,
			calleeExtension: true,
			contactId: true,
			operatorId: true,
			ticketId: true,
			status: true,
			duration: true,
			recordingPath: true,
			aiStatus: true,
			startedAt: true,
			endedAt: true,
			createdAt: true,
		},
		with: {
			contact: {
				columns: {
					id: true,
					phoneNumber: true,
					firstName: true,
					lastName: true,
				},
			},
			operatorProfile: {
				columns: {
					id: true,
					userId: true,
					extension: true,
				},
				// Operatorning haqiqiy telefoni va ismi shu jadvalda emas —
				// ularsiz javobdagi `phone` maydoniga userId tushib qolardi.
				with: {
					user: {
						columns: {
							username: true,
							phone: true,
						},
					},
				},
			},
		},
	});

	if (!rowWithRelations) {
		throw notFound("Qo'ng'iroq", id);
	}

	const row = rowWithRelations as typeof rowWithRelations & {
		contact?: {
			id: string;
			phoneNumber: string;
			firstName: string | null;
			lastName: string | null;
		} | null;
		operatorProfile?: {
			id: string;
			userId: string;
			extension: string;
			user?: { username: string | null; phone: string } | null;
		} | null;
	};

	if (!CAN_SEE_ALL_CALLS.includes(user.role)) {
		const scope = await resolveCallScope(user.tenantId, user.id, user.role);

		// "none" - no operator profile - can own no call, so this is a 404 rather
		// than a match against null, which used to let such a user open any call
		// that happened to have no operator either.
		if (scope.kind !== "operator" || row.operatorId !== scope.profileId) {
			throw notFound("Qo'ng'iroq", id);
		}
	}

	const contact = row.contact ? (Array.isArray(row.contact) ? row.contact[0] : row.contact) : null;
	const operatorProfile = row.operatorProfile
		? Array.isArray(row.operatorProfile)
			? row.operatorProfile[0]
			: row.operatorProfile
		: null;
	const operatorUser = operatorProfile?.user
		? Array.isArray(operatorProfile.user)
			? operatorProfile.user[0]
			: operatorProfile.user
		: null;

	return c.json(
		{
			success: true as const,
			data: {
				id: row.id,
				direction: row.direction,
				callerNumber: row.callerNumber,
				calleeExtension: row.calleeExtension,
				contactId: row.contactId,
				contactName: row.contact
					? [row.contact.firstName, row.contact.lastName].filter(Boolean).join(" ") || null
					: null,
				operatorId: row.operatorId,
				ticketId: row.ticketId,
				status: row.status,
				duration: row.duration,
				recordingPath: row.recordingPath,
				aiStatus: row.aiStatus,
				startedAt: row.startedAt.toISOString(),
				endedAt: row.endedAt?.toISOString() ?? null,
				createdAt: row.createdAt.toISOString(),
				contact: contact
					? {
							id: contact.id,
							phoneNumber: contact.phoneNumber,
							firstName: contact.firstName,
							lastName: contact.lastName,
						}
					: null,
				operator: operatorProfile
					? {
							id: operatorProfile.id,
							phone: operatorUser?.phone ?? "",
							username: operatorUser?.username ?? null,
							extension: operatorProfile.extension,
						}
					: null,
			},
		},
		200
	);
};

/**
 * The CSV columns.
 *
 * The first fifteen are unchanged and in their original order, so a spreadsheet
 * or importer built against the old file still reads. The four new ones are the
 * list's new columns, appended.
 */
const CSV_HEADERS =
	"id,direction,callerNumber,calleeExtension,contactId,contactName,operatorId,ticketId,status,duration,recordingPath,aiStatus,startedAt,endedAt,createdAt,operatorName,hasRecording,hasTranscript,sentiment,costUsd\n";

function escapeCsv(value: string | null | undefined): string {
	if (value == null) {
		return "";
	}
	const s = String(value);
	if (s.includes(",") || s.includes('"') || s.includes("\n")) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

const EXPORT_ROW_LIMIT = 10_000;

function toCsvRow(item: ReturnType<typeof toItem>): string {
	return [
		item.id,
		item.direction,
		item.callerNumber,
		item.calleeExtension,
		item.contactId,
		item.contactName,
		item.operatorId,
		item.ticketId,
		item.status,
		item.duration,
		item.recordingPath,
		item.aiStatus,
		item.startedAt,
		item.endedAt,
		item.createdAt,
		item.operatorName,
		item.hasRecording ? "1" : "0",
		item.hasTranscript ? "1" : "0",
		item.sentiment,
		item.costUsd,
	]
		.map((value) => escapeCsv(value == null ? "" : String(value)))
		.join(",");
}

export const exportHandler: AppRouteHandler<typeof r.exportCalls> = async (c) => {
	const user = c.get("user");
	const query = c.req.valid("query") as ExportQuery;
	// Scoped by operator PROFILE id, the column `calls.operator_id` actually holds.
	// This used to pass `user.id`, which matches no call ever written, so a manager
	// exporting their own calls received a file with nothing but the header row.
	const scope = await resolveCallScope(user.tenantId, user.id, user.role);
	const costVisible = CAN_SEE_COST.includes(user.role);
	const where = buildWhere(query, currentTenantId(c), scope);

	const [rows, rates] = await Promise.all([
		queryRows(where, EXPORT_ROW_LIMIT, 0),
		costVisible ? loadRates(user.tenantId).then((loaded) => loaded.rates) : Promise.resolve(null),
	]);

	const csvRows = rows.map((row) => toCsvRow(toItem(row, rates)));
	const csv = CSV_HEADERS + csvRows.join("\n");

	return new Response(csv, {
		status: 200,
		headers: {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": 'attachment; filename="calls.csv"',
		},
	});
};
