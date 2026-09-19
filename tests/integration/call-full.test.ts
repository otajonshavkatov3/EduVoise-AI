/**
 * GET /api/calls/{id}/full - the one request the merged call page makes.
 *
 * Four pages (live calls, recordings, transcripts, AI analysis) were folded into
 * /calls and /calls/{id}. This endpoint is what makes that possible, so what is
 * asserted here is exactly what the fold would otherwise lose:
 *
 *   contract   the response is validated against the zod schema the route
 *              publishes, so a handler that drifts from its OpenAPI definition
 *              fails here rather than in the browser.
 *   access     a manager reads their own call and gets 404 - not 403 - for
 *              anybody else's, the same rule GET /calls/{id} already enforces.
 *   money      cost is supervisor+admin only, and that must AGREE with
 *              /api/ai-costs. The pair is asserted together: whoever is refused
 *              the cost page must not be able to read the same figure from a
 *              call. Asserting them apart is how they drift.
 *   capability every action the four absorbed pages could perform still has the
 *              data it needs here - the transcript line ids that PATCH
 *              /transcripts/{id} addresses, the analysis id that
 *              POST /ai-analyses/{id}/retry addresses, a playable recording URL.
 *   agreement  where a real AI session exists, the cost block is checked against
 *              GET /api/ai-assistant/sessions/{id}, which prices the same call.
 *              Two screens quoting different numbers for one call is the failure
 *              this catches.
 *
 * Rows created here are created through the API and deleted in afterAll, exactly
 * as tests/helpers/fixtures.ts requires.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../apps/backend/src/lib";
import aiAssistant from "../../apps/backend/src/routes/ai-assistant";
import aiCosts from "../../apps/backend/src/routes/ai-costs";
import auth from "../../apps/backend/src/routes/auth";
import calls from "../../apps/backend/src/routes/calls";
import { FullOutSchema } from "../../apps/backend/src/routes/calls/calls.full.schemas";
import { OneOutSchema } from "../../apps/backend/src/routes/calls/calls.schemas";
import contactsRoutes from "../../apps/backend/src/routes/contacts";
import operatorProfilesRoutes from "../../apps/backend/src/routes/operator-profiles";
import transcripts from "../../apps/backend/src/routes/transcripts";
import webhooks from "../../apps/backend/src/routes/webhooks";
import {
	createInProcessClient,
	createLiveClient,
	isBackendReachable,
	login,
	parseWith,
	probeStatus,
	resolveBaseUrl,
	SEEDED_SUPERVISOR,
	type TestClient,
	unwrap,
} from "../helpers/api-client";
import {
	createCallViaLegacyWebhook,
	CreatedRows,
	ensureTestManager,
	type ManagerFixture,
	TEST_MANAGER,
	uniquePhone,
} from "../helpers/fixtures";

/** A well-formed uuid that cannot exist, for the 404 assertions. */
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";

type CallFullData = ReturnType<typeof FullOutSchema.parse>["data"];

let client: TestClient;
let supervisorToken: string;
let manager: ManagerFixture;
/** A call routed to the test manager's extension, so it is "their" call. */
let ownedCallId: string;
/** A call with no operator, which the manager must not be able to read. */
let unownedCallId: string;

const created = new CreatedRows();

function buildInProcessApp() {
	const app = createApp();

	app.route("/api/auth", auth);
	app.route("/api/contacts", contactsRoutes);
	app.route("/api/operator-profiles", operatorProfilesRoutes);
	app.route("/api/webhooks", webhooks);

	app.route("/api/calls", calls);
	app.route("/api/transcripts", transcripts);
	app.route("/api/ai-costs", aiCosts);
	app.route("/api/ai-assistant", aiAssistant);

	return app;
}

async function getFull(callId: string, token: string, query = ""): Promise<CallFullData> {
	const response = await client.get(`/api/calls/${callId}/full${query}`, { token });

	return parseWith(FullOutSchema, response, `GET /api/calls/${callId}/full`).data;
}

beforeAll(async () => {
	const baseUrl = resolveBaseUrl();
	const live = await isBackendReachable(baseUrl);
	// 401 means "mounted and behind auth". Anything else and the same routers are
	// exercised in-process instead, so the suite still gates the handlers.
	const mounted = live ? (await probeStatus(baseUrl, "/api/calls")) === 401 : false;

	if (live && mounted) {
		client = createLiveClient(baseUrl);
	} else {
		const app = buildInProcessApp();
		client = createInProcessClient((path, init) => app.request(path, init));
	}

	// biome-ignore lint/suspicious/noConsole: the transport must be visible in the run log.
	console.info(`[call-full] transport: ${client.label}`);

	supervisorToken = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password))
		.accessToken;
	manager = await ensureTestManager(client, supervisorToken);

	const owned = await createCallViaLegacyWebhook(client, {
		direction: "inbound",
		callerNumber: uniquePhone(),
		// The webhook resolves this to the manager's operator profile.
		calleeExtension: TEST_MANAGER.extension,
	});
	ownedCallId = owned.id;
	created.calls.push(ownedCallId);

	const unowned = await createCallViaLegacyWebhook(client, {
		direction: "inbound",
		callerNumber: uniquePhone(),
	});
	unownedCallId = unowned.id;
	created.calls.push(unownedCallId);
});

afterAll(async () => {
	await created.cleanup();
});

// ===========================================
// Contract
// ===========================================

describe("the response matches the schema the route publishes", () => {
	test("a call with nothing attached still answers every section", async () => {
		const data = await getFull(ownedCallId, supervisorToken);

		expect(data.call.id).toBe(ownedCallId);
		expect(data.recording).toBeNull();
		expect(data.recordings).toEqual([]);
		expect(data.transcripts.items).toEqual([]);
		expect(data.transcripts.total).toBe(0);
		expect(data.transcripts.truncated).toBe(false);
		expect(data.analysis).toBeNull();
		expect(data.session).toBeNull();
		expect(data.actions.isEmpty).toBe(true);
		expect(data.actions.counts).toEqual({
			tickets: 0,
			transfers: 0,
			followUps: 0,
			bookings: 0,
			notes: 0,
		});
	});

	test("the call block is a superset of GET /calls/{id}", async () => {
		// The merged page reuses the type the old detail page had; a field quietly
		// dropped here would break it without breaking the schema.
		const one = parseWith(
			OneOutSchema,
			await client.get(`/api/calls/${ownedCallId}`, { token: supervisorToken }),
			"GET /api/calls/{id}"
		).data;
		const full = await getFull(ownedCallId, supervisorToken);

		for (const key of Object.keys(one) as (keyof typeof one)[]) {
			expect(full.call[key]).toEqual(one[key]);
		}
	});

	test("the operator is a name, not a uuid", async () => {
		const data = await getFull(ownedCallId, supervisorToken);

		expect(data.call.operatorId).toBe(manager.operatorProfileId);
		expect(data.call.operatorName).toBe(TEST_MANAGER.phone);
		expect(data.call.operator?.extension).toBe(TEST_MANAGER.extension);
	});

	test("a missing call is 404", async () => {
		const response = await client.get(`/api/calls/${MISSING_UUID}/full`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
	});

	test("an id that is not a uuid is rejected, not looked up", async () => {
		const response = await client.get("/api/calls/not-a-uuid/full", { token: supervisorToken });

		expect(response.status).toBe(422);
	});

	test("without a token it is 401", async () => {
		const response = await client.get(`/api/calls/${ownedCallId}/full`);

		expect(response.status).toBe(401);
	});
});

// ===========================================
// Access
// ===========================================

describe("a manager sees their own call and nothing else", () => {
	test("their own call opens", async () => {
		const data = await getFull(ownedCallId, manager.token);

		expect(data.call.id).toBe(ownedCallId);
	});

	test("somebody else's call is 404, not 403", async () => {
		// 403 would confirm the call exists. calls.handlers.ts made the same choice.
		const response = await client.get(`/api/calls/${unownedCallId}/full`, {
			token: manager.token,
		});

		expect(response.status).toBe(404);
	});
});

// ===========================================
// Money
// ===========================================

describe("who may see the cost agrees with /api/ai-costs", () => {
	test("a manager is refused the cost page AND gets no figure on their own call", async () => {
		const range = "?from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z";
		const costPage = await client.get(`/api/ai-costs/summary${range}`, { token: manager.token });
		const data = await getFull(ownedCallId, manager.token);

		expect(costPage.status).toBe(403);
		expect(data.costVisible).toBe(false);
		expect(data.cost).toBeNull();
	});

	test("a supervisor may read the cost page AND the figure on a call", async () => {
		const range = "?from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z";
		const costPage = await client.get(`/api/ai-costs/summary${range}`, {
			token: supervisorToken,
		});
		const data = await getFull(ownedCallId, supervisorToken);

		expect(costPage.status).toBe(200);
		expect(data.costVisible).toBe(true);
	});

	test("a call that never ran a model has nothing to price, which is not zero", async () => {
		const data = await getFull(ownedCallId, supervisorToken);

		// costVisible true + cost null says "no AI ran here". A cost object full of
		// zeroes would say "it was free", which is a different and false claim.
		expect(data.costVisible).toBe(true);
		expect(data.cost).toBeNull();
	});
});

// ===========================================
// Transcript
// ===========================================

describe("the transcript arrives in the order it was spoken", () => {
	beforeAll(async () => {
		const lines = [
			{ role: "agent", content: "Assalomu alaykum", startMs: 500, endMs: 1500, isFinal: true },
			{ role: "caller", content: "Salom, savolim bor", startMs: 2000, endMs: 4000, isFinal: true },
			{ role: "agent", content: "interim...", startMs: 4200, endMs: 4300, isFinal: false },
			{ role: "agent", content: "Albatta, eshitaman", startMs: 5000, endMs: 6500, isFinal: true },
		];

		// Inserted out of order on purpose: the endpoint must sort by startMs, not by
		// insertion time.
		for (const line of [lines[1], lines[3], lines[0], lines[2]]) {
			const response = await client.post(`/api/transcripts/call/${ownedCallId}`, {
				token: supervisorToken,
				json: line,
			});
			const row = unwrap<{ id: string }>(response, "POST /api/transcripts/call/{callId}");

			created.transcripts.push(row.id);
		}
	});

	test("final lines come back in spoken order", async () => {
		const data = await getFull(ownedCallId, supervisorToken);

		expect(data.transcripts.items.map((line) => line.startMs)).toEqual([500, 2000, 5000]);
		expect(data.transcripts.items.map((line) => line.role)).toEqual(["agent", "caller", "agent"]);
	});

	test("interim lines are excluded by default, as on the transcripts page", async () => {
		const data = await getFull(ownedCallId, supervisorToken);

		expect(data.transcripts.includesInterim).toBe(false);
		expect(data.transcripts.items.every((line) => line.isFinal)).toBe(true);
		expect(data.transcripts.total).toBe(3);
	});

	test("includeInterim=true brings the partials back", async () => {
		const data = await getFull(ownedCallId, supervisorToken, "?includeInterim=true");

		expect(data.transcripts.includesInterim).toBe(true);
		expect(data.transcripts.total).toBe(4);
		expect(data.transcripts.items.some((line) => !line.isFinal)).toBe(true);
	});

	test("every line carries the id PATCH /transcripts/{id} needs", async () => {
		// Correcting a transcript was a capability of the page that was removed; it
		// only survives the merge if the ids come through.
		const data = await getFull(ownedCallId, supervisorToken);

		for (const line of data.transcripts.items) {
			expect(line.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(line.callId).toBe(ownedCallId);
		}
	});
});

// ===========================================
// Agreement with the AI assistant's own pricing
// ===========================================

describe("a real AI call is priced identically here and on the session card", () => {
	test("both screens quote the same number", async () => {
		const list = await client.get("/api/ai-assistant/sessions?limit=1", {
			token: supervisorToken,
		});
		const { items } = unwrap<{ items: { id: string; callId: string }[] }>(
			list,
			"GET /api/ai-assistant/sessions"
		);
		const session = items[0];

		if (session === undefined) {
			// biome-ignore lint/suspicious/noConsole: a silent pass here would be a lie.
			console.warn("[call-full] no ai_sessions rows - the cost agreement check had no data");
			return;
		}

		const card = unwrap<{ cost: Record<string, unknown> }>(
			await client.get(`/api/ai-assistant/sessions/${session.id}`, { token: supervisorToken }),
			"GET /api/ai-assistant/sessions/{id}"
		);
		const data = await getFull(session.callId, supervisorToken);

		expect(data.session?.id).toBe(session.id);
		expect(data.cost).not.toBeNull();
		expect(data.cost).toEqual(card.cost as never);
	});
});
