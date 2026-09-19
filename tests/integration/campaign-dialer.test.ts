/**
 * The claim: the one statement that stops two ticks ringing the same person.
 *
 * The eligibility rules are pure and are tested in
 * apps/backend/src/lib/campaigns/eligibility.test.ts. What CANNOT be tested
 * without a real Postgres is the thing that actually makes the dialer safe: the
 * `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) AND status =
 * 'pending'` claim. SKIP LOCKED and the re-checked outer predicate are database
 * behaviour, and a unit test with a fake would only assert that the fake was
 * written to match the comment.
 *
 * So this suite runs the real statement against the real database, concurrently,
 * and asserts the four properties the runner depends on:
 *
 *   exclusivity   N parallel claims over M pending leads hand out each lead
 *                 exactly once - never twice, never to two callers.
 *   the budget    a claim never returns more than it was asked for, so the
 *                 concurrency ceiling the plan computed is the ceiling that is
 *                 applied.
 *   the delay     a lead whose next_attempt_at is in the future is not claimed,
 *                 which is what makes "retry in an hour" mean an hour.
 *   reachability  with no SIP trunk an external number is not claimed at all,
 *                 rather than claimed and failed - failing it would spend the
 *                 person's attempts on a condition that has nothing to do with
 *                 them.
 *
 * Everything created here is created through the public API (POST /api/campaigns
 * and its lead import) and deleted in afterAll, per tests/helpers/fixtures.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import { callCampaigns, campaignLeads } from "../../apps/backend/src/db/schema";
import { claimLeads } from "../../apps/backend/src/lib/campaigns";
import { createApp } from "../../apps/backend/src/lib";
import {
	getTenantBySlug,
	getVendorTenantId,
	type TenantId,
} from "../../apps/backend/src/lib/tenancy";
import auth from "../../apps/backend/src/routes/auth";
import campaigns from "../../apps/backend/src/routes/campaigns";
import {
	createInProcessClient,
	login,
	SEEDED_SUPERVISOR,
	type TestClient,
	unwrap,
} from "../helpers/api-client";

/** Extensions only: with SIP_TRUNK_HOST empty these are the numbers this deployment can reach. */
const REACHABLE = ["101", "102", "103", "104", "201"];
/** A mobile number. Unreachable today, and it must stay untouched rather than fail. */
const UNREACHABLE = "998900000771";

let client: TestClient;
let token = "";
let campaignId: string | null = null;
/**
 * The tenant the claim is made for.
 *
 * claimLeads() takes it FIRST and both halves of its statement filter on it - the
 * `FOR UPDATE SKIP LOCKED` sub-query and the outer UPDATE. This suite used to call
 * the pre-tenancy signature, which silently shifted every argument along by one (the
 * campaign uuid arrived as the tenant, the limit as the campaign id) and turned all
 * fifteen claims into a Postgres type error. The whole file was red, which is worse
 * than absent: the claim is the one statement that stops two ticks ringing the same
 * person, and a red suite proves nothing about it either way.
 */
let tenantId: TenantId;

async function createCampaign(): Promise<string> {
	const response = await client.post("/api/campaigns", {
		token,
		json: {
			name: `Dialer claim testi ${Date.now()}`,
			kind: "reminder",
			purpose: "Qo'ng'iroq navbatini olish mexanizmini tekshirish",
			callWindowStart: "07:00",
			callWindowEnd: "22:00",
			maxAttempts: 2,
			retryDelayMinutes: 60,
			concurrency: 5,
		},
	});

	const created = unwrap<{ id: string }>(response, "POST /api/campaigns");

	return created.id;
}

async function importLeads(id: string, numbers: string[]): Promise<void> {
	const response = await client.post(`/api/campaigns/${id}/leads/import`, {
		token,
		json: { rows: numbers.map((phone) => ({ phone })) },
	});

	unwrap(response, "POST /api/campaigns/{id}/leads/import");
}

/** Put every lead of the campaign back to a clean, immediately-due `pending`. */
async function resetLeads(id: string): Promise<void> {
	await db
		.update(campaignLeads)
		.set({ status: "pending", nextAttemptAt: null, lastAttemptAt: null, outcome: null })
		.where(eq(campaignLeads.campaignId, id));
}

beforeAll(async () => {
	const app = createApp();

	app.route("/api/auth", auth);
	app.route("/api/campaigns", campaigns);

	client = createInProcessClient((path, init) => app.request(path, init));
	token = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password)).accessToken;

	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	tenantId = demo.id;
	campaignId = await createCampaign();
	await importLeads(campaignId, [...REACHABLE, UNREACHABLE]);
});

afterAll(async () => {
	if (campaignId !== null) {
		// Leads cascade from the campaign, so one delete removes everything this
		// suite created. The audit_logs rows the API wrote are append-only by design.
		await db.delete(campaignLeads).where(eq(campaignLeads.campaignId, campaignId));
		await db.delete(callCampaigns).where(inArray(callCampaigns.id, [campaignId]));
	}
});

describe("two ticks cannot claim the same lead", () => {
	test("eight parallel claims over five reachable leads hand each out exactly once", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		// Deliberately more claimers than leads, each asking for two: if SKIP LOCKED or
		// the re-checked outer predicate were missing, some lead would come back twice.
		const results = await Promise.all(
			Array.from({ length: 8 }, () => claimLeads(tenantId, id, 2, true))
		);

		const claimed = results.flat().map((lead) => lead.id);
		const unique = new Set(claimed);

		expect(claimed.length).toBe(unique.size);
		expect(unique.size).toBe(REACHABLE.length);

		// And the database agrees: every reachable lead is now claimed, nothing else is.
		const rows = await db
			.select({ id: campaignLeads.id, phoneNumber: campaignLeads.phoneNumber, status: campaignLeads.status })
			.from(campaignLeads)
			.where(eq(campaignLeads.campaignId, id));

		const calling = rows.filter((row) => row.status === "calling");

		expect(calling.length).toBe(REACHABLE.length);
		expect(calling.every((row) => row.phoneNumber !== UNREACHABLE)).toBe(true);
	});

	test("a second claim after the first finds nothing left", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		const first = await claimLeads(tenantId, id, 10, true);
		const second = await claimLeads(tenantId, id, 10, true);

		expect(first.length).toBe(REACHABLE.length);
		expect(second.length).toBe(0);
	});
});

describe("the claim respects the budget it was given", () => {
	/**
	 * The regression this pins was real and it was measured here.
	 *
	 * Written first as `WHERE id IN (SELECT ... LIMIT 2 FOR UPDATE SKIP LOCKED)`,
	 * this returned all FIVE due leads: `FOR UPDATE` stops Postgres hashing an
	 * uncorrelated `IN` sub-plan, the sub-plan is rescanned once per outer row, and
	 * the LIMIT picks a fresh two rows on each rescan. The ceiling stopped existing
	 * without any error - which on the dial path is the per-campaign concurrency
	 * limit and the AI provider's quota stopping too. Fixed with a materialised
	 * CTE; asserted here so it cannot come back.
	 */
	test("asking for two returns at most two, even with five due", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		const claimed = await claimLeads(tenantId, id, 2, true);

		expect(claimed.length).toBe(2);

		// The other three are untouched, not locked and not half-claimed.
		const rows = await db
			.select({ status: campaignLeads.status })
			.from(campaignLeads)
			.where(eq(campaignLeads.campaignId, id));

		expect(rows.filter((row) => row.status === "pending").length).toBe(
			REACHABLE.length + 1 - 2
		);
	});

	test("every claimer in a concurrent batch is held to its own limit", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		const results = await Promise.all([
			claimLeads(tenantId, id, 2, true),
			claimLeads(tenantId, id, 2, true),
			claimLeads(tenantId, id, 2, true),
		]);

		for (const batch of results) {
			expect(batch.length).toBeLessThanOrEqual(2);
		}

		const total = results.flat();

		expect(total.length).toBe(REACHABLE.length);
		expect(new Set(total.map((lead) => lead.id)).size).toBe(REACHABLE.length);
	});

	test("asking for zero or less claims nothing and does not touch the queue", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		expect(await claimLeads(tenantId, id, 0, true)).toEqual([]);
		expect(await claimLeads(tenantId, id, -3, true)).toEqual([]);

		const [pending] = await db
			.select({ status: campaignLeads.status })
			.from(campaignLeads)
			.where(eq(campaignLeads.campaignId, id))
			.limit(1);

		expect(pending?.status).toBe("pending");
	});
});

describe("the delay between attempts", () => {
	test("a lead whose retry time has not arrived is not claimed", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		const inAnHour = new Date(Date.now() + 60 * 60_000);

		await db
			.update(campaignLeads)
			.set({ nextAttemptAt: inAnHour })
			.where(eq(campaignLeads.campaignId, id));

		expect(await claimLeads(tenantId, id, 10, true)).toEqual([]);

		// The same claim run an hour later does pick them up, so this is a delay and
		// not a permanent exclusion.
		const later = await claimLeads(tenantId, id, 10, true, new Date(Date.now() + 61 * 60_000));

		expect(later.length).toBe(REACHABLE.length);
	});

	test("a lead that has never been tried is due immediately", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		const claimed = await claimLeads(tenantId, id, 10, true);

		expect(claimed.length).toBe(REACHABLE.length);
	});
});

describe("what this deployment cannot reach is left alone", () => {
	test("with no trunk, an external number is never claimed", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		const claimed = await claimLeads(tenantId, id, 50, true);

		expect(claimed.map((lead) => lead.phoneNumber)).not.toContain(UNREACHABLE);

		const [external] = await db
			.select({ status: campaignLeads.status, attempts: campaignLeads.attempts })
			.from(campaignLeads)
			.where(eq(campaignLeads.phoneNumber, UNREACHABLE));

		// Still pending with no attempts spent: the day a trunk is bought, this row is
		// dialled with its full allowance intact.
		expect(external?.status).toBe("pending");
		expect(external?.attempts).toBe(0);
	});

	test("with a trunk configured the same claim takes the external number too", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		const claimed = await claimLeads(tenantId, id, 50, false);

		expect(claimed.map((lead) => lead.phoneNumber)).toContain(UNREACHABLE);
		expect(claimed.length).toBe(REACHABLE.length + 1);
	});
});

describe("the claim carries what the prompt needs", () => {
	test("a claimed lead brings its name, variables and note with it", async () => {
		const id = campaignId as string;

		await resetLeads(id);
		await db
			.update(campaignLeads)
			// Narrowed to THIS campaign, not to the phone number alone. "101" is an
			// extension, tenancy deliberately let two customers both have one, and a test
			// that updates by number would reach into another tenant's queue.
			.set({ fullName: "Anvar", variables: { buyurtma: "AB-12" }, note: "eski mijoz" })
			.where(
				and(
					eq(campaignLeads.tenantId, tenantId),
					eq(campaignLeads.campaignId, id),
					eq(campaignLeads.phoneNumber, REACHABLE[0] as string)
				)
			);

		const claimed = await claimLeads(tenantId, id, 50, true);
		const lead = claimed.find((row) => row.phoneNumber === REACHABLE[0]);

		// Without these the agent would ring somebody and be unable to say why, which
		// is the one thing an outbound call may never do.
		expect(lead?.fullName).toBe("Anvar");
		expect(lead?.variables).toEqual({ buyurtma: "AB-12" });
		expect(lead?.note).toBe("eski mijoz");
	});
});

describe("the claim belongs to one tenant", () => {
	test("another tenant cannot claim this campaign's leads, and the queue is untouched", async () => {
		const id = campaignId as string;

		await resetLeads(id);

		// The dialer takes the tenant from the campaign ROW, so this combination cannot
		// arise from the runner - but the claim is raw SQL, which means neither the type
		// checker nor the query scanner can say anything about its WHERE. The tenant term
		// appears twice in that statement (the sub-query and the outer UPDATE) and this is
		// the only thing that would notice either one going missing.
		const stolen = await claimLeads(await getVendorTenantId(), id, 50, true);

		expect(stolen).toEqual([]);

		// And the leads are still pending: a claim that matched nothing must not have
		// moved anything either, or one wrong tenant would strand a whole queue in
		// `calling` until the ten-minute reclaim swept it up.
		const [pending] = await db
			.select({ value: count() })
			.from(campaignLeads)
			.where(
				and(
					eq(campaignLeads.tenantId, tenantId),
					eq(campaignLeads.campaignId, id),
					eq(campaignLeads.status, "pending")
				)
			);

		expect(Number(pending?.value ?? 0)).toBe(REACHABLE.length + 1);
	});
});
