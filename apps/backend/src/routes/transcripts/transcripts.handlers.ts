import type { UserRoleType } from "@shared/types";
import { asc, count, desc, eq, ilike } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "@/db";
import type { CallTranscriptRecord } from "@/db/schema";
import { aiSessions, calls, callTranscripts, operatorProfiles } from "@/db/schema";
import { audit } from "@/lib/audit";
import { databaseError, invalidInput, notFound } from "@/lib/errors";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppBindings, AppRouteHandler } from "@/lib/types";
import type * as r from "./transcripts.routes";

/** Admin va Supervisor barcha qo'ng'iroqlar transkriptini ko'radi; manager faqat o'zini. */
const CAN_SEE_ALL_CALLS: UserRoleType[] = ["admin", "supervisor"];

/** Eksportda bitta qo'ng'iroq uchun maksimal qator soni. */
const EXPORT_ROW_LIMIT = 20_000;

const CSV_HEADERS = "id,role,startMs,endMs,isFinal,confidence,createdAt,content\n";

type TranscriptRole = "caller" | "agent" | "system";

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
 * Qo'ng'iroqni topadi va ruxsatni tekshiradi.
 *
 * Ruxsat bo'lmasa 403 emas, 404 qaytadi — calls.handlers.ts'dagi bilan bir xil
 * xatti-harakat, boshqa operatorning qo'ng'irog'i mavjudligini oshkor qilmaslik uchun.
 */
async function loadCallForUser(c: Context<AppBindings>, callId: string) {
	const tenantId = currentTenantId(c);

	// The tenant gate for this whole file. Every handler below - list, export, append
	// and update - goes through here first, so a callId from another customer answers
	// 404 once, in one place, instead of each handler remembering to ask. It is also
	// what stops the append handler stamping OUR tenant onto THEIR call.
	const [call] = await db
		.select({
			id: calls.id,
			operatorId: calls.operatorId,
			callerNumber: calls.callerNumber,
			startedAt: calls.startedAt,
		})
		.from(calls)
		.where(tenantWhere(calls, tenantId, eq(calls.id, callId)))
		.limit(1);

	if (!call) {
		throw notFound("Qo'ng'iroq", callId);
	}

	const user = c.get("user");

	if (!CAN_SEE_ALL_CALLS.includes(user.role)) {
		const myProfileId = await findMyOperatorProfileId(tenantId, user.id);
		if (!myProfileId || call.operatorId !== myProfileId) {
			throw notFound("Qo'ng'iroq", callId);
		}
	}

	return call;
}

function toItem(row: CallTranscriptRecord) {
	return {
		id: row.id,
		callId: row.callId,
		aiSessionId: row.aiSessionId,
		role: row.role,
		content: row.content,
		startMs: row.startMs,
		endMs: row.endMs,
		isFinal: row.isFinal,
		confidence: row.confidence,
		createdAt: row.createdAt.toISOString(),
	};
}

/** startMs/endMs berilgan bo'lsa, tartibi to'g'ri bo'lishi kerak. */
function assertMsOrder(startMs: number | null, endMs: number | null) {
	if (startMs !== null && endMs !== null && endMs < startMs) {
		throw invalidInput("endMs", "endMs startMs dan kichik bo'lmasligi kerak");
	}
}

function formatOffset(startMs: number | null): string {
	if (startMs === null) {
		return "--:--";
	}

	const totalSeconds = Math.max(0, Math.floor(startMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function escapeCsv(value: string | number | boolean | null | undefined): string {
	if (value == null) {
		return "";
	}

	const s = String(value);
	if (s.includes(",") || s.includes('"') || s.includes("\n")) {
		return `"${s.replace(/"/g, '""')}"`;
	}

	return s;
}

export const listHandler: AppRouteHandler<typeof r.listByCall> = async (c) => {
	const { callId } = c.req.valid("param");
	const { page, limit, role, includeInterim, order, search } = c.req.valid("query");
	const offset = (page - 1) * limit;

	const tenantId = currentTenantId(c);

	await loadCallForUser(c, callId);

	const conditions = [eq(callTranscripts.callId, callId)];
	if (role) {
		conditions.push(eq(callTranscripts.role, role));
	}
	if (includeInterim !== "true") {
		conditions.push(eq(callTranscripts.isFinal, true));
	}
	if (search) {
		conditions.push(ilike(callTranscripts.content, `%${search}%`));
	}

	const [items, countResult] = await Promise.all([
		db.query.callTranscripts.findMany({
			// The tenant leads and the filters follow. The call was already checked in
			// loadCallForUser(), so this is the second lock on the same door - written out
			// at both query sites rather than shared through a variable, because a shared
			// `where` is one rename away from being reused by a query that skipped the check.
			where: tenantWhere(callTranscripts, tenantId, ...conditions),
			orderBy:
				order === "desc"
					? [desc(callTranscripts.startMs), desc(callTranscripts.createdAt)]
					: [asc(callTranscripts.startMs), asc(callTranscripts.createdAt)],
			limit,
			offset,
		}),
		// The count repeats the same tenant-scoped predicate as the page, so the pager
		// cannot promise rows the page will not show.
		db
			.select({ count: count() })
			.from(callTranscripts)
			.where(tenantWhere(callTranscripts, tenantId, ...conditions)),
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

export const exportHandler: AppRouteHandler<typeof r.exportByCall> = async (c) => {
	const { callId } = c.req.valid("param");
	const { format, role, includeInterim } = c.req.valid("query");

	const tenantId = currentTenantId(c);
	const call = await loadCallForUser(c, callId);

	const conditions = [eq(callTranscripts.callId, callId)];
	if (role) {
		conditions.push(eq(callTranscripts.role, role));
	}
	if (includeInterim !== "true") {
		conditions.push(eq(callTranscripts.isFinal, true));
	}

	// An export is a read like any other, and the easiest one to forget: it leaves the
	// building as a file.
	const rows = await db.query.callTranscripts.findMany({
		where: tenantWhere(callTranscripts, tenantId, ...conditions),
		orderBy: [asc(callTranscripts.startMs), asc(callTranscripts.createdAt)],
		limit: EXPORT_ROW_LIMIT,
	});

	if (format === "csv") {
		const csv =
			CSV_HEADERS +
			rows
				.map((row) =>
					[
						row.id,
						row.role,
						row.startMs ?? "",
						row.endMs ?? "",
						row.isFinal,
						row.confidence ?? "",
						row.createdAt.toISOString(),
						row.content,
					]
						.map(escapeCsv)
						.join(",")
				)
				.join("\n");

		return new Response(csv, {
			status: 200,
			headers: {
				"Content-Type": "text/csv; charset=utf-8",
				"Content-Disposition": `attachment; filename="transcript-${callId}.csv"`,
			},
		});
	}

	const header = [
		`# Call: ${call.id}`,
		`# Caller: ${call.callerNumber}`,
		`# Started: ${call.startedAt.toISOString()}`,
		`# Lines: ${rows.length}`,
		"",
	].join("\n");
	const body = rows
		.map((row) => `[${formatOffset(row.startMs)}] ${row.role}: ${row.content}`)
		.join("\n");

	return new Response(`${header}${body}\n`, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": `attachment; filename="transcript-${callId}.txt"`,
		},
	});
};

export const appendHandler: AppRouteHandler<typeof r.append> = async (c) => {
	const { callId } = c.req.valid("param");
	const body = c.req.valid("json");
	const tenantId = currentTenantId(c);

	await loadCallForUser(c, callId);

	const content = body.content.trim();
	if (content.length === 0) {
		throw invalidInput("content", "Matn bo'sh bo'lmasligi kerak");
	}

	assertMsOrder(body.startMs ?? null, body.endMs ?? null);

	// Qo'lda qo'shilgan qator ham AI sessiyaga bog'lanadi, shunda live/keyingi
	// ko'rinishlar bitta sessiya kontekstida ko'rsatadi.
	let aiSessionId: string | null = null;
	if (body.aiSessionId) {
		// An id out of the request body, so both terms matter: the session has to belong
		// to this call AND to this tenant.
		const [session] = await db
			.select({ id: aiSessions.id })
			.from(aiSessions)
			.where(
				tenantWhere(
					aiSessions,
					tenantId,
					eq(aiSessions.id, body.aiSessionId),
					eq(aiSessions.callId, callId)
				)
			)
			.limit(1);

		if (!session) {
			throw invalidInput("aiSessionId", "Bu qo'ng'iroqqa tegishli AI sessiya topilmadi");
		}
		aiSessionId = session.id;
	} else {
		const [session] = await db
			.select({ id: aiSessions.id })
			.from(aiSessions)
			.where(tenantWhere(aiSessions, tenantId, eq(aiSessions.callId, callId)))
			.limit(1);

		aiSessionId = session?.id ?? null;
	}

	const [inserted] = await db
		.insert(callTranscripts)
		.values({
			// The call this row hangs off was checked against the same tenant a few lines
			// above, so the stamp and the parent cannot disagree.
			tenantId,
			callId,
			aiSessionId,
			role: body.role,
			content,
			startMs: body.startMs ?? null,
			endMs: body.endMs ?? null,
			isFinal: body.isFinal ?? true,
			confidence: body.confidence ?? null,
		})
		.returning();

	if (!inserted) {
		throw databaseError("Transkript qatorini yozish natija qaytarmadi");
	}

	await audit(c, {
		action: "transcripts.append",
		entityType: "call_transcript",
		entityId: inserted.id,
		details: {
			callId,
			role: inserted.role,
			isFinal: inserted.isFinal,
			manual: true,
			contentLength: content.length,
		},
	});

	return c.json({ success: true as const, data: toItem(inserted) }, 201);
};

export const updateHandler: AppRouteHandler<typeof r.update> = async (c) => {
	const id = c.req.valid("param").id;
	const body = c.req.valid("json");
	const tenantId = currentTenantId(c);

	const [existing] = await db
		.select()
		.from(callTranscripts)
		.where(tenantWhere(callTranscripts, tenantId, eq(callTranscripts.id, id)))
		.limit(1);

	if (!existing) {
		throw notFound("Transkript qatori", id);
	}

	await loadCallForUser(c, existing.callId);

	const updates: {
		content?: string;
		role?: TranscriptRole;
		startMs?: number | null;
		endMs?: number | null;
		isFinal?: boolean;
		confidence?: number | null;
	} = {};

	if (body.content !== undefined) {
		const content = body.content.trim();
		if (content.length === 0) {
			throw invalidInput("content", "Matn bo'sh bo'lmasligi kerak");
		}
		updates.content = content;
	}
	if (body.role !== undefined) {
		updates.role = body.role;
	}
	if (body.startMs !== undefined) {
		updates.startMs = body.startMs;
	}
	if (body.endMs !== undefined) {
		updates.endMs = body.endMs;
	}
	if (body.isFinal !== undefined) {
		updates.isFinal = body.isFinal;
	}
	if (body.confidence !== undefined) {
		updates.confidence = body.confidence;
	}

	if (Object.keys(updates).length === 0) {
		throw invalidInput("body", "Kamida bitta maydon berilishi kerak");
	}

	assertMsOrder(
		body.startMs === undefined ? existing.startMs : body.startMs,
		body.endMs === undefined ? existing.endMs : body.endMs
	);

	const [updated] = await db
		.update(callTranscripts)
		.set(updates)
		.where(tenantWhere(callTranscripts, tenantId, eq(callTranscripts.id, id)))
		.returning();

	if (!updated) {
		throw notFound("Transkript qatori", id);
	}

	await audit(c, {
		action: "transcripts.correct",
		entityType: "call_transcript",
		entityId: id,
		details: {
			callId: existing.callId,
			fields: Object.keys(updates),
			previous: {
				role: existing.role,
				content: existing.content,
				startMs: existing.startMs,
				endMs: existing.endMs,
				isFinal: existing.isFinal,
				confidence: existing.confidence,
			},
		},
	});

	return c.json({ success: true as const, data: toItem(updated) }, 200);
};
