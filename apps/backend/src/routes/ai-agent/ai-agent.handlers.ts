/**
 * HTTP layer for the business profile the AI agent answers as.
 *
 * The product is sold to business owners who point their own phone line at it, so
 * these endpoints are the only place the agent's identity is defined: its name,
 * its language, what it may promise, which ticket categories it may file, and
 * what it does when the knowledge base has no answer. Nothing here is
 * hardcoded per industry — a dental clinic and a taxi firm are the same code
 * with different rows.
 *
 * Two invariants this file is responsible for:
 *
 *   1. Every mutation invalidates the in-process profile cache. A business that
 *      edits its greeting expects the NEXT caller to hear it, not the next
 *      restart. lib/ai-agent already invalidates inside activateProfile() and
 *      ensureDefaultProfile(); the explicit calls here cover the plain UPDATE and
 *      DELETE paths and make the rule visible at every exit.
 *   2. The line is never left unanswerable. The active profile cannot be deleted,
 *      and a "transfer unknown questions to a human" policy cannot be saved with
 *      no extension to transfer to.
 */
import type { UserRoleType } from "@shared/types";
import { count, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import type { AiAgentProfileRecord, UnknownAnswerPolicy } from "@/db/schema";
import { aiAgentProfiles, knowledgeBaseEntries } from "@/db/schema";
import type { ActiveAgentProfile } from "@/lib/ai-agent";
import {
	activateProfile,
	DEFAULT_PROFILE,
	ensureDefaultProfile,
	invalidateAgentProfileCache,
	isWithinBusinessHours,
} from "@/lib/ai-agent";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { businessError, databaseError, invalidInput, notFound } from "@/lib/errors";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type * as r from "./ai-agent.routes";
import type { AgentProfileItem } from "./ai-agent.schemas";

/** Who the agent is for this business is a business decision, not an operator's. */
const ALLOWED_WRITE_ROLES: UserRoleType[] = ["supervisor", "admin"];

type KnowledgeCounts = { total: number; active: number };

const EMPTY_COUNTS: KnowledgeCounts = { total: 0, active: 0 };

// ===========================================
// Serialisation
// ===========================================

function toItem(row: AiAgentProfileRecord, counts: KnowledgeCounts): AgentProfileItem {
	return {
		id: row.id,
		businessName: row.businessName,
		industry: row.industry,
		businessDescription: row.businessDescription,
		language: row.language,
		additionalLanguages: row.additionalLanguages ?? [],
		voice: row.voice,
		greeting: row.greeting,
		recordingNotice: row.recordingNotice,
		customInstructions: row.customInstructions,
		ticketCategories: row.ticketCategories ?? [],
		unknownPolicy: row.unknownPolicy as UnknownAnswerPolicy,
		transferExtensions: row.transferExtensions ?? [],
		businessHours: row.businessHours ?? null,
		afterHoursMessage: row.afterHoursMessage,
		maxCallSeconds: row.maxCallSeconds,
		silenceHangupMs: row.silenceHangupMs,
		isActive: row.isActive,
		knowledgeEntryCount: counts.total,
		activeKnowledgeEntryCount: counts.active,
		createdBy: row.createdBy,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * The row as the call path sees it.
 *
 * isWithinBusinessHours() reads only `businessHours`, but its parameter is the
 * full profile shape, and building that shape here is what lets the dashboard ask
 * "is this profile open now?" about a DRAFT too — getActiveAgentProfile() can
 * only ever describe the live one.
 */
function toCallShape(row: AiAgentProfileRecord): ActiveAgentProfile {
	return {
		id: row.id,
		businessName: row.businessName,
		industry: row.industry,
		businessDescription: row.businessDescription,
		language: row.language,
		additionalLanguages: row.additionalLanguages ?? [],
		voice: row.voice,
		greeting: row.greeting,
		recordingNotice: row.recordingNotice,
		customInstructions: row.customInstructions,
		ticketCategories: row.ticketCategories ?? [...DEFAULT_PROFILE.ticketCategories],
		unknownPolicy: row.unknownPolicy as UnknownAnswerPolicy,
		transferExtensions: row.transferExtensions ?? [...DEFAULT_PROFILE.transferExtensions],
		businessHours: row.businessHours ?? null,
		afterHoursMessage: row.afterHoursMessage,
		maxCallSeconds: row.maxCallSeconds,
		silenceHangupMs: row.silenceHangupMs,
		isConfigured: true,
	};
}

function toDetail(row: AiAgentProfileRecord, counts: KnowledgeCounts) {
	return {
		...toItem(row, counts),
		isOpenNow: isWithinBusinessHours(toCallShape(row)),
	};
}

// ===========================================
// Knowledge base counters
// ===========================================

async function countsFor(tenantId: TenantId, profileId: string): Promise<KnowledgeCounts> {
	const [row] = await db
		.select({
			total: count(),
			active: sql<number>`count(*) filter (where ${knowledgeBaseEntries.isActive})`,
		})
		.from(knowledgeBaseEntries)
		.where(
			tenantWhere(
				knowledgeBaseEntries,
				tenantId,
				eq(knowledgeBaseEntries.agentProfileId, profileId)
			)
		);

	return {
		total: Number(row?.total ?? 0),
		active: Number(row?.active ?? 0),
	};
}

async function countsByProfile(tenantId: TenantId): Promise<Map<string, KnowledgeCounts>> {
	const rows = await db
		.select({
			profileId: knowledgeBaseEntries.agentProfileId,
			total: count(),
			active: sql<number>`count(*) filter (where ${knowledgeBaseEntries.isActive})`,
		})
		.from(knowledgeBaseEntries)
		// An aggregate is as leaky as a row read: without the tenant this GROUP BY
		// returns a bucket per profile on the whole platform, and the list handler
		// would report how much content every other customer has written.
		.where(tenantWhere(knowledgeBaseEntries, tenantId))
		.groupBy(knowledgeBaseEntries.agentProfileId);

	return new Map(
		rows.map((row) => [
			row.profileId,
			{ total: Number(row.total), active: Number(row.active) } satisfies KnowledgeCounts,
		])
	);
}

// ===========================================
// Validation that zod cannot express alone
// ===========================================

function assertNoDuplicates(values: string[], field: string, label: string): void {
	const normalised = new Set(values.map((value) => value.trim().toLowerCase()));

	if (normalised.size !== values.length) {
		throw invalidInput(field, `${label} takrorlanmasligi kerak`);
	}
}

/**
 * A "transfer the caller to a human" policy with nowhere to transfer to is a
 * promise the agent cannot keep: lib/ai-agent would silently fall back to this
 * deployment's default extensions (101..104), which for somebody else's business
 * are simply wrong numbers.
 */
function assertTransferReachable(policy: UnknownAnswerPolicy, extensions: string[]): void {
	if (policy === "transfer" && extensions.length === 0) {
		throw businessError(
			"unknownPolicy = transfer bo'lganda kamida bitta ichki raqam ko'rsatilishi kerak",
			[
				{
					field: "transferExtensions",
					reason:
						"Agent javobni bilmaganda odamga uzatishi kerak, lekin uzatiladigan raqam yo'q. Raqam qo'shing yoki unknownPolicy'ni take_message / say_unknown ga o'zgartiring.",
				},
			]
		);
	}
}

// ===========================================
// Field mapping
// ===========================================

/**
 * Only the fields the caller actually sent.
 *
 * This is what makes PATCH semantics unambiguous: an absent field is untouched,
 * and an explicit null clears the column. A per-field `if (x !== undefined)`
 * ladder does the same thing sixteen times and quietly forgets the seventeenth
 * column somebody adds later.
 */
function pickDefined<T extends object>(source: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(source).filter(([, value]) => value !== undefined)
	) as Partial<T>;
}

/**
 * What an unspecified field means on create. Mirrors ensureDefaultProfile(), so a
 * profile created through the API and the one created for a fresh install start
 * from the same cautious place (unknown questions go to a human).
 *
 * Built per call rather than as a module constant: the arrays would otherwise be
 * shared between requests.
 */
function newProfileDefaults() {
	return {
		industry: null as string | null,
		businessDescription: null as string | null,
		language: DEFAULT_PROFILE.language as string,
		additionalLanguages: [...DEFAULT_PROFILE.additionalLanguages],
		voice: DEFAULT_PROFILE.voice as string,
		greeting: null as string | null,
		recordingNotice: DEFAULT_PROFILE.recordingNotice as string | null,
		customInstructions: null as string | null,
		ticketCategories: [...DEFAULT_PROFILE.ticketCategories],
		unknownPolicy: DEFAULT_PROFILE.unknownPolicy,
		transferExtensions: [...DEFAULT_PROFILE.transferExtensions],
		businessHours: null as Record<string, unknown> | null,
		afterHoursMessage: null as string | null,
		maxCallSeconds: DEFAULT_PROFILE.maxCallSeconds as number,
		silenceHangupMs: DEFAULT_PROFILE.silenceHangupMs as number,
	};
}

/**
 * One profile of THIS tenant, or 404.
 *
 * 404 and not 403 for another tenant's id, deliberately: "you may not see this"
 * confirms the id exists somewhere on the platform, and a profile id is a fact
 * about another business. See lib/tenancy/scope.ts.
 */
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
 * The profile answering THIS tenant's calls.
 *
 * The unique index behind "exactly one active profile" is per tenant, so without
 * the tenant term this returns whichever customer's row Postgres reaches first -
 * and every caller of it decides what the agent says.
 */
async function findActiveProfile(tenantId: TenantId): Promise<AiAgentProfileRecord | undefined> {
	return await db.query.aiAgentProfiles.findFirst({
		where: tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.isActive, true)),
	});
}

// ===========================================
// Handlers
// ===========================================

export const listProfilesHandler: AppRouteHandler<typeof r.listProfiles> = async (c) => {
	const tenantId = currentTenantId(c);
	const [rows, counts] = await Promise.all([
		db
			.select()
			.from(aiAgentProfiles)
			.where(tenantWhere(aiAgentProfiles, tenantId))
			// TRUE > FALSE in Postgres, so the live profile is always the first row.
			.orderBy(desc(aiAgentProfiles.isActive), desc(aiAgentProfiles.createdAt)),
		countsByProfile(tenantId),
	]);

	return c.json(
		{
			success: true as const,
			data: {
				items: rows.map((row) => toItem(row, counts.get(row.id) ?? EMPTY_COUNTS)),
				activeProfileId: rows.find((row) => row.isActive)?.id ?? null,
				total: rows.length,
			},
		},
		200
	);
};

export const getActiveHandler: AppRouteHandler<typeof r.getActive> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const existing = await findActiveProfile(tenantId);
	const row = existing ?? (await ensureDefaultProfile(tenantId, user.id));

	if (!existing) {
		// ensureDefaultProfile() invalidates too; repeated here so the rule holds at
		// every mutating exit of this file, including this one hiding inside a GET.
		// Per tenant: dropping every tenant's entry would make one customer's edit
		// cost every other customer a database read on their next call.
		invalidateAgentProfileCache(tenantId);

		await audit(c, {
			action: "ai-agent.profile.create-default",
			entityType: "ai_agent_profile",
			entityId: row.id,
			details: { businessName: row.businessName, reason: "aktiv profil topilmadi" },
		});
	}

	const counts = await countsFor(tenantId, row.id);

	return c.json({ success: true as const, data: toDetail(row, counts) }, 200);
};

export const createProfileHandler: AppRouteHandler<typeof r.createProfile> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");

	// Defaults first, then whatever the owner actually sent. Absent means "use the
	// cautious default"; the fields are never read with ?? one by one, so a new
	// column cannot be forgotten in one of sixteen places.
	const draft = { ...newProfileDefaults(), ...pickDefined(body), businessName: body.businessName };

	assertNoDuplicates(draft.ticketCategories, "ticketCategories", "Ticket kategoriyalari");
	assertNoDuplicates(draft.transferExtensions, "transferExtensions", "Ichki raqamlar");
	assertNoDuplicates(draft.additionalLanguages, "additionalLanguages", "Qo'shimcha tillar");
	assertTransferReachable(draft.unknownPolicy, draft.transferExtensions);

	// Read before insert: whether this profile has to go live immediately depends
	// on there being nobody answering the line at all.
	const activeExisting = await findActiveProfile(tenantId);

	const [inserted] = await db
		.insert(aiAgentProfiles)
		.values({
			tenantId,
			...draft,
			// A new profile is a draft: editing a persona must never change what the
			// caller on the line right now is hearing.
			isActive: false,
			createdBy: user.id,
		})
		.returning();

	if (!inserted) {
		throw databaseError("Profilni yozish natija qaytarmadi");
	}

	let row = inserted;

	if (activeExisting) {
		invalidateAgentProfileCache(tenantId);
	} else {
		// Nothing was answering: leaving the first configured profile as a draft
		// would keep the AI on the generic fallback defaults.
		await activateProfile(tenantId, inserted.id);
		row = (await findActiveProfile(tenantId)) ?? inserted;
	}

	await audit(c, {
		action: "ai-agent.profile.create",
		entityType: "ai_agent_profile",
		entityId: row.id,
		details: {
			businessName: row.businessName,
			industry: row.industry,
			unknownPolicy: row.unknownPolicy,
			ticketCategories: row.ticketCategories,
			autoActivated: !activeExisting,
		},
	});

	return c.json({ success: true as const, data: toItem(row, EMPTY_COUNTS) }, 201);
};

type ProfileUpdate = {
	businessName?: string;
	industry?: string | null;
	businessDescription?: string | null;
	language?: string;
	additionalLanguages?: string[];
	voice?: string;
	greeting?: string | null;
	recordingNotice?: string | null;
	customInstructions?: string | null;
	ticketCategories?: string[];
	unknownPolicy?: UnknownAnswerPolicy;
	transferExtensions?: string[];
	businessHours?: Record<string, unknown> | null;
	afterHoursMessage?: string | null;
	maxCallSeconds?: number;
	silenceHangupMs?: number;
	updatedAt: Date;
};

export const updateProfileHandler: AppRouteHandler<typeof r.updateProfile> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");
	const existing = await findProfile(tenantId, id);

	if (body.additionalLanguages) {
		assertNoDuplicates(body.additionalLanguages, "additionalLanguages", "Qo'shimcha tillar");
	}
	if (body.ticketCategories) {
		assertNoDuplicates(body.ticketCategories, "ticketCategories", "Ticket kategoriyalari");
	}
	if (body.transferExtensions) {
		assertNoDuplicates(body.transferExtensions, "transferExtensions", "Ichki raqamlar");
	}

	// `voice` is deliberately not checked against a fixed list: OpenAI adds Realtime
	// voices, and rejecting an unknown one would make this endpoint go stale. The
	// dashboard's dropdown reads GET /ai-assistant/config -> knownVoices.
	const updates: ProfileUpdate = { ...pickDefined(body), updatedAt: new Date() };

	// Checked against the merged result, not against the patch: sending only
	// { unknownPolicy: "transfer" } must fail when the stored extensions are empty.
	assertTransferReachable(
		body.unknownPolicy ?? (existing.unknownPolicy as UnknownAnswerPolicy),
		body.transferExtensions ?? existing.transferExtensions ?? []
	);

	await db
		.update(aiAgentProfiles)
		.set(updates)
		// findProfile() already proved the row is this tenant's, so the tenant term
		// cannot change which row is written. It is here because an UPDATE keyed on an
		// id alone is one refactor - a removed lookup, a reordered guard - away from
		// editing another business's agent, and the WHERE is the only thing the
		// database enforces.
		.where(tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.id, id)));

	// The edited profile may be the live one, so the next call must not be served
	// from the cache.
	invalidateAgentProfileCache(tenantId);

	const updated = await findProfile(tenantId, id);
	const counts = await countsFor(tenantId, id);

	await audit(c, {
		action: "ai-agent.profile.update",
		entityType: "ai_agent_profile",
		entityId: id,
		details: {
			fields: Object.keys(updates).filter((field) => field !== "updatedAt"),
			businessName: updated.businessName,
			isActive: updated.isActive,
			previousUnknownPolicy: existing.unknownPolicy,
			unknownPolicy: updated.unknownPolicy,
		},
	});

	return c.json({ success: true as const, data: toDetail(updated, counts) }, 200);
};

export const activateHandler: AppRouteHandler<typeof r.activate> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const existing = await findProfile(tenantId, id);

	if (existing.isActive) {
		const counts = await countsFor(tenantId, id);

		// Idempotent: nothing changed, so nothing is audited either.
		return c.json({ success: true as const, data: toDetail(existing, counts) }, 200);
	}

	const previousActive = await findActiveProfile(tenantId);

	// One transaction inside the lib: the partial unique index on is_active would
	// reject a second live row, so deactivate-then-activate cannot be split.
	await activateProfile(tenantId, id);
	invalidateAgentProfileCache(tenantId);

	const activated = await findProfile(tenantId, id);
	const counts = await countsFor(tenantId, id);

	await audit(c, {
		action: "ai-agent.profile.activate",
		entityType: "ai_agent_profile",
		entityId: id,
		details: {
			businessName: activated.businessName,
			previousActiveId: previousActive?.id ?? null,
			previousActiveName: previousActive?.businessName ?? null,
		},
	});

	return c.json({ success: true as const, data: toDetail(activated, counts) }, 200);
};

export const removeProfileHandler: AppRouteHandler<typeof r.removeProfile> = async (c) => {
	requireRoles(c, ALLOWED_WRITE_ROLES);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const existing = await findProfile(tenantId, id);

	if (existing.isActive) {
		throw businessError(
			`«${existing.businessName}» hozir qo'ng'iroqlarga javob berayotgan aktiv profil — o'chirib bo'lmaydi. Avval boshqa profilni aktivlashtiring, keyin o'chiring.`,
			[{ field: "id", reason: "Aktiv profil o'chirilmaydi" }]
		);
	}

	// Counted before the delete: the FK cascade removes the entries silently, and
	// the owner deserves to see how much content went with the profile.
	const counts = await countsFor(tenantId, id);

	await db
		.delete(aiAgentProfiles)
		.where(tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.id, id)));
	invalidateAgentProfileCache(tenantId);

	await audit(c, {
		action: "ai-agent.profile.delete",
		entityType: "ai_agent_profile",
		entityId: id,
		details: {
			businessName: existing.businessName,
			deletedKnowledgeEntries: counts.total,
		},
	});

	return c.json(
		{
			success: true as const,
			data: {
				message: `«${existing.businessName}» profili o'chirildi`,
				deletedKnowledgeEntries: counts.total,
			},
		},
		200
	);
};
