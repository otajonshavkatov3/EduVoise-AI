/**
 * Outbound campaigns: CRUD, the three lifecycle transitions, and the progress
 * summary.
 *
 * WHAT THIS ENDPOINT GROUP IS RESPONSIBLE FOR
 *
 * Deciding, refusing and reporting. It never places a call: the dialer on the call
 * path does that, reading the rows these handlers write and going through
 * lib/campaigns for every rule. So the rules that matter live in lib/campaigns and
 * are imported here rather than reimplemented - the transition table, the calling
 * window, the do-not-call gate, the retry policy.
 *
 * WHO MAY DO WHAT, AND WHY
 *
 *   read      every authenticated role. A manager whose customers are being called
 *             has to be able to watch it happen.
 *   write     supervisor + admin. What a stranger is told is a business decision,
 *             the same rule the knowledge base uses.
 *   start     supervisor + admin. Starting a campaign spends money and rings real
 *             people; it is gated exactly like /ai-costs, which is the page that
 *             shows what it cost.
 *   money     supervisor + admin. /progress returns `spend.visible: false` and
 *             nulls to anyone else, so a manager refused the cost page cannot read
 *             the same figure here. That is the identical rule GET /calls/{id}/full
 *             applies to one call's cost.
 *
 * COST IS PRICED ON READ, THROUGH lib/ai-cost, USING /ai-costs' OWN FOLD
 *
 * `createAccumulator` and `accumulate` are imported from routes/ai-costs rather
 * than reimplemented. Summing `totalCostUsd` per session looks equivalent and is
 * not: that fold already knows that an unpriceable voice line must not discard the
 * analysis spend on the same call, and that a bucket which only ever saw nulls
 * reports null instead of $0.00. A second copy of that reasoning is how a campaign
 * page and the cost page start quoting different numbers for the same calls.
 */
import type { UserRoleType } from "@shared/types";
import {
	and,
	asc,
	count,
	desc,
	eq,
	ilike,
	inArray,
	isNotNull,
	isNull,
	or,
	type SQL,
	sql,
} from "drizzle-orm";

import { db } from "@/db";
import type { CallCampaignRecord, CampaignOutcome, CampaignStatus } from "@/db/schema";
import {
	aiAgentProfiles,
	aiAnalyses,
	aiSessions,
	callCampaigns,
	calls,
	campaignCallAttempts,
	campaignLeads,
	campaignOutcomeEnum,
	users,
} from "@/db/schema";
import {
	type AnalysisTokens,
	loadRates,
	priceSession,
	roundMoney,
	type SessionTokens,
	toUzs,
} from "@/lib/ai-cost";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import {
	assertTransition,
	availableActions,
	type CampaignAction,
	checkDialAllowed,
	describeWindow,
	formatPhone,
	isEditable,
	isExtension,
	recordDialOutcome,
	resolveTenantTimeZone,
} from "@/lib/campaigns";
import { businessError, databaseError, invalidOperation, notFound } from "@/lib/errors";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import {
	type Accumulator,
	accumulate,
	createAccumulator,
} from "@/routes/ai-costs/ai-costs.handlers";
import type * as r from "./campaigns.routes";
import {
	type CampaignItem,
	type DialingReadiness,
	type LeadItem,
	type LeadListQuery,
	type ListQuery,
	STALE_CALLING_MINUTES,
	type UpdateBody,
} from "./campaigns.schemas";

/**
 * Who may create, edit, start, pause and cancel a campaign.
 *
 * The same two roles /ai-costs is gated to, on purpose: pressing "start" is the act
 * that spends the money that page reports, so anybody allowed to spend it must be
 * allowed to see it, and anybody refused the report must not be able to start the
 * spending.
 */
export const CAN_MANAGE: UserRoleType[] = ["supervisor", "admin"];

/** Deleting a do-not-call entry is admin-only - see the route description. */
export const CAN_DELETE_DNC: UserRoleType[] = ["admin"];

/** Who may see what a campaign cost. Identical to GET /calls/{id}/full. */
const CAN_SEE_COST: UserRoleType[] = ["supervisor", "admin"];

const MS_PER_MINUTE = 60_000;

// ===========================================
// Dialing readiness
// ===========================================

/**
 * Can this deployment actually place the calls this campaign asks for?
 *
 * SIP_TRUNK_HOST is the one fact that decides it: the Asterisk entrypoint creates a
 * PSTN trunk only when that variable is set, so with it empty the platform can dial
 * internal PJSIP endpoints (101-104 desk, 201-204 browser) and nothing else. A
 * campaign aimed at mobile numbers would then fail on every single row, which is
 * why start refuses it and says so instead of letting somebody watch 500 rows go
 * red.
 *
 * Read from the environment rather than from the settings registry because the
 * trunk is not a runtime setting: Asterisk reads it once, at container start, when
 * it writes pjsip.conf. A value changed in the CRM would not create a trunk.
 */
export function trunkConfigured(): boolean {
	return (process.env.SIP_TRUNK_HOST ?? "").trim().length > 0;
}

export interface ReadinessCounts {
	external: number;
	internal: number;
}

export function describeReadiness(counts: ReadinessCounts): DialingReadiness {
	const hasTrunk = trunkConfigured();
	const hasExternalLeads = counts.external > 0;
	const hasInternalLeads = counts.internal > 0;
	const canDial = hasTrunk ? hasExternalLeads || hasInternalLeads : hasInternalLeads;

	let warning = "";

	if (!hasTrunk) {
		warning =
			"Tashqi liniya (SIP trunk) sozlanmagan: .env dagi SIP_TRUNK_HOST bo'sh, shuning uchun " +
			"mobil raqamlarga qo'ng'iroq ketmaydi. Hozir faqat ichki raqamlarga (101–104, 201–204) " +
			"qo'ng'iroq qilib sinash mumkin. Operatorga: SIP_TRUNK_HOST, SIP_TRUNK_USERNAME, " +
			"SIP_TRUNK_PASSWORD va SIP_TRUNK_AUTH_MODE ni to'ldirib Asterisk'ni qayta ishga tushiring.";

		if (hasExternalLeads && hasInternalLeads) {
			warning += ` Ro'yxatdagi ${counts.external} ta tashqi raqam o'tkazib yuboriladi.`;
		}
	}

	return { trunkConfigured: hasTrunk, hasExternalLeads, hasInternalLeads, canDial, warning };
}

/** Counts the pending leads of a campaign by whether they are extensions or MSISDNs. */
async function countDialableLeads(
	tenantId: TenantId,
	campaignId: string
): Promise<ReadinessCounts> {
	const rows = await db
		.select({ phoneNumber: campaignLeads.phoneNumber })
		.from(campaignLeads)
		.where(
			tenantWhere(
				campaignLeads,
				tenantId,
				eq(campaignLeads.campaignId, campaignId),
				eq(campaignLeads.status, "pending")
			)
		);

	let internal = 0;
	let external = 0;

	for (const row of rows) {
		if (isExtension(row.phoneNumber)) {
			internal += 1;
		} else {
			external += 1;
		}
	}

	return { internal, external };
}

// ===========================================
// Serialisation
// ===========================================

/** The name a person is shown by, falling back to the phone they log in with. */
function userLabel(row: { username: string | null; phone: string } | null): string | null {
	if (row === null) {
		return null;
	}

	return row.username ?? row.phone;
}

interface CampaignRowJoins {
	campaign: CallCampaignRecord;
	profileName: string | null;
	createdByName: string | null;
	startedByName: string | null;
	leadCount: number;
	pendingCount: number;
}

function toCampaignItem(input: CampaignRowJoins): CampaignItem {
	const row = input.campaign;

	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		purpose: row.purpose,
		script: row.script,
		agentProfileId: row.agentProfileId,
		agentProfileName: input.profileName,
		status: row.status,
		callWindowStart: row.callWindowStart,
		callWindowEnd: row.callWindowEnd,
		maxAttempts: row.maxAttempts,
		retryDelayMinutes: row.retryDelayMinutes,
		concurrency: row.concurrency,
		createdBy: row.createdBy,
		createdByName: input.createdByName,
		startedBy: row.startedBy,
		startedByName: input.startedByName,
		startedAt: row.startedAt?.toISOString() ?? null,
		pausedAt: row.pausedAt?.toISOString() ?? null,
		endedAt: row.endedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		leadCount: input.leadCount,
		pendingCount: input.pendingCount,
		availableActions: availableActions(row.status),
	};
}

export function toLeadItem(row: {
	id: string;
	campaignId: string;
	phoneNumber: string;
	fullName: string | null;
	contactId: string | null;
	variables: Record<string, string> | null;
	status: LeadItem["status"];
	outcome: CampaignOutcome | null;
	attempts: number;
	lastAttemptAt: Date | null;
	nextAttemptAt: Date | null;
	callId: string | null;
	note: string | null;
	createdAt: Date;
	updatedAt: Date;
}): LeadItem {
	return {
		id: row.id,
		campaignId: row.campaignId,
		phoneNumber: row.phoneNumber,
		phoneDisplay: formatPhone(row.phoneNumber),
		fullName: row.fullName,
		contactId: row.contactId,
		variables: row.variables ?? {},
		status: row.status,
		outcome: row.outcome,
		attempts: row.attempts,
		lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
		nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
		callId: row.callId,
		note: row.note,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

// ===========================================
// Loading
// ===========================================

const creator = users;

/**
 * One campaign with the names and the two counts the list needs.
 *
 * The counts are subqueries rather than a GROUP BY join so a campaign with no leads
 * still comes back, and so the list stays one query whatever the page size is.
 */
/**
 * The tenant filter is applied INSIDE this builder, together with the extra
 * conditions, rather than by the caller chaining a second `.where()`.
 *
 * Drizzle allows exactly one `.where()` per select, so a builder that already had
 * one and a caller that adds another do not compose - the caller's would be a type
 * error at best and a silently dropped tenant filter at worst. Taking the extras as
 * an argument means there is one WHERE, tenant-first, and no way to write a caller
 * that forgets it.
 */
function campaignSelect(tenantId: TenantId, filters?: SQL) {
	// The two counting sub-queries carry the tenant as well. They are correlated on
	// campaign_id, so the campaign's own filter already bounds them - but they read
	// campaign_leads, and a count is exactly as disclosing as a row: "this campaign
	// has 480 numbers" is a fact about somebody's customer list. The tenant term also
	// puts them on idx_campaign_leads_tenant_phone's leading column.
	const leadCount = sql<number>`(
		SELECT count(*) FROM ${campaignLeads}
		WHERE ${campaignLeads.tenantId} = ${tenantId} AND ${campaignLeads.campaignId} = ${callCampaigns.id}
	)`;
	const pendingCount = sql<number>`(
		SELECT count(*) FROM ${campaignLeads}
		WHERE ${campaignLeads.tenantId} = ${tenantId}
			AND ${campaignLeads.campaignId} = ${callCampaigns.id}
			AND ${campaignLeads.status} = 'pending'
	)`;

	// EVERY JOINED TABLE IS SCOPED, not only the driving one. A campaign row of this
	// tenant pointing at another tenant's agent profile or creator would otherwise
	// pull that business's NAME into this response - the join, not the base table, is
	// where a leak of this shape lives. With the predicate on the ON clause a bad
	// pointer yields null (the joins are left joins) instead of a stranger's name.
	return db
		.select({
			campaign: callCampaigns,
			profileName: aiAgentProfiles.businessName,
			createdByUsername: creator.username,
			createdByPhone: creator.phone,
			leadCount,
			pendingCount,
		})
		.from(callCampaigns)
		.leftJoin(
			aiAgentProfiles,
			and(
				eq(callCampaigns.agentProfileId, aiAgentProfiles.id),
				eq(aiAgentProfiles.tenantId, tenantId)
			)
		)
		.leftJoin(creator, and(eq(callCampaigns.createdBy, creator.id), eq(creator.tenantId, tenantId)))
		.where(tenantWhere(callCampaigns, tenantId, filters));
}

/** The starter's name, looked up separately: two joins onto `users` for one row is worse. */
async function starterName(tenantId: TenantId, startedBy: string | null): Promise<string | null> {
	if (startedBy === null) {
		return null;
	}

	const row = await db.query.users.findFirst({
		where: tenantWhere(users, tenantId, eq(users.id, startedBy)),
		columns: { username: true, phone: true },
	});

	return row === undefined ? null : userLabel(row);
}

async function loadCampaignItem(tenantId: TenantId, id: string): Promise<CampaignItem> {
	const [row] = await campaignSelect(tenantId, eq(callCampaigns.id, id)).limit(1);

	if (row === undefined) {
		throw notFound("Kampaniya", id);
	}

	return toCampaignItem({
		campaign: row.campaign,
		profileName: row.profileName,
		createdByName: userLabel(
			row.createdByPhone === null
				? null
				: { username: row.createdByUsername, phone: row.createdByPhone }
		),
		startedByName: await starterName(tenantId, row.campaign.startedBy),
		leadCount: Number(row.leadCount),
		pendingCount: Number(row.pendingCount),
	});
}

/**
 * One campaign of THIS tenant, or 404.
 *
 * Every handler below starts here, which is what makes a campaign id from another
 * customer a 404 rather than a 403: a 403 would confirm the id exists, and a
 * campaign id is a fact about their business. campaigns.leads.handlers.ts uses the
 * same function for the same reason.
 */
export async function findCampaign(tenantId: TenantId, id: string): Promise<CallCampaignRecord> {
	const row = await db.query.callCampaigns.findFirst({
		where: tenantWhere(callCampaigns, tenantId, eq(callCampaigns.id, id)),
	});

	if (row === undefined) {
		throw notFound("Kampaniya", id);
	}

	return row;
}

/** ILIKE metabelgilarini ekranlaydi: "%" yozgan foydalanuvchi hamma yozuvni topmasligi kerak. */
function likePattern(value: string): string {
	return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

// ===========================================
// GET /
// ===========================================

export const listHandler: AppRouteHandler<typeof r.list> = async (c) => {
	const query = c.req.valid("query") as ListQuery;
	const tenantId = currentTenantId(c);
	const offset = (query.page - 1) * query.limit;

	// The tenant is NOT in this list. campaignSelect() puts it in the base WHERE and
	// the count below adds it through tenantWhere(), so no status / kind / q filter -
	// and no page offset - can widen the set past it.
	const conditions: SQL[] = [];

	if (query.status !== undefined) {
		conditions.push(eq(callCampaigns.status, query.status));
	}

	if (query.kind !== undefined) {
		conditions.push(eq(callCampaigns.kind, query.kind));
	}

	if (query.q !== undefined) {
		const pattern = likePattern(query.q);
		const textMatch = or(ilike(callCampaigns.name, pattern), ilike(callCampaigns.purpose, pattern));

		if (textMatch !== undefined) {
			conditions.push(textMatch);
		}
	}

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const [rows, countRows] = await Promise.all([
		campaignSelect(tenantId, where)
			// Running first, then by recency: the campaign that is dialling right now is
			// the one an operator opened the page for.
			.orderBy(
				sql`case ${callCampaigns.status} when 'running' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end`,
				desc(callCampaigns.createdAt)
			)
			.limit(query.limit)
			.offset(offset),
		db
			.select({ value: count() })
			.from(callCampaigns)
			.where(tenantWhere(callCampaigns, tenantId, where)),
	]);

	const starterIds = Array.from(
		new Set(rows.map((row) => row.campaign.startedBy).filter((id): id is string => id !== null))
	);
	const starters =
		starterIds.length === 0
			? []
			: await db
					.select({ id: users.id, username: users.username, phone: users.phone })
					.from(users)
					.where(tenantWhere(users, tenantId, inArray(users.id, starterIds)));
	const starterById = new Map(starters.map((row) => [row.id, userLabel(row)]));

	const total = Number(countRows[0]?.value ?? 0);

	return c.json(
		{
			success: true as const,
			data: {
				items: rows.map((row) =>
					toCampaignItem({
						campaign: row.campaign,
						profileName: row.profileName,
						createdByName: userLabel(
							row.createdByPhone === null
								? null
								: { username: row.createdByUsername, phone: row.createdByPhone }
						),
						startedByName:
							row.campaign.startedBy === null
								? null
								: (starterById.get(row.campaign.startedBy) ?? null),
						leadCount: Number(row.leadCount),
						pendingCount: Number(row.pendingCount),
					})
				),
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
// GET /{id}
// ===========================================

export const getHandler: AppRouteHandler<typeof r.get> = async (c) => {
	const id = c.req.valid("param").id;

	return c.json(
		{ success: true as const, data: await loadCampaignItem(currentTenantId(c), id) },
		200
	);
};

// ===========================================
// POST /
// ===========================================

/**
 * A named profile has to exist before a campaign can point at it.
 *
 * Checked here rather than left to the foreign key: a 404 naming the profile is
 * usable, and a raw FK violation reaching the client is a 500.
 */
async function assertProfileExists(
	tenantId: TenantId,
	profileId: string | null | undefined
): Promise<void> {
	if (profileId === undefined || profileId === null) {
		return;
	}

	// THE PARENT-OWNERSHIP CHECK, and the reason it is scoped: agentProfileId arrives
	// in the request BODY. Unscoped, a customer could point their campaign at another
	// business's agent profile - the foreign key would accept it (an FK says nothing
	// about tenants), the campaign list would then display that business's name, and
	// the dialer would run a campaign against a persona its owner never configured.
	// Scoped, an id that is not theirs is a 404 that also does not confirm it exists.
	const profile = await db.query.aiAgentProfiles.findFirst({
		where: tenantWhere(aiAgentProfiles, tenantId, eq(aiAgentProfiles.id, profileId)),
	});

	if (profile === undefined) {
		throw notFound("AI agent profili", profileId);
	}
}

/** The defaults a created campaign gets, in one place so create and audit agree. */
const CAMPAIGN_DEFAULTS = {
	kind: "other",
	callWindowStart: "09:00",
	callWindowEnd: "18:00",
	maxAttempts: 2,
	retryDelayMinutes: 60,
	concurrency: 1,
} as const;

export const createHandler: AppRouteHandler<typeof r.create> = async (c) => {
	requireRoles(c, CAN_MANAGE);

	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");

	await assertProfileExists(tenantId, body.agentProfileId);

	const values = {
		kind: body.kind ?? CAMPAIGN_DEFAULTS.kind,
		callWindowStart: body.callWindowStart ?? CAMPAIGN_DEFAULTS.callWindowStart,
		callWindowEnd: body.callWindowEnd ?? CAMPAIGN_DEFAULTS.callWindowEnd,
		maxAttempts: body.maxAttempts ?? CAMPAIGN_DEFAULTS.maxAttempts,
		retryDelayMinutes: body.retryDelayMinutes ?? CAMPAIGN_DEFAULTS.retryDelayMinutes,
		concurrency: body.concurrency ?? CAMPAIGN_DEFAULTS.concurrency,
	};

	const [inserted] = await db
		.insert(callCampaigns)
		.values({
			tenantId,
			name: body.name,
			purpose: body.purpose,
			script: body.script ?? null,
			agentProfileId: body.agentProfileId ?? null,
			createdBy: user.id,
			...values,
		})
		.returning({ id: callCampaigns.id });

	if (inserted === undefined) {
		throw databaseError("Kampaniya saqlanmadi");
	}

	await audit(c, {
		action: "campaign.create",
		entityType: "call_campaign",
		entityId: inserted.id,
		details: {
			name: body.name,
			kind: values.kind,
			purpose: body.purpose,
			window: `${values.callWindowStart}-${values.callWindowEnd}`,
			maxAttempts: values.maxAttempts,
			concurrency: values.concurrency,
		},
	});

	return c.json(
		{ success: true as const, data: await loadCampaignItem(tenantId, inserted.id) },
		201
	);
};

// ===========================================
// PATCH /{id}
// ===========================================

/**
 * Copy only the fields the request actually sent.
 *
 * A PATCH that omits a field must leave it alone, and `null` is a real value for
 * the two nullable ones (clearing the script, unpinning the profile), so the test
 * is `!== undefined` throughout rather than a truthiness check.
 */
function buildCampaignUpdates(body: UpdateBody): Partial<CallCampaignRecord> & { updatedAt: Date } {
	const updates: Partial<CallCampaignRecord> & { updatedAt: Date } = { updatedAt: new Date() };
	const assignable = [
		"name",
		"kind",
		"purpose",
		"script",
		"agentProfileId",
		"callWindowStart",
		"callWindowEnd",
		"maxAttempts",
		"retryDelayMinutes",
		"concurrency",
	] as const;

	for (const field of assignable) {
		const value = body[field];

		if (value !== undefined) {
			// The keys and their types line up one for one with the column names; the cast
			// is what lets one loop stand in for ten identical if-blocks.
			Object.assign(updates, { [field]: value });
		}
	}

	return updates;
}

export const updateHandler: AppRouteHandler<typeof r.update> = async (c) => {
	requireRoles(c, CAN_MANAGE);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");
	const existing = await findCampaign(tenantId, id);

	if (!isEditable(existing.status)) {
		throw invalidOperation(
			"Tugagan yoki bekor qilingan kampaniyani tahrirlab bo'lmaydi — uning natijalari o'sha " +
				"paytdagi maqsad va vaqt oynasi bo'yicha yozilgan. Yangi kampaniya yarating."
		);
	}

	// Checked against the merged values, not against the body: sending only a new
	// start time must not be able to cross an unchanged end time.
	const nextStart = body.callWindowStart ?? existing.callWindowStart;
	const nextEnd = body.callWindowEnd ?? existing.callWindowEnd;

	if (nextStart >= nextEnd) {
		throw businessError("Qo'ng'iroq oynasining boshlanishi tugashidan oldin bo'lishi kerak", [
			{ field: "callWindowEnd", reason: `So'ralgan oyna: ${nextStart}–${nextEnd}` },
		]);
	}

	await assertProfileExists(tenantId, body.agentProfileId);

	const updates = buildCampaignUpdates(body);

	await db
		.update(callCampaigns)
		.set(updates)
		.where(tenantWhere(callCampaigns, tenantId, eq(callCampaigns.id, id)));

	await audit(c, {
		action: "campaign.update",
		entityType: "call_campaign",
		entityId: id,
		details: {
			fields: Object.keys(updates).filter((field) => field !== "updatedAt"),
			status: existing.status,
			// The purpose is what a stranger is told, so a change to it is recorded in
			// full rather than as "purpose changed".
			previousPurpose: body.purpose === undefined ? undefined : existing.purpose,
			purpose: body.purpose,
			window: `${nextStart}–${nextEnd}`,
		},
	});

	return c.json({ success: true as const, data: await loadCampaignItem(tenantId, id) }, 200);
};

// ===========================================
// DELETE /{id}
// ===========================================

export const removeHandler: AppRouteHandler<typeof r.remove> = async (c) => {
	requireRoles(c, CAN_MANAGE);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const existing = await findCampaign(tenantId, id);

	// Only a campaign that never dialled anybody. Anything else is call history: its
	// leads point at `calls` rows with transcripts, recordings and spend, and the
	// campaign is what explains why those calls happened at all.
	if (existing.status !== "draft") {
		throw invalidOperation(
			"Faqat qoralama kampaniyani o'chirish mumkin. Ishga tushgan kampaniya qo'ng'iroqlar " +
				"tarixining bir qismi — uni «bekor qilish» bilan to'xtatasiz, o'chirmaysiz."
		);
	}

	const [leadRows] = await db
		.select({ value: count() })
		.from(campaignLeads)
		.where(tenantWhere(campaignLeads, tenantId, eq(campaignLeads.campaignId, id)));
	const leadCount = Number(leadRows?.value ?? 0);

	// The leads go with it (ON DELETE CASCADE). A draft campaign's leads have never
	// been dialled, so nothing is lost that the audit row does not record.
	await db
		.delete(callCampaigns)
		.where(tenantWhere(callCampaigns, tenantId, eq(callCampaigns.id, id)));

	await audit(c, {
		action: "campaign.delete",
		entityType: "call_campaign",
		entityId: id,
		details: { name: existing.name, purpose: existing.purpose, deletedLeads: leadCount },
	});

	return c.json(
		{
			success: true as const,
			data: { message: `Kampaniya o'chirildi (${leadCount} ta raqam bilan)` },
		},
		200
	);
};

// ===========================================
// POST /{id}/start | /pause | /cancel
// ===========================================

/**
 * The checks that only apply to STARTING, on top of the transition table.
 *
 * A legal transition is not the same as a sensible one: draft -> running is legal
 * for an empty campaign too, and running it would do nothing while looking active.
 * Everything refused here is refused with the reason, in Uzbek, because the person
 * pressing the button is the one who has to fix it.
 */
async function assertStartable(campaign: CallCampaignRecord): Promise<{
	readiness: DialingReadiness;
	warnings: string[];
}> {
	// The campaign ROW's tenant, not the request's. They are equal - findCampaign()
	// proved it - and taking it from the row is what keeps that true if this helper is
	// ever reached another way.
	const counts = await countDialableLeads(campaign.tenantId, campaign.id);
	const pending = counts.internal + counts.external;

	if (pending === 0) {
		throw invalidOperation(
			"Navbatda birorta raqam yo'q — avval ro'yxatni import qiling (yoki hamma raqam allaqachon " +
				"qo'ng'iroq qilingan)."
		);
	}

	const readiness = describeReadiness(counts);

	if (!readiness.canDial) {
		// Every row would fail. Refusing is the only honest answer: the operator has to
		// buy and configure a trunk, and no amount of retrying changes that.
		throw invalidOperation(readiness.warning);
	}

	const warnings: string[] = [];

	if (readiness.warning.length > 0) {
		warnings.push(readiness.warning);
	}

	return { readiness, warnings };
}

async function applyTransition(
	c: Parameters<AppRouteHandler<typeof r.start>>[0],
	action: CampaignAction
): Promise<{ campaign: CampaignItem; readiness: DialingReadiness; warnings: string[] }> {
	requireRoles(c, CAN_MANAGE);

	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const user = c.get("user");
	const existing = await findCampaign(tenantId, id);

	// The transition table first: an illegal move is refused before anything else is
	// even looked at, so "resume a cancelled campaign" never touches the lead table.
	const nextStatus: CampaignStatus = assertTransition(existing.status, action);

	let readiness = describeReadiness({ internal: 0, external: 0 });
	let warnings: string[] = [];

	if (action === "start") {
		const startable = await assertStartable(existing);

		readiness = startable.readiness;
		warnings = startable.warnings;
	}

	const now = new Date();
	const updates: Partial<CallCampaignRecord> & { updatedAt: Date } = {
		status: nextStatus,
		updatedAt: now,
	};

	if (action === "start") {
		// startedAt is the FIRST start, so a resume does not erase when the campaign
		// actually began ringing people.
		updates.startedAt = existing.startedAt ?? now;
		updates.startedBy = existing.startedBy ?? user.id;
		updates.pausedAt = null;
	} else if (action === "pause") {
		updates.pausedAt = now;
	} else {
		updates.endedAt = now;
		updates.endedBy = user.id;
	}

	// Guarded on the status we read: two operators pressing "start" at the same time
	// must not both count as the starter, and a cancel that lands between the read
	// and the write must not be overwritten by a pause.
	const changed = await db
		.update(callCampaigns)
		.set(updates)
		.where(
			tenantWhere(
				callCampaigns,
				tenantId,
				eq(callCampaigns.id, id),
				eq(callCampaigns.status, existing.status)
			)
		)
		.returning({ id: callCampaigns.id });

	if (changed.length === 0) {
		throw invalidOperation(
			"Kampaniya holati shu vaqt ichida o'zgardi — sahifani yangilab, qaytadan urinib ko'ring."
		);
	}

	await audit(c, {
		action: `campaign.${action}`,
		entityType: "call_campaign",
		entityId: id,
		details: {
			name: existing.name,
			from: existing.status,
			to: nextStatus,
			pendingLeads: readiness.hasExternalLeads || readiness.hasInternalLeads ? undefined : 0,
			trunkConfigured: readiness.trunkConfigured,
		},
	});

	return { campaign: await loadCampaignItem(tenantId, id), readiness, warnings };
}

export const startHandler: AppRouteHandler<typeof r.start> = async (c) => {
	const result = await applyTransition(c, "start");
	const timeZone = await resolveTenantTimeZone(currentTenantId(c));
	const window = describeWindow(
		{ start: result.campaign.callWindowStart, end: result.campaign.callWindowEnd },
		timeZone
	);

	// Started outside the window is not an error: the campaign is armed and the
	// dialer will begin when the window opens. But it has to be said, or the operator
	// stares at a running campaign that is not calling anybody.
	const warnings = window.openNow ? result.warnings : [...result.warnings, window.message];

	return c.json(
		{
			success: true as const,
			data: {
				campaign: result.campaign,
				dialing: result.readiness,
				window: { openNow: window.openNow, message: window.message },
				warnings,
			},
		},
		200
	);
};

export const pauseHandler: AppRouteHandler<typeof r.pause> = async (c) => {
	const result = await applyTransition(c, "pause");

	return c.json({ success: true as const, data: result.campaign }, 200);
};

export const cancelHandler: AppRouteHandler<typeof r.cancel> = async (c) => {
	const result = await applyTransition(c, "cancel");

	return c.json({ success: true as const, data: result.campaign }, 200);
};

// ===========================================
// GET /{id}/leads
// ===========================================

export const listLeadsHandler: AppRouteHandler<typeof r.listLeads> = async (c) => {
	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query") as LeadListQuery;

	// The parent first: another tenant's campaign id is a 404 here, so the lead query
	// below is never even reached with an id that is not theirs.
	await findCampaign(tenantId, id);

	// The filters, and DELIBERATELY NOT THE TENANT: it is written out at both
	// statements below rather than folded in here, so the page and its total each
	// carry it and neither can lose it to an edit of a shared variable. Everything in
	// this list narrows - no status / outcome / hasCall / q / page combination can
	// reach past the tenant tenantWhere() puts in front of them.
	const conditions: SQL[] = [eq(campaignLeads.campaignId, id)];

	if (query.status !== undefined) {
		conditions.push(eq(campaignLeads.status, query.status));
	}

	if (query.outcome !== undefined) {
		conditions.push(eq(campaignLeads.outcome, query.outcome));
	}

	if (query.hasCall !== undefined) {
		conditions.push(
			query.hasCall === "true" ? isNotNull(campaignLeads.callId) : isNull(campaignLeads.callId)
		);
	}

	if (query.q !== undefined) {
		const pattern = likePattern(query.q);
		// Digits are stripped from the search term too, so "90 570" finds 998905706507.
		const digits = query.q.replace(/\D/g, "");
		const textMatch = or(
			ilike(campaignLeads.fullName, pattern),
			ilike(campaignLeads.phoneNumber, pattern),
			digits.length > 0 ? ilike(campaignLeads.phoneNumber, `%${digits}%`) : undefined
		);

		if (textMatch !== undefined) {
			conditions.push(textMatch);
		}
	}

	const offset = (query.page - 1) * query.limit;

	const [rows, countRows] = await Promise.all([
		db
			.select()
			.from(campaignLeads)
			.where(tenantWhere(campaignLeads, tenantId, ...conditions))
			// Due first, then the never-tried, then by import order. This is the order the
			// dialer will work through them in, so the page reads as the queue.
			.orderBy(asc(campaignLeads.nextAttemptAt), asc(campaignLeads.createdAt))
			.limit(query.limit)
			.offset(offset),
		db
			.select({ value: count() })
			.from(campaignLeads)
			.where(tenantWhere(campaignLeads, tenantId, ...conditions)),
	]);

	const total = Number(countRows[0]?.value ?? 0);

	return c.json(
		{
			success: true as const,
			data: {
				items: rows.map(toLeadItem),
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
// GET /{id}/leads/{leadId}
// ===========================================

export const getLeadHandler: AppRouteHandler<typeof r.getLead> = async (c) => {
	const { id, leadId } = c.req.valid("param");
	const tenantId = currentTenantId(c);

	const lead = await db.query.campaignLeads.findFirst({
		where: tenantWhere(
			campaignLeads,
			tenantId,
			eq(campaignLeads.id, leadId),
			eq(campaignLeads.campaignId, id)
		),
	});

	if (lead === undefined) {
		throw notFound("Kampaniya ro'yxatidagi yozuv", leadId);
	}

	// Both sides of the join: the attempt rows by tenant, and `calls` on its ON clause
	// as well. Scoping only the attempts would still read a call row of another tenant
	// if an attempt ever pointed at one, and `calls.duration` is call history.
	const attempts = await db
		.select({
			id: campaignCallAttempts.id,
			attemptNo: campaignCallAttempts.attemptNo,
			callId: campaignCallAttempts.callId,
			outcome: campaignCallAttempts.outcome,
			detail: campaignCallAttempts.detail,
			dialedAt: campaignCallAttempts.dialedAt,
			endedAt: campaignCallAttempts.endedAt,
			callDuration: calls.duration,
		})
		.from(campaignCallAttempts)
		.leftJoin(calls, and(eq(campaignCallAttempts.callId, calls.id), eq(calls.tenantId, tenantId)))
		.where(tenantWhere(campaignCallAttempts, tenantId, eq(campaignCallAttempts.leadId, leadId)))
		.orderBy(asc(campaignCallAttempts.attemptNo));

	return c.json(
		{
			success: true as const,
			data: {
				lead: toLeadItem(lead),
				attempts: attempts.map((row) => ({
					id: row.id,
					attemptNo: row.attemptNo,
					callId: row.callId,
					outcome: row.outcome,
					detail: row.detail,
					dialedAt: row.dialedAt.toISOString(),
					endedAt: row.endedAt?.toISOString() ?? null,
					callDuration: row.callDuration,
				})),
			},
		},
		200
	);
};

// ===========================================
// PATCH /{id}/leads/{leadId}
// ===========================================

export const updateLeadHandler: AppRouteHandler<typeof r.updateLead> = async (c) => {
	requireRoles(c, CAN_MANAGE);

	const { id, leadId } = c.req.valid("param");
	const tenantId = currentTenantId(c);
	const body = c.req.valid("json");
	const user = c.get("user");

	const lead = await db.query.campaignLeads.findFirst({
		where: tenantWhere(
			campaignLeads,
			tenantId,
			eq(campaignLeads.id, leadId),
			eq(campaignLeads.campaignId, id)
		),
	});

	if (lead === undefined) {
		throw notFound("Kampaniya ro'yxatidagi yozuv", leadId);
	}

	// A lead in `calling` has a live channel, so its state belongs to the call path.
	// The one exception is a claim old enough to be stuck - a crashed dialer must not
	// leave a row nobody can rescue without SQL.
	const staleBefore = new Date(Date.now() - STALE_CALLING_MINUTES * MS_PER_MINUTE);
	const isStaleClaim =
		lead.status === "calling" && (lead.lastAttemptAt === null || lead.lastAttemptAt < staleBefore);

	if (lead.status === "calling" && !isStaleClaim) {
		throw invalidOperation(
			"Bu raqamga hozir qo'ng'iroq qilinayapti — qo'ng'iroq tugaganidan keyin o'zgartirish mumkin."
		);
	}

	// A manually recorded outcome goes through the same writer the dialer uses, so
	// the lead, the retry plan and the do-not-call list cannot get out of step.
	if (body.outcome !== undefined) {
		const result = await recordDialOutcome({
			// Named, so the writer's own lookup refuses a lead that is not this tenant's
			// rather than trusting the check above to have happened.
			tenantId,
			leadId,
			outcome: body.outcome,
			note: body.note,
			countAttempt: false,
			recordedBy: user.id,
		});

		await audit(c, {
			action: "campaign.lead.outcome",
			entityType: "campaign_lead",
			entityId: leadId,
			details: {
				campaignId: id,
				phoneNumber: lead.phoneNumber,
				outcome: body.outcome,
				manual: true,
				addedToDoNotCall: result.addedToDoNotCall,
				campaignFinished: result.campaignFinished,
			},
		});

		return c.json({ success: true as const, data: toLeadItem(result.lead) }, 200);
	}

	const updates: {
		status?: LeadItem["status"];
		outcome?: CampaignOutcome | null;
		nextAttemptAt?: Date | null;
		note?: string | null;
		updatedAt: Date;
	} = { updatedAt: new Date() };

	if (body.note !== undefined) {
		updates.note = body.note;
	}

	if (body.action === "skip") {
		updates.status = "skipped";
		updates.nextAttemptAt = null;
	}

	if (body.action === "requeue") {
		if (lead.status === "pending") {
			throw invalidOperation("Bu raqam allaqachon navbatda.");
		}

		// The gate is re-checked here rather than trusted from import time: the number
		// may have landed on the do-not-call list since, and requeueing it would be the
		// one place a "never call again" could be undone by accident.
		const gate = await checkDialAllowed(tenantId, lead.phoneNumber);

		if (!gate.allowed) {
			throw invalidOperation(gate.message);
		}

		updates.status = "pending";
		updates.outcome = null;
		updates.nextAttemptAt = null;
	}

	const [updated] = await db
		.update(campaignLeads)
		.set(updates)
		.where(tenantWhere(campaignLeads, tenantId, eq(campaignLeads.id, leadId)))
		.returning();

	if (updated === undefined) {
		throw databaseError("Yozuv yangilanmadi");
	}

	await audit(c, {
		action: "campaign.lead.update",
		entityType: "campaign_lead",
		entityId: leadId,
		details: {
			campaignId: id,
			phoneNumber: lead.phoneNumber,
			leadAction: body.action ?? null,
			previousStatus: lead.status,
			status: updated.status,
			staleClaimRescued: isStaleClaim,
		},
	});

	return c.json({ success: true as const, data: toLeadItem(updated) }, 200);
};

// ===========================================
// GET /{id}/progress
// ===========================================

/** Every outcome key present with a 0, so the UI renders a stable set of rows. */
function emptyOutcomeCounts(): Record<CampaignOutcome, number> {
	const counts = {} as Record<CampaignOutcome, number>;

	for (const outcome of campaignOutcomeEnum.enumValues) {
		counts[outcome] = 0;
	}

	return counts;
}

/** The call ids this campaign is responsible for: every attempt, plus each lead's last call. */
async function campaignCallIds(tenantId: TenantId, campaignId: string): Promise<string[]> {
	const [attemptRows, leadRows] = await Promise.all([
		db
			.select({ callId: campaignCallAttempts.callId })
			.from(campaignCallAttempts)
			.where(
				tenantWhere(
					campaignCallAttempts,
					tenantId,
					eq(campaignCallAttempts.campaignId, campaignId),
					isNotNull(campaignCallAttempts.callId)
				)
			),
		// The lead's own link is included as well, so the spend is right even before the
		// dialer starts writing attempt rows - and a call linked by both is deduped.
		db
			.select({ callId: campaignLeads.callId })
			.from(campaignLeads)
			.where(
				tenantWhere(
					campaignLeads,
					tenantId,
					eq(campaignLeads.campaignId, campaignId),
					isNotNull(campaignLeads.callId)
				)
			),
	]);

	const ids = new Set<string>();

	for (const row of [...attemptRows, ...leadRows]) {
		if (row.callId !== null) {
			ids.add(row.callId);
		}
	}

	return Array.from(ids);
}

interface SpendTotals {
	sessions: number;
	pricedSessions: number;
	unpricedSessions: number;
	callSeconds: number;
	costUsd: number | null;
	costUzs: number | null;
}

/**
 * What this campaign's calls cost, through /ai-costs' own fold.
 *
 * See the file header: the arithmetic and the null-versus-zero discipline are
 * imported, not rewritten, so this page and the cost page cannot disagree.
 */
async function campaignSpend(tenantId: TenantId, callIds: string[]): Promise<SpendTotals> {
	if (callIds.length === 0) {
		return {
			sessions: 0,
			pricedSessions: 0,
			unpricedSessions: 0,
			callSeconds: 0,
			// No sessions at all is genuinely nothing spent, not an unknown.
			costUsd: 0,
			costUzs: 0,
		};
	}

	const loaded = await loadRates(tenantId);
	const rows = await db
		.select({
			provider: aiSessions.provider,
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
			callDuration: calls.duration,
			analysisPromptTokens: aiAnalyses.promptTokens,
			analysisCachedPromptTokens: aiAnalyses.cachedPromptTokens,
			analysisCompletionTokens: aiAnalyses.completionTokens,
			analysisBilledRuns: aiAnalyses.billedRuns,
			analysisStatus: aiAnalyses.status,
		})
		.from(aiSessions)
		// Every leg scoped, the same rule routes/ai-costs applies to the same join: the
		// callIds were collected under this tenant, so an unscoped session read would
		// only leak if a child row carried the wrong tenant - which nothing in the schema
		// prevents, and which is exactly when a money figure must come back empty rather
		// than wrong.
		.innerJoin(calls, and(eq(aiSessions.callId, calls.id), eq(calls.tenantId, tenantId)))
		.leftJoin(
			aiAnalyses,
			and(eq(aiAnalyses.callId, aiSessions.callId), eq(aiAnalyses.tenantId, tenantId))
		)
		.where(tenantWhere(aiSessions, tenantId, inArray(aiSessions.callId, callIds)));

	const acc: Accumulator = createAccumulator();

	for (const row of rows) {
		const tokens: SessionTokens = {
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
		const analysis: AnalysisTokens | null =
			row.analysisBilledRuns === null
				? null
				: {
						promptTokens: row.analysisPromptTokens ?? 0,
						cachedPromptTokens: row.analysisCachedPromptTokens ?? 0,
						completionTokens: row.analysisCompletionTokens ?? 0,
						billedRuns: row.analysisBilledRuns,
					};

		accumulate(acc, row, priceSession(tokens, row.provider, analysis, loaded.rates));
	}

	const costUsd = acc.total.value;

	return {
		sessions: acc.sessions,
		pricedSessions: acc.pricedSessions,
		unpricedSessions: acc.unpricedSessions,
		callSeconds: acc.callSeconds,
		costUsd,
		costUzs: toUzs(costUsd, loaded.rates.usdToUzs),
	};
}

export interface LeadCounts {
	total: number;
	pending: number;
	calling: number;
	done: number;
	failed: number;
	skipped: number;
}

/**
 * A GROUP BY result into a fixed set of counters.
 *
 * Every key starts at 0 rather than being absent, so the page renders the same rows
 * for a campaign nobody has dialled yet as for one halfway through - a missing
 * "failed" line reads as "no failures", which is what it means.
 */
export function foldLeadCounts(
	rows: { status: LeadItem["status"]; value: number | string }[]
): LeadCounts {
	const counts: LeadCounts = { total: 0, pending: 0, calling: 0, done: 0, failed: 0, skipped: 0 };

	for (const row of rows) {
		const value = Number(row.value);

		counts.total += value;
		counts[row.status] = value;
	}

	return counts;
}

export function foldOutcomeCounts(
	rows: { outcome: CampaignOutcome | null; value: number | string }[]
): Record<CampaignOutcome, number> {
	const counts = emptyOutcomeCounts();

	for (const row of rows) {
		if (row.outcome !== null) {
			counts[row.outcome] = Number(row.value);
		}
	}

	return counts;
}

/**
 * Conversations, not sessions.
 *
 * The business question behind cost-per-call is what one REAL conversation cost, so
 * the denominator is the outcomes that only a person can produce. A no-answer opens
 * no AI session and costs nothing, and counting it would quietly halve the figure.
 */
export function countConversations(outcomes: Record<CampaignOutcome, number>): number {
	return (
		outcomes.answered +
		outcomes.agreed +
		outcomes.refused +
		outcomes.wrong_person +
		outcomes.callback_requested +
		outcomes.do_not_call
	);
}

export const progressHandler: AppRouteHandler<typeof r.progress> = async (c) => {
	const id = c.req.valid("param").id;
	const tenantId = currentTenantId(c);
	const user = c.get("user");
	const campaign = await findCampaign(tenantId, id);

	const staleBefore = new Date(Date.now() - STALE_CALLING_MINUTES * MS_PER_MINUTE);

	const [statusRows, outcomeRows, attemptRows, stalledRows] = await Promise.all([
		// Four aggregates, four tenant filters. A GROUP BY count is not safer than a row
		// read - it is the same data summarised, and "480 pending" is a fact about
		// somebody's list.
		db
			.select({ status: campaignLeads.status, value: count() })
			.from(campaignLeads)
			.where(tenantWhere(campaignLeads, tenantId, eq(campaignLeads.campaignId, id)))
			.groupBy(campaignLeads.status),
		db
			.select({ outcome: campaignLeads.outcome, value: count() })
			.from(campaignLeads)
			.where(
				tenantWhere(
					campaignLeads,
					tenantId,
					eq(campaignLeads.campaignId, id),
					isNotNull(campaignLeads.outcome)
				)
			)
			.groupBy(campaignLeads.outcome),
		db
			.select({
				total: count(),
				withCall: sql<number>`count(*) filter (where ${campaignCallAttempts.callId} is not null)`,
			})
			.from(campaignCallAttempts)
			.where(tenantWhere(campaignCallAttempts, tenantId, eq(campaignCallAttempts.campaignId, id))),
		db
			.select({ value: count() })
			.from(campaignLeads)
			.where(
				tenantWhere(
					campaignLeads,
					tenantId,
					eq(campaignLeads.campaignId, id),
					eq(campaignLeads.status, "calling"),
					or(
						isNull(campaignLeads.lastAttemptAt),
						sql`${campaignLeads.lastAttemptAt} < ${staleBefore.toISOString()}`
					)
				)
			),
	]);

	const leadCounts = foldLeadCounts(statusRows);
	const outcomes = foldOutcomeCounts(outcomeRows);
	const timeZone = await resolveTenantTimeZone(tenantId);
	const window = describeWindow(
		{ start: campaign.callWindowStart, end: campaign.callWindowEnd },
		timeZone
	);
	const readiness = describeReadiness(await countDialableLeads(tenantId, id));

	const costVisible = CAN_SEE_COST.includes(user.role);
	const spend = costVisible
		? await campaignSpend(tenantId, await campaignCallIds(tenantId, id))
		: null;
	const conversations = countConversations(outcomes);

	return c.json(
		{
			success: true as const,
			data: {
				campaignId: id,
				status: campaign.status,
				leads: { ...leadCounts, stalledCalling: Number(stalledRows[0]?.value ?? 0) },
				outcomes,
				attempts: {
					total: Number(attemptRows[0]?.total ?? 0),
					withCall: Number(attemptRows[0]?.withCall ?? 0),
				},
				spend: {
					visible: costVisible,
					sessions: spend?.sessions ?? null,
					pricedSessions: spend?.pricedSessions ?? null,
					unpricedSessions: spend?.unpricedSessions ?? null,
					callSeconds: spend?.callSeconds ?? null,
					costUsd: spend?.costUsd ?? null,
					costUzs: spend?.costUzs ?? null,
					costPerAnsweredUsd:
						spend !== null && spend.costUsd !== null && conversations > 0
							? roundMoney(spend.costUsd / conversations)
							: null,
				},
				window: {
					start: campaign.callWindowStart,
					end: campaign.callWindowEnd,
					timeZone: window.timeZone,
					now: window.now,
					openNow: window.openNow,
					minutesUntilOpen: window.minutesUntilOpen,
					message: window.message,
				},
				dialing: readiness,
			},
		},
		200
	);
};
