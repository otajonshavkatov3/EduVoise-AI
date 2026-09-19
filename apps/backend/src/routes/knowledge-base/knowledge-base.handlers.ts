/**
 * HTTP layer for the knowledge base — the "gives information" half of the product.
 *
 * The agent may assert only what lives in these rows. A price, an address or an
 * opening hour it invented is a liability on a recorded line, so the retrieval
 * side (lib/ai-agent/knowledge.ts) refuses to answer from a zero-scoring row and
 * the profile's unknownPolicy takes over instead. That makes these endpoints the
 * business owner's real control surface: what goes in here is exactly what
 * callers will be told, and nothing else is.
 *
 * Two things worth knowing before reading on:
 *
 *   - POST /search runs the SAME searchKnowledgeBase() a live call runs, on
 *     purpose. An owner has to be able to ask "will the AI find this answer?"
 *     and get the truth, not a lookalike query. The cost is that a test search
 *     bumps useCount exactly as a caller would; the route description says so.
 *   - POST /bulk imports row by row. A FAQ list arrives as one paste, one bad
 *     row in it must not throw away the other 199, so every row reports its own
 *     outcome and duplicates are skipped rather than duplicated.
 */
import type { UserRoleType } from "@shared/types";
import { count, desc, eq, ilike, ne, or, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "@/db";
import type {
	AiAgentProfileRecord,
	KnowledgeBaseEntryRecord,
	UnknownAnswerPolicy,
} from "@/db/schema";
import { aiAgentProfiles, knowledgeBaseEntries } from "@/db/schema";
import { ensureDefaultProfile, getActiveAgentProfile, searchKnowledgeBase } from "@/lib/ai-agent";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { businessError, databaseError, notFound } from "@/lib/errors";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppBindings, AppRouteHandler } from "@/lib/types";
import type * as r from "./knowledge-base.routes";
import type {
	BulkBody,
	BulkRowResult,
	KnowledgeEntryItem,
	ListQuery,
	StatsQuery,
} from "./knowledge-base.schemas";

/** What callers are told is a business decision, not an operator's. */
const ALLOWED_WRITE_ROLES: UserRoleType[] = ["supervisor", "admin"];

/**
 * What the agent does when nothing matched, in the owner's language. This is the
 * point of the test-search endpoint: "no hit" is not an error, it is a documented
 * behaviour, and the owner has to see which one they configured.
 */
function describeFallback(policy: UnknownAnswerPolicy): string {
	if (policy === "transfer") {
		return "Agent o'zidan javob to'qimaydi — qo'ng'iroqni operatorga uzatadi.";
	}

	if (policy === "take_message") {
		return "Agent savolni va aloqa raqamini yozib oladi, so'ng operator qayta bog'lanadi (follow-up).";
	}

	return "Agent bu savolga javob bera olmasligini ochiq aytadi va odam bilan gaplashishni taklif qiladi.";
}

type ResolvedProfile = {
	/** null — hech qanday profil sozlanmagan (aktiv profil ham yo'q). */
	id: string | null;
	businessName: string;
	unknownPolicy: UnknownAnswerPolicy;
};

// ===========================================
// Serialisation
// ===========================================

function toItem(row: KnowledgeBaseEntryRecord): KnowledgeEntryItem {
	return {
		id: row.id,
		agentProfileId: row.agentProfileId,
		question: row.question,
		answer: row.answer,
		tags: row.tags ?? [],
		priority: row.priority,
		isActive: row.isActive,
		useCount: row.useCount,
		lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
		createdBy: row.createdBy,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** max(timestamptz) may come back as a Date or as a string depending on the driver path. */
function toIso(value: Date | string | null): string | null {
	if (!value) {
		return null;
	}

	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ===========================================
// Profile resolution
// ===========================================

async function findProfile(tenantId: TenantId, id: string): Promise<AiAgentProfileRecord> {
	const row = await db.query.aiAgentProfiles.findFirst({
		where: tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.id, id)),
	});

	if (!row) {
		throw notFound("AI agent profili", id);
	}

	return row;
}

/**
 * Reads default to the profile that is answering calls, because that is the one
 * whose content actually matters. No row is created on a read path.
 */
async function resolveProfileForRead(
	tenantId: TenantId,
	requested?: string
): Promise<ResolvedProfile> {
	if (requested) {
		const row = await findProfile(tenantId, requested);

		return {
			id: row.id,
			businessName: row.businessName,
			unknownPolicy: row.unknownPolicy as UnknownAnswerPolicy,
		};
	}

	const active = await getActiveAgentProfile(tenantId);

	return {
		id: active.id,
		businessName: active.businessName,
		unknownPolicy: active.unknownPolicy,
	};
}

/**
 * A write needs a profile to hang the entry off, so this one may create the
 * default profile — the same one the dashboard would have created anyway.
 */
async function resolveProfileForWrite(
	c: Context<AppBindings>,
	requested?: string
): Promise<AiAgentProfileRecord> {
	if (requested) {
		return await findProfile(currentTenantId(c), requested);
	}

	return await ensureDefaultProfile(currentTenantId(c), c.get("user").id);
}

// ===========================================
// Queries
// ===========================================

/** ILIKE metabelgilarini ekranlaydi: "%" yozgan foydalanuvchi hamma yozuvni topmasligi kerak. */
function likePattern(value: string): string {
	return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * The filters a list request asks for - and DELIBERATELY NOT THE TENANT.
 *
 * The tenant is written out at every statement that uses these (see listHandler),
 * not folded in here. The page and its total are two separate queries, and a tenant
 * term that lives in a shared variable one screen away can be edited out of both
 * without either query looking wrong; written at the query it cannot. What IS shared
 * is the filter list, so the page and the count still ask the same question.
 *
 * Everything below is therefore narrowing only: no combination of q / tag /
 * isActive - all client-controlled - can widen the set past the tenant, because
 * tenantWhere() puts the tenant first and ANDs the rest onto it.
 */
function buildListFilters(profileId: string, query: ListQuery): SQL[] {
	const conditions: SQL[] = [eq(knowledgeBaseEntries.agentProfileId, profileId)];

	if (query.q) {
		const pattern = likePattern(query.q);
		const textMatch = or(
			ilike(knowledgeBaseEntries.question, pattern),
			ilike(knowledgeBaseEntries.answer, pattern),
			// tags is jsonb; its text form is what a free-text search should look at.
			sql`coalesce(${knowledgeBaseEntries.tags}::text, '') ILIKE ${pattern}`
		);

		if (textMatch) {
			conditions.push(textMatch);
		}
	}

	if (query.tag) {
		// Containment, not a substring: tag=narx must not match "narxlar-2024".
		conditions.push(sql`${knowledgeBaseEntries.tags} @> ${JSON.stringify([query.tag])}::jsonb`);
	}

	if (query.isActive) {
		conditions.push(eq(knowledgeBaseEntries.isActive, query.isActive === "true"));
	}

	return conditions;
}

/** One entry of THIS tenant, or 404 - never a 403, which would confirm the id exists. */
async function findEntry(tenantId: TenantId, id: string): Promise<KnowledgeBaseEntryRecord> {
	const row = await db.query.knowledgeBaseEntries.findFirst({
		where: tenantWhere(knowledgeBaseEntries, tenantId, eq(knowledgeBaseEntries.id, id)),
	});

	if (!row) {
		throw notFound("Bilim bazasi yozuvi", id);
	}

	return row;
}

/**
 * The same question twice in one profile is always a mistake: retrieval would
 * score both identically and the owner would edit one and wonder why the agent
 * still says the old thing.
 */
async function findDuplicateQuestion(
	tenantId: TenantId,
	profileId: string,
	question: string,
	excludeId?: string
): Promise<string | null> {
	const conditions: SQL[] = [
		eq(knowledgeBaseEntries.agentProfileId, profileId),
		sql`lower(trim(${knowledgeBaseEntries.question})) = ${question.trim().toLowerCase()}`,
	];

	if (excludeId) {
		conditions.push(ne(knowledgeBaseEntries.id, excludeId));
	}

	// Scoped, and not only for isolation: an unscoped match would refuse a question
	// as "already in this profile" while naming a row id that belongs to another
	// business - a duplicate check that both leaks and blocks.
	const [row] = await db
		.select({ id: knowledgeBaseEntries.id })
		.from(knowledgeBaseEntries)
		.where(tenantWhere(knowledgeBaseEntries, tenantId, ...conditions))
		.limit(1);

	return row?.id ?? null;
}

/**
 * One row of an import, isolated so a single bad row cannot abort the rest.
 *
 * Nothing is thrown: the outcome — created, skipped as a duplicate, or failed with
 * the database's own message — is returned as data, because a business pasting a
 * FAQ list needs to know WHICH line it has to fix, not that "the import failed".
 */
async function importRow(
	tenantId: TenantId,
	profileId: string,
	userId: string,
	entry: BulkBody["entries"][number],
	index: number
): Promise<BulkRowResult> {
	try {
		const duplicateId = await findDuplicateQuestion(tenantId, profileId, entry.question);

		if (duplicateId) {
			return {
				index,
				status: "skipped",
				question: entry.question,
				id: duplicateId,
				reason: "Bu savol bilim bazasida allaqachon bor",
			};
		}

		const [inserted] = await db
			.insert(knowledgeBaseEntries)
			.values({
				tenantId,
				agentProfileId: profileId,
				question: entry.question,
				answer: entry.answer,
				tags: entry.tags ?? null,
				priority: entry.priority ?? 0,
				isActive: entry.isActive ?? true,
				createdBy: userId,
			})
			.returning({ id: knowledgeBaseEntries.id });

		if (!inserted) {
			return {
				index,
				status: "failed",
				question: entry.question,
				id: null,
				reason: "Baza yozuv id'sini qaytarmadi",
			};
		}

		return {
			index,
			status: "created",
			question: entry.question,
			id: inserted.id,
			reason: null,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : "Noma'lum xato";

		return {
			index,
			status: "failed",
			question: entry.question,
			id: null,
			// Bounded: a Postgres error can carry a long detail string, and this goes
			// into an HTTP response.
			reason: reason.slice(0, 200),
		};
	}
}

// ===========================================
// Handlers
// ===========================================

export const listHandler: AppRouteHandler<typeof r.list> = async (c) => {
	const query = c.req.valid("query") as ListQuery;
	const { page, limit } = query;
	const offset = (page - 1) * limit;
	const tenantId = currentTenantId(c);

	const profile = await resolveProfileForRead(tenantId, query.profileId);

	if (!profile.id) {
		// No profile at all: an empty page is the honest answer, and a GET must not
		// create rows as a side effect.
		return c.json(
			{
				success: true as const,
				data: {
					items: [],
					meta: { total: 0, page, limit, totalPages: 0 },
					profileId: null,
				},
			},
			200
		);
	}

	const filters = buildListFilters(profile.id, query);

	// The tenant is spelled out at BOTH statements. A count taken through a wider
	// filter than the rows would report a total the caller can never page to, and the
	// number itself - "this business has 55 answers" - is a fact about that business.
	const [items, countResult] = await Promise.all([
		db
			.select()
			.from(knowledgeBaseEntries)
			.where(tenantWhere(knowledgeBaseEntries, tenantId, ...filters))
			// Priority is what wins at retrieval time, so it is also what an owner
			// should see first.
			.orderBy(desc(knowledgeBaseEntries.priority), desc(knowledgeBaseEntries.createdAt))
			.limit(limit)
			.offset(offset),
		db
			.select({ count: count() })
			.from(knowledgeBaseEntries)
			.where(tenantWhere(knowledgeBaseEntries, tenantId, ...filters)),
	]);

	const totalCount = Number(countResult[0]?.count ?? 0);

	return c.json(
		{
			success: true as const,
			data: {
				items: items.map(toItem),
				meta: {
					total: totalCount,
					page,
					limit,
					totalPages: Math.ceil(totalCount / limit),
				},
				profileId: profile.id,
			},
		},
		200
	);
};

export const getHandler: AppRouteHandler<typeof r.get> = async (c) => {
	const id = c.req.valid("param").id;
	const row = await findEntry(currentTenantId(c), id);

	return c.json({ success: true as const, data: toItem(row) }, 200);
};

export const createHandler: AppRouteHandler<typeof r.create> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");
	// resolveProfileForWrite is the parent-ownership check: a profileId in the body
	// that belongs to another tenant is a 404 there, so no entry can be hung off
	// somebody else's agent.
	const profile = await resolveProfileForWrite(c, body.profileId);

	const duplicateId = await findDuplicateQuestion(tenantId, profile.id, body.question);

	if (duplicateId) {
		throw businessError("Bu savol shu profilda allaqachon mavjud", [
			{
				field: "question",
				reason: `Mavjud yozuv: ${duplicateId}. Uni tahrirlang yoki savolni boshqacha yozing.`,
			},
		]);
	}

	const [inserted] = await db
		.insert(knowledgeBaseEntries)
		.values({
			tenantId,
			agentProfileId: profile.id,
			question: body.question,
			answer: body.answer,
			tags: body.tags ?? null,
			priority: body.priority ?? 0,
			isActive: body.isActive ?? true,
			createdBy: user.id,
		})
		.returning();

	if (!inserted) {
		throw databaseError("Bilim bazasi yozuvini saqlash natija qaytarmadi");
	}

	await audit(c, {
		action: "knowledge-base.create",
		entityType: "knowledge_base_entry",
		entityId: inserted.id,
		details: {
			profileId: profile.id,
			question: inserted.question,
			tags: inserted.tags,
			priority: inserted.priority,
			isActive: inserted.isActive,
		},
	});

	return c.json({ success: true as const, data: toItem(inserted) }, 201);
};

export const bulkHandler: AppRouteHandler<typeof r.bulk> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const user = c.get("user");
	const body = c.req.valid("json");
	const profile = await resolveProfileForWrite(c, body.profileId);

	const results: BulkRowResult[] = [];
	/** Takrorlar bir payload ichida ham bo'ladi (masalan bir xil savol ikki qatorda). */
	const seen = new Set<string>();

	// Sequential on purpose. The rows are checked against each other as well as
	// against the table, and 200 inserts is an import, not a hot path.
	for (const [index, entry] of body.entries.entries()) {
		const normalised = entry.question.trim().toLowerCase();

		if (seen.has(normalised)) {
			results.push({
				index,
				status: "skipped",
				question: entry.question,
				id: null,
				reason: "Bu savol yuborilgan ro'yxatda takrorlangan",
			});
			continue;
		}

		seen.add(normalised);
		results.push(await importRow(currentTenantId(c), profile.id, user.id, entry, index));
	}

	const failedRows = results.filter((row) => row.status === "failed");

	if (failedRows.length > 0) {
		c.var.logger.warn(
			{
				profileId: profile.id,
				failed: failedRows.map((row) => ({ index: row.index, reason: row.reason })),
			},
			"knowledge base bulk import had failed rows"
		);
	}

	const created = results.filter((row) => row.status === "created").length;
	const skipped = results.filter((row) => row.status === "skipped").length;
	const failed = results.filter((row) => row.status === "failed").length;

	await audit(c, {
		action: "knowledge-base.bulk-import",
		entityType: "ai_agent_profile",
		entityId: profile.id,
		details: {
			submitted: body.entries.length,
			created,
			skipped,
			failed,
			// Enough to find the bad rows in the source file without copying it all
			// into the audit log.
			failedIndexes: failedRows.map((row) => row.index),
		},
	});

	const payload = {
		success: true as const,
		data: { profileId: profile.id, created, skipped, failed, results },
	};

	return created > 0 ? c.json(payload, 201) : c.json(payload, 200);
};

export const updateHandler: AppRouteHandler<typeof r.update> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");
	const existing = await findEntry(tenantId, id);

	const updates: {
		question?: string;
		answer?: string;
		tags?: string[] | null;
		priority?: number;
		isActive?: boolean;
		updatedAt: Date;
	} = { updatedAt: new Date() };

	if (body.question !== undefined) {
		const duplicateId = await findDuplicateQuestion(
			tenantId,
			existing.agentProfileId,
			body.question,
			id
		);

		if (duplicateId) {
			throw businessError("Bu savol shu profilda allaqachon mavjud", [
				{ field: "question", reason: `Mavjud yozuv: ${duplicateId}` },
			]);
		}

		updates.question = body.question;
	}
	if (body.answer !== undefined) {
		updates.answer = body.answer;
	}
	if (body.tags !== undefined) {
		updates.tags = body.tags;
	}
	if (body.priority !== undefined) {
		updates.priority = body.priority;
	}
	if (body.isActive !== undefined) {
		updates.isActive = body.isActive;
	}

	await db
		.update(knowledgeBaseEntries)
		.set(updates)
		.where(tenantWhere(knowledgeBaseEntries, tenantId, eq(knowledgeBaseEntries.id, id)));

	const updated = await findEntry(tenantId, id);

	await audit(c, {
		action: "knowledge-base.update",
		entityType: "knowledge_base_entry",
		entityId: id,
		details: {
			profileId: existing.agentProfileId,
			fields: Object.keys(updates).filter((field) => field !== "updatedAt"),
			question: updated.question,
			previousIsActive: existing.isActive,
			isActive: updated.isActive,
		},
	});

	return c.json({ success: true as const, data: toItem(updated) }, 200);
};

export const removeHandler: AppRouteHandler<typeof r.remove> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const existing = await findEntry(tenantId, id);

	// Hard delete: this is content, not call history. The audit row keeps what was
	// removed, so a deleted answer is still traceable.
	await db
		.delete(knowledgeBaseEntries)
		.where(tenantWhere(knowledgeBaseEntries, tenantId, eq(knowledgeBaseEntries.id, id)));

	await audit(c, {
		action: "knowledge-base.delete",
		entityType: "knowledge_base_entry",
		entityId: id,
		details: {
			profileId: existing.agentProfileId,
			question: existing.question,
			answerLength: existing.answer.length,
			tags: existing.tags,
			useCount: existing.useCount,
			lastUsedAt: existing.lastUsedAt?.toISOString() ?? null,
		},
	});

	return c.json({ success: true as const, data: { message: "Yozuv o'chirildi" } }, 200);
};

export const searchHandler: AppRouteHandler<typeof r.search> = async (c) => {
	const body = c.req.valid("json");
	const tenantId = currentTenantId(c);
	const profile = await resolveProfileForRead(tenantId, body.profileId);

	// The real retrieval path, deliberately: a rehearsal that behaves differently
	// from a live call would be worse than no rehearsal at all - including the
	// tenant it retrieves for.
	const hits = profile.id
		? await searchKnowledgeBase(tenantId, profile.id, body.query, body.limit ?? 5)
		: [];

	return c.json(
		{
			success: true as const,
			data: {
				query: body.query,
				profileId: profile.id,
				businessName: profile.businessName,
				hitCount: hits.length,
				wouldAnswer: hits.length > 0,
				unknownPolicy: profile.unknownPolicy,
				fallbackAction: describeFallback(profile.unknownPolicy),
				hits: hits.map((hit) => ({
					id: hit.id,
					question: hit.question,
					answer: hit.answer,
					tags: hit.tags,
					priority: hit.priority,
					score: hit.score,
				})),
			},
		},
		200
	);
};

export const statsHandler: AppRouteHandler<typeof r.stats> = async (c) => {
	const query = c.req.valid("query") as StatsQuery;
	const tenantId = currentTenantId(c);
	const profile = await resolveProfileForRead(tenantId, query.profileId);

	if (!profile.id) {
		return c.json(
			{
				success: true as const,
				data: {
					profileId: null,
					businessName: profile.businessName,
					total: 0,
					active: 0,
					inactive: 0,
					neverUsed: 0,
					totalUses: 0,
					lastUsedAt: null,
					topEntries: [],
				},
			},
			200
		);
	}

	// The profile filter is shared so the aggregate and the top-N cannot ask different
	// questions; the tenant is written at each statement so neither can lose it.
	const profileFilter = eq(knowledgeBaseEntries.agentProfileId, profile.id);

	const [aggregateRows, topRows] = await Promise.all([
		db
			.select({
				total: count(),
				active: sql<number>`count(*) filter (where ${knowledgeBaseEntries.isActive})`,
				neverUsed: sql<number>`count(*) filter (where ${knowledgeBaseEntries.useCount} = 0)`,
				totalUses: sql<number>`coalesce(sum(${knowledgeBaseEntries.useCount}), 0)`,
				lastUsedAt: sql<Date | string | null>`max(${knowledgeBaseEntries.lastUsedAt})`,
			})
			.from(knowledgeBaseEntries)
			.where(tenantWhere(knowledgeBaseEntries, tenantId, profileFilter)),
		db
			.select({
				id: knowledgeBaseEntries.id,
				question: knowledgeBaseEntries.question,
				tags: knowledgeBaseEntries.tags,
				useCount: knowledgeBaseEntries.useCount,
				lastUsedAt: knowledgeBaseEntries.lastUsedAt,
				isActive: knowledgeBaseEntries.isActive,
			})
			.from(knowledgeBaseEntries)
			.where(tenantWhere(knowledgeBaseEntries, tenantId, profileFilter))
			.orderBy(desc(knowledgeBaseEntries.useCount), desc(knowledgeBaseEntries.lastUsedAt))
			.limit(query.limit),
	]);

	const aggregate = aggregateRows[0];
	const total = Number(aggregate?.total ?? 0);
	const active = Number(aggregate?.active ?? 0);

	return c.json(
		{
			success: true as const,
			data: {
				profileId: profile.id,
				businessName: profile.businessName,
				total,
				active,
				inactive: total - active,
				neverUsed: Number(aggregate?.neverUsed ?? 0),
				totalUses: Number(aggregate?.totalUses ?? 0),
				lastUsedAt: toIso(aggregate?.lastUsedAt ?? null),
				topEntries: topRows.map((row) => ({
					id: row.id,
					question: row.question,
					tags: row.tags ?? [],
					useCount: row.useCount,
					lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
					isActive: row.isActive,
				})),
			},
		},
		200
	);
};
