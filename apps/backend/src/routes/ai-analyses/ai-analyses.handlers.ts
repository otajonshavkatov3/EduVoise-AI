import type { UserRoleType } from "@shared/types";
import { and, asc, count, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "@/db";
import {
	aiAnalyses,
	aiSessions,
	auditLogs,
	calls,
	callTranscripts,
	contacts,
	operatorProfiles,
	tickets,
	users,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { businessError, invalidInput, notFound } from "@/lib/errors";
import { getAiRuntimeConfig } from "@/lib/settings";
import { buildTranscriptText, summariseCallWithOpenAi, writeAiAnalysis } from "@/lib/telephony";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppBindings, AppRouteHandler } from "@/lib/types";
import type * as r from "./ai-analyses.routes";
import type { ListQuery, UpdateBody } from "./ai-analyses.schemas";

/** Admin va Supervisor barcha tahlillarni ko'radi; manager faqat o'zi olgan qo'ng'iroqlarni. */
const CAN_SEE_ALL_ANALYSES: UserRoleType[] = ["admin", "supervisor"];

/**
 * Tahlilni qo'lda tuzatish va qayta ishga tushirish — sifat nazorati amali.
 * TZ 3.9: operator (manager) faqat ko'radi, tekshirish admin/supervisor ishi.
 */
const CAN_EDIT_ANALYSES: UserRoleType[] = ["admin", "supervisor"];

/** Hech qachon mos kelmaydigan uuid — manager operator profiliga ega bo'lmaganda. */
const MATCHES_NOTHING_UUID = "00000000-0000-0000-0000-000000000000";

/** Detalda qaytariladigan transkript qatorlari chegarasi (juda uzun suhbatlar uchun). */
const TRANSCRIPT_LINE_LIMIT = 2000;

const CORRECT_ACTION = "ai-analyses.correct";
const RETRY_ACTION = "ai-analyses.retry";

/**
 * buildTranscriptText qatorlarni "role: matn" ko'rinishida saqlaydi. Saqlangan
 * blokda mijoz gapi bor-yo'qligini shu bo'yicha tekshiramiz — mijoz gapi
 * bo'lmasa qayta tahlil qilinmaydi (orkestratordagi qoida bilan bir xil).
 */
const CALLER_LINE_PATTERN = /^caller:\s*\S/m;

type Sentiment = "positive" | "neutral" | "negative";
type AiStatus = "pending" | "processing" | "completed" | "failed";

/**
 * Ro'yxat/detal uchun bitta qator. Aniq yozilgan (drizzle inferenciyasiga
 * tayanmasdan), shunda select ro'yxati o'zgarsa TS darhol xato beradi.
 */
type AnalysisRow = {
	id: string;
	callId: string;
	status: AiStatus;
	sentiment: Sentiment | null;
	categories: string[] | null;
	confidence: number | null;
	summary: string | null;
	errorMessage: string | null;
	retryCount: number | null;
	processedAt: Date | null;
	createdAt: Date;
	transcriptChars: number;
	callDirection: "inbound" | "outbound";
	callerNumber: string;
	calleeExtension: string | null;
	callStatus: "ringing" | "answered" | "missed" | "abandoned" | "completed";
	callDuration: number | null;
	callAiStatus: AiStatus | null;
	callRecordingPath: string | null;
	callStartedAt: Date;
	callEndedAt: Date | null;
	callTicketId: string | null;
	callOperatorId: string | null;
	operatorExtension: string | null;
	contactId: string | null;
	contactPhone: string | null;
	contactFirstName: string | null;
	contactLastName: string | null;
};

function readText(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function describeError(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return String(cause);
}

/** Bo'sh bo'lmagan xulosa sharti — filtr va hasSummary bir xil mantiqda ishlaydi. */
function summaryPresentSql(present: boolean): SQL {
	return present
		? sql`length(trim(coalesce(${aiAnalyses.summary}, ''))) > 0`
		: sql`length(trim(coalesce(${aiAnalyses.summary}, ''))) = 0`;
}

async function findMyOperatorProfileId(tenantId: TenantId, userId: string): Promise<string | null> {
	const [row] = await db
		.select({ id: operatorProfiles.id })
		.from(operatorProfiles)
		.where(
			tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.userId, userId),
				eq(operatorProfiles.isDeleted, false)
			)
		)
		.limit(1);

	return row?.id ?? null;
}

/**
 * RBAC scope sharti. Manager faqat o'zi olgan qo'ng'iroqlar tahlilini ko'radi
 * (operator profili bo'lmasa — hech nimani).
 */
async function resolveScopeCondition(c: Context<AppBindings>): Promise<SQL | undefined> {
	const user = c.get("user");

	if (CAN_SEE_ALL_ANALYSES.includes(user.role)) {
		return undefined;
	}

	const myProfileId = await findMyOperatorProfileId(currentTenantId(c), user.id);

	return eq(calls.operatorId, myProfileId ?? MATCHES_NOTHING_UUID);
}

/**
 * Tahlil + qo'ng'iroq + operator + kontakt. transcript ustuni ataylab
 * tanlanmaydi: ro'yxatda uzun matn kerak emas, faqat uzunligi ko'rsatiladi.
 */
function selectRows(tenantId: TenantId, ...conditions: (SQL | undefined)[]) {
	return (
		db
			.select({
				id: aiAnalyses.id,
				callId: aiAnalyses.callId,
				status: aiAnalyses.status,
				sentiment: aiAnalyses.sentiment,
				categories: aiAnalyses.categories,
				confidence: aiAnalyses.confidence,
				summary: aiAnalyses.summary,
				errorMessage: aiAnalyses.errorMessage,
				retryCount: aiAnalyses.retryCount,
				processedAt: aiAnalyses.processedAt,
				createdAt: aiAnalyses.createdAt,
				transcriptChars: sql<number>`coalesce(length(${aiAnalyses.transcript}), 0)`.mapWith(Number),
				callDirection: calls.direction,
				callerNumber: calls.callerNumber,
				calleeExtension: calls.calleeExtension,
				callStatus: calls.status,
				callDuration: calls.duration,
				callAiStatus: calls.aiStatus,
				callRecordingPath: calls.recordingPath,
				callStartedAt: calls.startedAt,
				callEndedAt: calls.endedAt,
				callTicketId: calls.ticketId,
				callOperatorId: calls.operatorId,
				operatorExtension: operatorProfiles.extension,
				contactId: contacts.id,
				contactPhone: contacts.phoneNumber,
				contactFirstName: contacts.firstName,
				contactLastName: contacts.lastName,
			})
			.from(aiAnalyses)
			// The tenant is part of every join as well as of the WHERE the callers add. An
			// inner join to `calls` on the call id alone would read as scoped while ANDing in
			// another customer's call - the exact blind spot the query scanner cannot see.
			.innerJoin(
				calls,
				and(eq(calls.id, aiAnalyses.callId), eq(calls.tenantId, aiAnalyses.tenantId))
			)
			.leftJoin(
				operatorProfiles,
				and(
					eq(operatorProfiles.id, calls.operatorId),
					eq(operatorProfiles.tenantId, aiAnalyses.tenantId)
				)
			)
			.leftJoin(
				contacts,
				and(eq(contacts.id, calls.contactId), eq(contacts.tenantId, aiAnalyses.tenantId))
			)
			// The WHERE is built here rather than added by the caller: drizzle refuses a
			// second .where() on a select, so a caller who needed one would have had to drop
			// this one - which is how the tenant filter goes missing during a refactor.
			.where(tenantWhere(aiAnalyses, tenantId, ...conditions))
	);
}

function toItem(row: AnalysisRow) {
	const summary = readText(row.summary);

	return {
		id: row.id,
		callId: row.callId,
		status: row.status,
		sentiment: row.sentiment,
		categories: row.categories ?? null,
		confidence: row.confidence,
		summary,
		hasSummary: summary !== null,
		hasTranscript: row.transcriptChars > 0,
		transcriptChars: row.transcriptChars,
		errorMessage: readText(row.errorMessage),
		retryCount: row.retryCount ?? 0,
		processedAt: row.processedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		call: {
			id: row.callId,
			direction: row.callDirection,
			callerNumber: row.callerNumber,
			calleeExtension: row.calleeExtension,
			status: row.callStatus,
			duration: row.callDuration,
			aiStatus: row.callAiStatus,
			recordingPath: row.callRecordingPath,
			startedAt: row.callStartedAt.toISOString(),
			endedAt: row.callEndedAt?.toISOString() ?? null,
			ticketId: row.callTicketId,
			operatorId: row.callOperatorId,
			operatorExtension: row.operatorExtension,
		},
		contact:
			row.contactId !== null && row.contactPhone !== null
				? {
						id: row.contactId,
						phoneNumber: row.contactPhone,
						firstName: row.contactFirstName,
						lastName: row.contactLastName,
					}
				: null,
	};
}

/** Tahlilni id bo'yicha topadi; ruxsat bo'lmasa 404 (mavjudligini oshkor qilmaslik uchun). */
async function loadRowForUser(c: Context<AppBindings>, id: string): Promise<AnalysisRow> {
	const tenantId = currentTenantId(c);
	const scope = await resolveScopeCondition(c);

	// selectRows() already filters on the tenant; drizzle ANDs a second .where() onto
	// it rather than replacing it, so another customer's analysis id simply finds
	// nothing - a 404, not a 403.
	const [row] = await selectRows(tenantId, eq(aiAnalyses.id, id), scope).limit(1);

	if (!row) {
		throw notFound("AI tahlili", id);
	}

	return row;
}

/** Tahlil bilan birga saqlangan to'liq matn (alohida o'qiladi — ro'yxatga tushmaydi). */
async function loadStoredTranscript(
	tenantId: TenantId,
	analysisId: string
): Promise<string | null> {
	const [row] = await db
		.select({ transcript: aiAnalyses.transcript })
		.from(aiAnalyses)
		.where(tenantWhere(aiAnalyses, tenantId, eq(aiAnalyses.id, analysisId)))
		.limit(1);

	return readText(row?.transcript ?? null);
}

async function loadTicketSummary(tenantId: TenantId, ticketId: string | null) {
	if (!ticketId) {
		return null;
	}

	const [row] = await db
		.select({
			id: tickets.id,
			subject: tickets.subject,
			status: tickets.status,
			priority: tickets.priority,
		})
		.from(tickets)
		.where(tenantWhere(tickets, tenantId, eq(tickets.id, ticketId)))
		.limit(1);

	return row ?? null;
}

/**
 * Oxirgi qo'lda tuzatish auditLogs'dan o'qiladi — ai_analyses jadvaliga yangi
 * ustun qo'shilmagan. Tuzatish bo'lmasa null.
 */
async function loadLastCorrection(tenantId: TenantId, analysisId: string) {
	// audit_logs.tenant_id is WHOSE DATA was touched, which is the right column here:
	// the question is "who last corrected this customer's analysis", and a vendor who
	// did it during an impersonated session is a legitimate answer to it.
	const [row] = await db
		.select({
			createdAt: auditLogs.createdAt,
			userId: auditLogs.userId,
			phone: users.phone,
		})
		.from(auditLogs)
		// No tenant term on this join: the actor may be a vendor user, who lives in the
		// vendor's own tenant. Only their phone is read, and the row was already scoped.
		.leftJoin(users, eq(users.id, auditLogs.userId))
		.where(
			tenantWhere(
				auditLogs,
				tenantId,
				eq(auditLogs.action, CORRECT_ACTION),
				eq(auditLogs.entityId, analysisId)
			)
		)
		.orderBy(desc(auditLogs.createdAt))
		.limit(1);

	if (!row) {
		return null;
	}

	return {
		at: row.createdAt.toISOString(),
		byUserId: row.userId,
		byPhone: row.phone ?? null,
	};
}

/** Detal javobi: item + saqlangan matn + gap-bo'yicha qatorlar + ticket + tuzatish izi. */
async function toDetail(tenantId: TenantId, row: AnalysisRow) {
	const [lines, stats, ticket, lastCorrection, transcript] = await Promise.all([
		db
			.select({
				id: callTranscripts.id,
				role: callTranscripts.role,
				content: callTranscripts.content,
				startMs: callTranscripts.startMs,
				endMs: callTranscripts.endMs,
				confidence: callTranscripts.confidence,
				createdAt: callTranscripts.createdAt,
			})
			.from(callTranscripts)
			.where(
				tenantWhere(
					callTranscripts,
					tenantId,
					eq(callTranscripts.callId, row.callId),
					eq(callTranscripts.isFinal, true)
				)
			)
			.orderBy(asc(callTranscripts.startMs), asc(callTranscripts.createdAt))
			.limit(TRANSCRIPT_LINE_LIMIT),
		db
			.select({
				total: count(),
				callerTurns:
					sql<number>`count(*) filter (where ${callTranscripts.role} = 'caller')`.mapWith(Number),
			})
			.from(callTranscripts)
			.where(
				tenantWhere(
					callTranscripts,
					tenantId,
					eq(callTranscripts.callId, row.callId),
					eq(callTranscripts.isFinal, true)
				)
			),
		loadTicketSummary(tenantId, row.callTicketId),
		loadLastCorrection(tenantId, row.id),
		loadStoredTranscript(tenantId, row.id),
	]);

	return {
		...toItem(row),
		transcript,
		transcriptLines: lines.map((line) => ({
			id: line.id,
			role: line.role,
			content: line.content,
			startMs: line.startMs,
			endMs: line.endMs,
			confidence: line.confidence,
			createdAt: line.createdAt.toISOString(),
		})),
		transcriptLineCount: Number(stats[0]?.total ?? 0),
		callerTurnCount: Number(stats[0]?.callerTurns ?? 0),
		ticket,
		lastCorrection,
	};
}

function buildFilterConditions(query: ListQuery): SQL[] {
	const conditions: SQL[] = [];

	if (query.status) {
		conditions.push(eq(aiAnalyses.status, query.status));
	}
	if (query.sentiment) {
		conditions.push(eq(aiAnalyses.sentiment, query.sentiment));
	}
	if (query.callId) {
		conditions.push(eq(aiAnalyses.callId, query.callId));
	}
	if (query.hasSummary) {
		conditions.push(summaryPresentSql(query.hasSummary === "true"));
	}
	if (query.from) {
		conditions.push(gte(aiAnalyses.createdAt, new Date(query.from)));
	}
	if (query.to) {
		conditions.push(lte(aiAnalyses.createdAt, new Date(query.to)));
	}

	return conditions;
}

export const listHandler: AppRouteHandler<typeof r.list> = async (c) => {
	const query = c.req.valid("query") as ListQuery;
	const { page, limit } = query;
	const offset = (page - 1) * limit;

	const tenantId = currentTenantId(c);
	const conditions = buildFilterConditions(query);
	const scope = await resolveScopeCondition(c);

	if (scope) {
		conditions.push(scope);
	}

	const [items, countResult] = await Promise.all([
		selectRows(tenantId, ...conditions)
			.orderBy(desc(aiAnalyses.createdAt))
			.limit(limit)
			.offset(offset),
		db
			.select({ count: count() })
			.from(aiAnalyses)
			.innerJoin(
				calls,
				and(eq(calls.id, aiAnalyses.callId), eq(calls.tenantId, aiAnalyses.tenantId))
			)
			.where(tenantWhere(aiAnalyses, tenantId, ...conditions)),
	]);

	const totalCount = Number(countResult[0]?.count ?? 0);
	const totalPages = Math.ceil(totalCount / limit);

	return c.json(
		{
			success: true as const,
			data: {
				items: items.map(toItem),
				meta: { total: totalCount, page, limit, totalPages },
			},
		},
		200
	);
};

export const getHandler: AppRouteHandler<typeof r.get> = async (c) => {
	const id = c.req.valid("param").id;
	const row = await loadRowForUser(c, id);

	return c.json({ success: true as const, data: await toDetail(currentTenantId(c), row) }, 200);
};

export const updateHandler: AppRouteHandler<typeof r.update> = async (c) => {
	requireRoles(c, CAN_EDIT_ANALYSES);

	const id = c.req.valid("param").id;
	const body = c.req.valid("json") as UpdateBody;
	const tenantId = currentTenantId(c);

	const existing = await loadRowForUser(c, id);

	const updates: {
		summary?: string | null;
		sentiment?: Sentiment | null;
		categories?: string[] | null;
	} = {};

	if (body.summary !== undefined) {
		updates.summary = body.summary;
	}
	if (body.sentiment !== undefined) {
		updates.sentiment = body.sentiment;
	}
	if (body.categories !== undefined) {
		// Bo'sh massiv null bilan bir xil saqlanadi — writeAiAnalysis ham shunday qiladi.
		const list = body.categories;
		updates.categories = list === null || list.length === 0 ? null : list;
	}

	if (Object.keys(updates).length === 0) {
		throw invalidInput("body", "Kamida bitta maydon kerak: summary, sentiment yoki categories");
	}

	await db
		.update(aiAnalyses)
		.set(updates)
		.where(tenantWhere(aiAnalyses, tenantId, eq(aiAnalyses.id, id)));

	// Ticket detali va dashboard tickets.ai_* ustunlarini o'qiydi — tuzatish
	// faqat berilgan maydonlarni ko'chiradi, qolganiga tegilmaydi.
	if (existing.callTicketId) {
		const ticketSet: {
			aiSummary?: string | null;
			aiSentiment?: Sentiment | null;
			aiCategories?: string[] | null;
			updatedAt: Date;
		} = { updatedAt: new Date() };

		if (updates.summary !== undefined) {
			ticketSet.aiSummary = updates.summary;
		}
		if (updates.sentiment !== undefined) {
			ticketSet.aiSentiment = updates.sentiment;
		}
		if (updates.categories !== undefined) {
			ticketSet.aiCategories = updates.categories;
		}

		await db
			.update(tickets)
			.set(ticketSet)
			.where(tenantWhere(tickets, tenantId, eq(tickets.id, existing.callTicketId)));
	}

	await audit(c, {
		action: CORRECT_ACTION,
		entityType: "ai_analysis",
		entityId: id,
		details: {
			callId: existing.callId,
			ticketId: existing.callTicketId,
			fields: Object.keys(updates),
			previous: {
				summary: existing.summary,
				sentiment: existing.sentiment,
				categories: existing.categories ?? null,
			},
		},
	});

	const updated = await loadRowForUser(c, id);

	return c.json({ success: true as const, data: await toDetail(tenantId, updated) }, 200);
};

type RetryTranscript = { text: string; source: "lines" | "stored" } | { reason: string };

/**
 * Qayta tahlil uchun matnni topadi.
 *
 * Manba tartibi: avval callTranscripts jadvalidagi yakuniy qatorlar (haqiqat
 * manbasi), keyin tahlil bilan birga saqlangan blok. Ikkalasida ham mijoz gapi
 * bo'lmasa — sabab qaytadi va model umuman chaqirilmaydi.
 */
async function resolveRetryTranscript(
	tenantId: TenantId,
	callId: string,
	storedTranscript: string | null
): Promise<RetryTranscript> {
	const live = await buildTranscriptText(tenantId, callId);

	if (live.callerTurnCount > 0) {
		return { text: live.text, source: "lines" };
	}

	if (storedTranscript !== null && CALLER_LINE_PATTERN.test(storedTranscript)) {
		return { text: storedTranscript, source: "stored" };
	}

	if (storedTranscript !== null) {
		return { reason: "saqlangan transkriptda mijoz gapi topilmadi" };
	}

	if (live.turnCount > 0) {
		return { reason: "transkriptda faqat AI gapi bor, mijoz gapi yozib olinmagan" };
	}

	return { reason: "bu qo'ng'iroq uchun transkript umuman saqlanmagan" };
}

/** Qo'ng'iroq tili: AI sessiyasida yozilgani, bo'lmasa tizim sozlamasi. */
async function resolveCallLanguage(tenantId: TenantId, callId: string): Promise<string> {
	const [session] = await db
		.select({ language: aiSessions.language })
		.from(aiSessions)
		.where(tenantWhere(aiSessions, tenantId, eq(aiSessions.callId, callId)))
		.limit(1);

	return readText(session?.language ?? null) ?? getAiRuntimeConfig(tenantId).language;
}

export const retryHandler: AppRouteHandler<typeof r.retry> = async (c) => {
	requireRoles(c, CAN_EDIT_ANALYSES);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const existing = await loadRowForUser(c, id);

	if (existing.status !== "failed") {
		throw businessError("Qayta tahlil faqat xatolik bilan tugagan yozuvlar uchun ishlaydi", [
			{ field: "status", reason: `Hozirgi holat: ${existing.status}` },
		]);
	}

	const stored = await loadStoredTranscript(tenantId, id);
	const resolved = await resolveRetryTranscript(tenantId, existing.callId, stored);

	if ("reason" in resolved) {
		throw businessError(
			`Qayta tahlil qilish mumkin emas: ${resolved.reason}. Transkript bo'lmasa xulosa yozilmaydi.`,
			[{ field: "transcript", reason: resolved.reason }]
		);
	}

	const language = await resolveCallLanguage(tenantId, existing.callId);

	try {
		const summary = await summariseCallWithOpenAi({
			callId: existing.callId,
			tenantId,
			transcript: resolved.text,
			language,
		});

		await writeAiAnalysis(tenantId, {
			callId: existing.callId,
			transcript: resolved.text,
			summary: summary.summary,
			sentiment: summary.sentiment,
			categories: summary.categories,
			confidence: summary.confidence,
			status: "completed",
			// Qayta tahlil — haqiqiy, takrorlanadigan xarajat: hisob-kitobga qo'shiladi.
			usage: summary.usage,
		});

		await audit(c, {
			action: RETRY_ACTION,
			entityType: "ai_analysis",
			entityId: id,
			details: {
				callId: existing.callId,
				outcome: "completed",
				transcriptSource: resolved.source,
				transcriptChars: resolved.text.length,
				language,
				previousRetryCount: existing.retryCount ?? 0,
				previousError: existing.errorMessage,
			},
		});
	} catch (cause) {
		const message = describeError(cause);

		// Transkript saqlanib qoladi, xato matni esa navbatda ko'rinadi —
		// retry_count writeAiAnalysis tomonidan oshiriladi.
		await writeAiAnalysis(tenantId, {
			callId: existing.callId,
			transcript: resolved.text,
			status: "failed",
			errorMessage: `Qayta tahlil muvaffaqiyatsiz: ${message}`,
		});

		await audit(c, {
			action: RETRY_ACTION,
			entityType: "ai_analysis",
			entityId: id,
			details: {
				callId: existing.callId,
				outcome: "failed",
				transcriptSource: resolved.source,
				language,
				error: message,
			},
		});

		throw businessError(`AI tahlilini qayta ishga tushirish muvaffaqiyatsiz: ${message}`, [
			{ field: "model", reason: message },
		]);
	}

	const updated = await loadRowForUser(c, id);

	return c.json({ success: true as const, data: await toDetail(tenantId, updated) }, 200);
};
