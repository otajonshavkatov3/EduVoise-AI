/**
 * THE AI LAYER'S TENANT BOUNDARY: the agent, the knowledge base, the campaigns and
 * the cost meter.
 *
 * WHY THIS FILE IS DIFFERENT FROM tenant-boundary.test.ts. That one proves the token
 * carries a tenant and the vendor can enter an account. This one proves the four
 * places where a leak in the AI layer would not merely show a stranger's data on a
 * page - it would make the product say the wrong thing out loud:
 *
 *   the knowledge base   the sentences the agent reads to a caller. A leak here has
 *                        one business quoting another's prices on a recorded line.
 *   the active profile   who the agent says it IS. Activating a profile used to
 *                        deactivate every other row on the platform, because the
 *                        "one active profile" index was global.
 *   the do-not-call list a person who said "never call me again". One customer's
 *                        refusal is not another's, and a shared list also reveals
 *                        which numbers the other customer holds.
 *   the cost meter       the vendor's own margin per customer. An aggregate that
 *                        crosses tenants is a wrong invoice.
 *
 * EVERY TEST HERE FAILS ON UNSCOPED CODE. That is the point, and it is why each one
 * either passes a foreign id in (a `profileId` in a query string, a campaign id in
 * a path - the shapes a client actually controls) or asserts on a number that would
 * change the moment a filter went missing. A test that would pass either way is
 * worse than no test: it is a false statement about the thing that ends the
 * business.
 *
 * SAFETY. Every fixture row belongs to the VENDOR tenant, which has no calls, no
 * operators and no campaigns of its own, and every one is deleted in afterAll -
 * children first, because tenancy made these FKs ON DELETE RESTRICT. The demo
 * tenant's rows are read, never written. The one test that could disturb the demo
 * tenant if the code under test were broken (activating a profile) restores its
 * original active profile afterwards.
 *
 * The AI session fixture is dated MARCH 2019 on purpose: the cost assertions then
 * read a window in which the demo tenant provably has nothing, so "0 sessions" is a
 * statement about scoping and not about whether somebody is on the phone right now.
 */
import { asTenantId, type TenantId } from "@shared/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, gte, inArray, lte } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import {
	aiAgentProfiles,
	aiSessions,
	callCampaigns,
	calls,
	campaignLeads,
	doNotCallList,
	knowledgeBaseEntries,
} from "../../apps/backend/src/db/schema";
import {
	activateProfile,
	getActiveAgentProfile,
	getPrimedEntries,
	invalidateAgentProfileCache,
	searchKnowledgeBase,
} from "../../apps/backend/src/lib/ai-agent";
import { findListedNumbers, isDoNotCall } from "../../apps/backend/src/lib/campaigns";
import {
	countCampaignLeads,
	countTenantCalling,
} from "../../apps/backend/src/lib/campaigns/dialer";
import { createApp } from "../../apps/backend/src/lib";
import { getTenantBySlug, getVendorTenantId } from "../../apps/backend/src/lib/tenancy";
import aiCosts from "../../apps/backend/src/routes/ai-costs";
import auth from "../../apps/backend/src/routes/auth";
import campaigns from "../../apps/backend/src/routes/campaigns";
import knowledgeBase from "../../apps/backend/src/routes/knowledge-base";
import {
	createInProcessClient,
	createLiveClient,
	isBackendReachable,
	login,
	resolveBaseUrl,
	SEEDED_SUPERVISOR,
	type TestClient,
} from "../helpers/api-client";

/**
 * A word no real knowledge base contains, so a hit on it can only have come from
 * the fixture. Deliberately not an Uzbek word: the retrieval path weights a token
 * by how RARE it is in the profile being searched, and a nonsense word is rare
 * everywhere.
 */
const FIXTURE_KEYWORD = "zyxqwollaton";

/** Never dialled by anything: 9 is not an Uzbek operator prefix. */
const FIXTURE_PHONE = "998999000111";

/** A model string nothing else could report, for the observed-models assertion. */
const FIXTURE_MODEL = "zyxq-fixture-model-2019";

/**
 * What the two "this must be refused" writes would be called if they were NOT
 * refused. Named constants because afterAll deletes by them - see the comment there.
 */
const STRAY_CAMPAIGN_NAME = "Zyxq campaign that must never be created";
const STRAY_QUESTION = "Zyxq: bu yozuv hech qachon yaratilmasligi kerak";

/**
 * The dialer-count fixture campaign, kept apart from the one above.
 *
 * Its own campaign because an earlier test asserts that the OTHER vendor campaign has
 * exactly zero leads (the "an import cannot write into another tenant's queue"
 * proof), and leads added for these counts would make that assertion pass or fail for
 * the wrong reason.
 */
const DIALER_CAMPAIGN_NAME = "Zyxq dialer count fixture";

/**
 * Every lead of that campaign is an EXTERNAL number and none of them is due.
 *
 * Both properties are safety, not detail. One test below puts the campaign into
 * `running` for a few milliseconds, and a running campaign is what the live dialer's
 * five-second timer looks for - so the rows it would find must be undialable in every
 * configuration: an external number is never claimed while SIP_TRUNK_HOST is empty,
 * and a next_attempt_at a day out is not due even once a trunk exists.
 */
const DIALER_LEAD_PHONES = ["998999000221", "998999000222"] as const;
const DIALER_CALLING_PHONE = "998999000223";
const DAY_MS = 24 * 60 * 60 * 1000;

/** March 2019: before this platform existed, so the demo tenant has nothing there. */
const FIXTURE_CALL_AT = new Date("2019-03-04T09:00:00.000Z");
const COST_RANGE = {
	from: "2019-03-01T00:00:00.000Z",
	to: "2019-03-31T23:59:59.000Z",
} as const;

let client: TestClient;
let supervisorToken: string;
let demoTenantId: TenantId;
let vendorTenantId: TenantId;

/** Fixture ids, all owned by the vendor tenant. */
let vendorProfileId: string;
let vendorEntryId: string;
let vendorCampaignId: string;
let vendorCallId: string;
let vendorSessionId: string;
let vendorDncId: string;

/** The demo tenant's live agent before this suite touched anything. */
let demoActiveProfileIdBefore: string | null = null;

beforeAll(async () => {
	const baseUrl = resolveBaseUrl();

	if (await isBackendReachable(baseUrl)) {
		client = createLiveClient(baseUrl);
	} else {
		// The same assertions against an app composed in this process, so the boundary
		// is verified with no server running.
		const app = createApp();

		app.route("/api/auth", auth);
		app.route("/api/campaigns", campaigns);
		app.route("/api/knowledge-base", knowledgeBase);
		app.route("/api/ai-costs", aiCosts);
		client = createInProcessClient((path, init) => app.request(path, init));
	}

	console.log(`AI tenant boundary suite transport: ${client.label}`);

	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	demoTenantId = demo.id;
	vendorTenantId = await getVendorTenantId();

	supervisorToken = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password))
		.accessToken;

	demoActiveProfileIdBefore = (await getActiveAgentProfile(demoTenantId)).id;

	// ---- fixtures, all on the vendor tenant ----
	const [profile] = await db
		.insert(aiAgentProfiles)
		.values({
			tenantId: vendorTenantId,
			businessName: "Zyxq Fixture Clinic",
			// Left inactive here; one test activates it deliberately.
			isActive: false,
		})
		.returning({ id: aiAgentProfiles.id });

	vendorProfileId = profile?.id ?? "";

	const [entry] = await db
		.insert(knowledgeBaseEntries)
		.values({
			tenantId: vendorTenantId,
			agentProfileId: vendorProfileId,
			question: `${FIXTURE_KEYWORD} narxi qancha?`,
			answer: `${FIXTURE_KEYWORD} uchun narx 1 000 000 so'm.`,
			tags: [FIXTURE_KEYWORD],
			isActive: true,
		})
		.returning({ id: knowledgeBaseEntries.id });

	vendorEntryId = entry?.id ?? "";

	const [campaign] = await db
		.insert(callCampaigns)
		.values({
			tenantId: vendorTenantId,
			name: "Zyxq fixture campaign",
			purpose: "Tenant boundary fixture - never dialled",
		})
		.returning({ id: callCampaigns.id });

	vendorCampaignId = campaign?.id ?? "";

	const [dnc] = await db
		.insert(doNotCallList)
		.values({
			tenantId: vendorTenantId,
			phoneNumber: FIXTURE_PHONE,
			reason: "tenant boundary fixture",
			source: "manual",
		})
		.returning({ id: doNotCallList.id });

	vendorDncId = dnc?.id ?? "";

	const [call] = await db
		.insert(calls)
		.values({
			tenantId: vendorTenantId,
			direction: "inbound",
			callerNumber: FIXTURE_PHONE,
			status: "completed",
			duration: 60,
			startedAt: FIXTURE_CALL_AT,
			endedAt: new Date(FIXTURE_CALL_AT.getTime() + 60_000),
		})
		.returning({ id: calls.id });

	vendorCallId = call?.id ?? "";

	const [session] = await db
		.insert(aiSessions)
		.values({
			tenantId: vendorTenantId,
			callId: vendorCallId,
			provider: "gemini",
			model: FIXTURE_MODEL,
			status: "completed",
			// A full token split, so this row is PRICEABLE: an unscoped cost query would
			// report real money for it, which is exactly the failure worth catching.
			promptTokens: 10_000,
			cachedPromptTokens: 4_000,
			cachedAudioTokens: 3_000,
			cachedTextTokens: 1_000,
			inputTextTokens: 2_000,
			inputAudioTokens: 4_000,
			completionTokens: 5_000,
			outputTextTokens: 1_000,
			outputAudioTokens: 4_000,
			responseTurns: 7,
			startedAt: FIXTURE_CALL_AT,
			endedAt: new Date(FIXTURE_CALL_AT.getTime() + 60_000),
			durationMs: 60_000,
		})
		.returning({ id: aiSessions.id });

	vendorSessionId = session?.id ?? "";

	// The caches are per tenant, and the fixtures were written behind their backs.
	invalidateAgentProfileCache();
});

afterAll(async () => {
	// FIRST, the rows a FAILING run would have created. When the scoping this file
	// tests is broken, the write assertions above do not 404 - they succeed, into
	// another tenant. Cleaning up only by fixture id would then leave a campaign and a
	// knowledge entry behind on a red run, which is the run where a stray row is
	// hardest to notice. Both are matched by the text this file wrote.
	// The dialer-count fixture is matched by name here as well as deleted by id in its
	// own block: a process killed mid-suite must not leave a campaign behind, and by
	// name is the only handle that survives losing the variable.
	const strayCampaigns = await db
		.select({ id: callCampaigns.id })
		.from(callCampaigns)
		.where(inArray(callCampaigns.name, [STRAY_CAMPAIGN_NAME, DIALER_CAMPAIGN_NAME]));

	for (const row of strayCampaigns) {
		await db.delete(campaignLeads).where(eq(campaignLeads.campaignId, row.id));
		await db.delete(callCampaigns).where(eq(callCampaigns.id, row.id));
	}

	await db.delete(knowledgeBaseEntries).where(eq(knowledgeBaseEntries.question, STRAY_QUESTION));

	// Children before parents: tenancy made every tenant FK ON DELETE RESTRICT, and
	// these are the app's own FKs on top of that.
	if (vendorSessionId) {
		await db.delete(aiSessions).where(eq(aiSessions.id, vendorSessionId));
	}
	if (vendorCampaignId) {
		await db.delete(campaignLeads).where(eq(campaignLeads.campaignId, vendorCampaignId));
		await db.delete(callCampaigns).where(eq(callCampaigns.id, vendorCampaignId));
	}
	if (vendorCallId) {
		await db.delete(calls).where(eq(calls.id, vendorCallId));
	}
	if (vendorDncId) {
		await db.delete(doNotCallList).where(eq(doNotCallList.id, vendorDncId));
	}
	if (vendorProfileId) {
		await db
			.delete(knowledgeBaseEntries)
			.where(eq(knowledgeBaseEntries.agentProfileId, vendorProfileId));
		await db.delete(aiAgentProfiles).where(eq(aiAgentProfiles.id, vendorProfileId));
	}

	// If the code under test were broken, activating the vendor's profile would have
	// deactivated the demo tenant's live agent. Put it back rather than leaving the
	// demo tenant answering calls as the cautious defaults.
	if (demoActiveProfileIdBefore !== null) {
		const stillActive = await db.query.aiAgentProfiles.findFirst({
			where: and(
				eq(aiAgentProfiles.tenantId, demoTenantId),
				eq(aiAgentProfiles.id, demoActiveProfileIdBefore),
				eq(aiAgentProfiles.isActive, true)
			),
			columns: { id: true },
		});

		if (!stillActive) {
			await activateProfile(demoTenantId, demoActiveProfileIdBefore);
		}
	}

	invalidateAgentProfileCache();
});

describe("the fixtures are real and belong to another tenant", () => {
	test("the two tenants are different and every fixture row exists", async () => {
		// Without this the whole file could pass vacuously.
		expect(demoTenantId).not.toBe(vendorTenantId);
		expect(vendorProfileId).not.toBe("");
		expect(vendorEntryId).not.toBe("");
		expect(vendorCampaignId).not.toBe("");
		expect(vendorSessionId).not.toBe("");

		const session = await db.query.aiSessions.findFirst({
			where: and(
				eq(aiSessions.tenantId, vendorTenantId),
				eq(aiSessions.id, vendorSessionId),
				gte(aiSessions.startedAt, new Date(COST_RANGE.from)),
				lte(aiSessions.startedAt, new Date(COST_RANGE.to))
			),
			columns: { id: true, model: true },
		});

		// The cost assertions below claim the demo tenant sees nothing in this window.
		// This is the proof there IS something in it to be seen.
		expect(session?.model).toBe(FIXTURE_MODEL);
	});
});

describe("the knowledge base is the tenant's own words", () => {
	test("searching another tenant's profile id returns nothing", async () => {
		// The profileId is the id a client supplies (?profileId=, body.profileId), so
		// this is the exact shape of the attack: my tenant, your profile. Scoped, the
		// entries cannot be reached; unscoped, the agent reads a stranger's price out.
		const hits = await searchKnowledgeBase(demoTenantId, vendorProfileId, FIXTURE_KEYWORD);

		expect(hits).toEqual([]);
	});

	test("the same search inside the owning tenant does find it", async () => {
		// Non-vacuous: the entry is findable, so the empty result above is the tenant
		// filter and not a broken fixture or a stemmer that drops the word.
		const hits = await searchKnowledgeBase(vendorTenantId, vendorProfileId, FIXTURE_KEYWORD);

		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.id).toBe(vendorEntryId);
	});

	test("the primed prompt entries of another tenant's profile are not returned", async () => {
		// These go into the system prompt at the top of every call without a tool
		// round-trip, so an unscoped read here is spoken with no further check.
		const primed = await getPrimedEntries(demoTenantId, vendorProfileId);

		expect(primed).toEqual([]);
	});

	test("GET /knowledge-base with another tenant's profileId is 404, not that tenant's entries", async () => {
		const response = await client.get(`/api/knowledge-base?profileId=${vendorProfileId}`, {
			token: supervisorToken,
		});

		// 404 and not 403: a 403 would confirm the profile exists somewhere.
		expect(response.status).toBe(404);
		expect(response.text).not.toContain(FIXTURE_KEYWORD);
	});

	test("GET /knowledge-base/stats with another tenant's profileId is 404", async () => {
		const response = await client.get(`/api/knowledge-base/stats?profileId=${vendorProfileId}`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
	});

	test("GET /knowledge-base/{id} of another tenant's entry is 404", async () => {
		const response = await client.get(`/api/knowledge-base/${vendorEntryId}`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
		expect(response.text).not.toContain(FIXTURE_KEYWORD);
	});

	test("POST /knowledge-base/search against another tenant's profile is 404", async () => {
		const response = await client.post("/api/knowledge-base/search", {
			token: supervisorToken,
			json: { query: FIXTURE_KEYWORD, profileId: vendorProfileId },
		});

		expect(response.status).toBe(404);
	});

	test("POST /knowledge-base cannot hang an entry off another tenant's profile", async () => {
		const response = await client.post("/api/knowledge-base", {
			token: supervisorToken,
			json: {
				profileId: vendorProfileId,
				question: STRAY_QUESTION,
				answer: "Boshqa tenantning profiliga yozib bo'lmaydi",
			},
		});

		// The parent-ownership check: an agentProfileId in the BODY is not evidence of
		// ownership, and the FK would happily accept it.
		expect(response.status).toBe(404);

		const written = await db
			.select({ id: knowledgeBaseEntries.id })
			.from(knowledgeBaseEntries)
			.where(eq(knowledgeBaseEntries.agentProfileId, vendorProfileId));

		// Still only the fixture: nothing was written into the other tenant's base.
		expect(written.map((row) => row.id)).toEqual([vendorEntryId]);
	});
});

describe("the active agent profile is per tenant", () => {
	test("activating one tenant's profile leaves another tenant's agent answering", async () => {
		await activateProfile(vendorTenantId, vendorProfileId);
		invalidateAgentProfileCache();

		const demoActive = await getActiveAgentProfile(demoTenantId);
		const vendorActive = await getActiveAgentProfile(vendorTenantId);

		// The deactivate half of activateProfile() is the dangerous statement: unscoped,
		// it clears is_active for EVERY customer, and their next caller is answered by
		// the cautious defaults instead of their own business.
		expect(vendorActive.id).toBe(vendorProfileId);
		expect(demoActive.id).toBe(demoActiveProfileIdBefore);
		expect(demoActive.id).not.toBe(vendorProfileId);
		expect(demoActive.businessName).not.toBe("Zyxq Fixture Clinic");
	});
});

describe("the do-not-call list is per tenant", () => {
	test("a number on one tenant's list is not on another's", async () => {
		// Both directions, so the assertion cannot pass because the fixture is missing.
		expect(await isDoNotCall(vendorTenantId, FIXTURE_PHONE)).toBe(true);
		expect(await isDoNotCall(demoTenantId, FIXTURE_PHONE)).toBe(false);
	});

	test("the batched import check does not see another tenant's list", async () => {
		const listedForDemo = await findListedNumbers(demoTenantId, [FIXTURE_PHONE]);
		const listedForOwner = await findListedNumbers(vendorTenantId, [FIXTURE_PHONE]);

		expect(listedForDemo.size).toBe(0);
		expect(listedForOwner.has(FIXTURE_PHONE)).toBe(true);
	});

	test("GET /campaigns/dnc does not list another tenant's refusals", async () => {
		const response = await client.get("/api/campaigns/dnc?page=1&limit=100", {
			token: supervisorToken,
		});

		expect(response.status).toBe(200);
		// A phone number on this list is two facts at once: somebody refused, and the
		// other customer holds that number.
		expect(response.text).not.toContain(FIXTURE_PHONE);
	});
});

describe("campaigns cannot be reached across tenants", () => {
	test("GET /campaigns does not include another tenant's campaign", async () => {
		const response = await client.get("/api/campaigns?page=1&limit=100", {
			token: supervisorToken,
		});

		expect(response.status).toBe(200);
		expect(response.text).not.toContain(vendorCampaignId);
		expect(response.text).not.toContain("Zyxq fixture campaign");
	});

	test("GET /campaigns/{id} of another tenant is 404", async () => {
		const response = await client.get(`/api/campaigns/${vendorCampaignId}`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
	});

	test("GET /campaigns/{id}/leads of another tenant is 404", async () => {
		const response = await client.get(`/api/campaigns/${vendorCampaignId}/leads`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
	});

	test("GET /campaigns/{id}/progress of another tenant is 404, so no count leaks", async () => {
		// Progress is six aggregates and a spend figure. A count is not safer than a
		// row: "480 pending" is a fact about somebody's customer list.
		const response = await client.get(`/api/campaigns/${vendorCampaignId}/progress`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
	});

	test("POST /campaigns/{id}/leads/import cannot write into another tenant's queue", async () => {
		const response = await client.post(`/api/campaigns/${vendorCampaignId}/leads/import`, {
			token: supervisorToken,
			json: { rows: [{ phone: "998901112233", fullName: "Never Imported" }] },
		});

		expect(response.status).toBe(404);

		const leads = await db
			.select({ id: campaignLeads.id })
			.from(campaignLeads)
			.where(eq(campaignLeads.campaignId, vendorCampaignId));

		// The import is the one bulk write in the area, and this is the proof that a
		// campaign id in the PATH cannot aim it at another customer's queue.
		expect(leads).toEqual([]);
	});

	test("POST /campaigns cannot point a campaign at another tenant's agent profile", async () => {
		const response = await client.post("/api/campaigns", {
			token: supervisorToken,
			json: {
				name: STRAY_CAMPAIGN_NAME,
				purpose: "Boshqa tenantning agent profiliga ulanmasligi kerak",
				agentProfileId: vendorProfileId,
			},
		});

		// The FK alone would accept this: a foreign key says nothing about tenants.
		expect(response.status).toBe(404);

		const created = await db
			.select({ id: callCampaigns.id })
			.from(callCampaigns)
			.where(eq(callCampaigns.agentProfileId, vendorProfileId));

		expect(created).toEqual([]);
	});
});

describe("the AI cost meter aggregates per tenant", () => {
	test("GET /ai-costs/summary excludes another tenant's sessions", async () => {
		const response = await client.get(
			`/api/ai-costs/summary?from=${COST_RANGE.from}&to=${COST_RANGE.to}&groupBy=day`,
			{ token: supervisorToken }
		);

		expect(response.status).toBe(200);

		const data = (response.body as { data: { totals: { sessions: number } } }).data;

		// The fixture session sits inside this window and is fully priceable. Nought is
		// the only correct answer for a different customer - and the number is what
		// phase four's per-tenant margin report is built on.
		expect(data.totals.sessions).toBe(0);
		expect(response.text).not.toContain(FIXTURE_MODEL);
	});

	test("GET /ai-costs/calls excludes another tenant's sessions", async () => {
		const response = await client.get(
			`/api/ai-costs/calls?from=${COST_RANGE.from}&to=${COST_RANGE.to}&page=1&limit=50`,
			{ token: supervisorToken }
		);

		expect(response.status).toBe(200);

		const data = (response.body as { data: { meta: { total: number } } }).data;

		expect(data.meta.total).toBe(0);
		expect(response.text).not.toContain(vendorSessionId);
	});

	test("GET /ai-costs/rates reports only models observed on this tenant's own calls", async () => {
		const response = await client.get(
			`/api/ai-costs/rates?from=${COST_RANGE.from}&to=${COST_RANGE.to}`,
			{ token: supervisorToken }
		);

		expect(response.status).toBe(200);

		const data = (response.body as { data: { observedModels: { model: string | null }[] } }).data;

		// "Observed on this account" has to mean this account. A distinct-model list is
		// a small leak that reads as harmless and tells one customer what another runs.
		expect(data.observedModels.map((row) => row.model)).not.toContain(FIXTURE_MODEL);
	});
});

/**
 * THE DIALER'S HAND-WRITTEN SQL - the shape nothing else can check.
 *
 * The dialer is a timer with no request, and three of its statements are raw
 * `db.execute(sql\`...\`)`: the claim, the per-campaign counts and the per-tenant
 * concurrency count. The type checker sees an SQL fragment whatever is inside it, and
 * lib/tenancy's query scanner reads source text and cannot judge a string template -
 * so `tenant_id = $1` in these three is guarded by tests or by nobody. The claim
 * already has one (tests/integration/campaign-dialer.test.ts, "the claim belongs to
 * one tenant"). These are the other two.
 *
 * What each would do unscoped, which is why both are worth a test of their own:
 *
 *   countCampaignLeads   decides how many people a campaign rings this tick. Reading
 *                        another tenant's rows would plan dials against numbers this
 *                        customer does not own.
 *   countTenantCalling   is compared against `outbound.maxConcurrentCalls`, a
 *                        PER-TENANT setting. Counted across the platform, one busy
 *                        customer's live calls silently stop everybody else's
 *                        campaigns - and the number is a fact about their dialling.
 *
 * NOT EXERCISED HERE, and said plainly: countTenantCalling names the tenant on BOTH
 * legs of its join, and only the `campaign_leads` leg is what these assertions move.
 * Proving the `call_campaigns` leg would mean writing a lead whose campaign belongs to
 * a different tenant - a row the schema permits and the application must never create.
 * The second predicate is defence for that corrupt-row case; it is reviewed, not
 * tested.
 */
describe("the dialer's raw SQL counts belong to one tenant", () => {
	let dialerCampaignId = "";

	beforeAll(async () => {
		const [campaign] = await db
			.insert(callCampaigns)
			.values({
				tenantId: vendorTenantId,
				name: DIALER_CAMPAIGN_NAME,
				purpose: "Tenant boundary fixture for the dialer's counts - never dialled",
			})
			.returning({ id: callCampaigns.id });

		dialerCampaignId = campaign?.id ?? "";

		const notDueUntil = new Date(Date.now() + DAY_MS);

		await db.insert(campaignLeads).values([
			...DIALER_LEAD_PHONES.map((phone) => ({
				tenantId: vendorTenantId,
				campaignId: dialerCampaignId,
				phoneNumber: phone,
				status: "pending" as const,
				nextAttemptAt: notDueUntil,
			})),
			{
				tenantId: vendorTenantId,
				campaignId: dialerCampaignId,
				phoneNumber: DIALER_CALLING_PHONE,
				status: "calling" as const,
				// Recent, so the stale-claim reclaim treats it as a live call and leaves it
				// alone, and so countTenantCalling's ten-minute window includes it.
				lastAttemptAt: new Date(),
			},
		]);
	});

	afterAll(async () => {
		if (dialerCampaignId !== "") {
			await db.delete(campaignLeads).where(eq(campaignLeads.campaignId, dialerCampaignId));
			await db.delete(callCampaigns).where(eq(callCampaigns.id, dialerCampaignId));
		}
	});

	test("countCampaignLeads reports another tenant's campaign as empty", async () => {
		const now = new Date();
		const owner = await countCampaignLeads(vendorTenantId, dialerCampaignId, false, now);
		const other = await countCampaignLeads(demoTenantId, dialerCampaignId, false, now);

		// Non-vacuous first: the rows exist and the owner's counts see them.
		expect(owner.openLeads).toBe(3);
		expect(owner.pendingReachable).toBe(2);
		expect(owner.callingInDb).toBe(1);
		// None of them is due, by construction - see DIALER_LEAD_PHONES.
		expect(owner.dueReachable).toBe(0);

		// The same campaign id, asked for by a different customer: every counter zero.
		// Drop `tenant_id = $1` from the statement and all four of these become the
		// owner's numbers, which is a plan to ring somebody else's list.
		expect(other).toEqual({
			openLeads: 0,
			pendingReachable: 0,
			dueReachable: 0,
			callingInDb: 0,
		});
	});

	test("countTenantCalling does not count another tenant's live dials", async () => {
		// Measured before and after rather than asserted as zero: the demo tenant may
		// genuinely have a call up while this suite runs, and a test that only passes on
		// an idle platform is a test nobody trusts at 10am.
		const demoBefore = await countTenantCalling(demoTenantId);

		// The statement only counts leads of a RUNNING campaign, so the fixture has to be
		// running for the assertion to mean anything. Restored in the finally: the window
		// is milliseconds, and every lead in it is undialable regardless.
		await db
			.update(callCampaigns)
			.set({ status: "running", startedAt: new Date() })
			.where(and(eq(callCampaigns.tenantId, vendorTenantId), eq(callCampaigns.id, dialerCampaignId)));

		try {
			expect(await countTenantCalling(vendorTenantId)).toBeGreaterThanOrEqual(1);
			expect(await countTenantCalling(demoTenantId)).toBe(demoBefore);
		} finally {
			await db
				.update(callCampaigns)
				.set({ status: "draft", startedAt: null })
				.where(
					and(eq(callCampaigns.tenantId, vendorTenantId), eq(callCampaigns.id, dialerCampaignId))
				);
		}
	});
});

describe("the tenant id type refuses a value that is not one", () => {
	test("asTenantId rejects a non-uuid without echoing it", () => {
		// The branded type is what makes eq(calls.tenantId, userId) fail to compile; this
		// is its runtime half, and the message must not contain the rejected value.
		expect(() => asTenantId("not-a-uuid")).toThrow();

		try {
			asTenantId("secret-value-1234");
		} catch (error) {
			expect((error as Error).message).not.toContain("secret-value-1234");
		}
	});
});
