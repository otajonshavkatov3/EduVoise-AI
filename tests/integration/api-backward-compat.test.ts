/**
 * Regression gate for the CRM that existed before the AI voice layer.
 *
 * Everything here worked in production before Asterisk, AudioSocket, the
 * orchestrator or OpenAI were introduced. If any assertion in this file fails,
 * the AI work broke something that was already shipped, and that is a stop-ship
 * signal regardless of how well the new features behave.
 *
 * Two things are deliberately strict:
 *
 *   - Responses are validated against the very zod schemas the routes publish in
 *     their OpenAPI definitions, not against hand-written "has some keys"
 *     checks. A handler that quietly drops `meta.totalPages` fails here.
 *   - The legacy FreePBX webhooks are exercised end to end, including the
 *     contact matching rules and the fact that they take **no** bearer token.
 *     FreePBX cannot send one, so requiring auth there would silently kill the
 *     existing PBX integration.
 *
 * Transport: a running backend when one is reachable (that is what the task
 * asks for and the only way to test the deployed process), otherwise the same
 * router tree mounted in-process. The assertions are identical either way.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../apps/backend/src/lib";
import routes from "../../apps/backend/src/routes";
import { ListOutSchema as AuditLogsListSchema } from "../../apps/backend/src/routes/audit-logs/audit-logs.schemas";
import { MeResponseSchema } from "../../apps/backend/src/routes/auth/auth.schemas";
import {
	ListOutSchema as CallsListSchema,
	MeStatsOutSchema,
} from "../../apps/backend/src/routes/calls/calls.schemas";
import { ListOutSchema as ContactsListSchema } from "../../apps/backend/src/routes/contacts/contacts.schemas";
import { DashboardSummarySchema } from "../../apps/backend/src/routes/dashboard/dashboard.schemas";
import { ListOutSchema as OperatorProfilesListSchema } from "../../apps/backend/src/routes/operator-profiles/operator-profiles.schemas";
import { ListOutSchema as TicketsListSchema } from "../../apps/backend/src/routes/tickets/tickets.schemas";
import { ListOutSchema as UsersListSchema } from "../../apps/backend/src/routes/users/users.schemas";
import {
	createInProcessClient,
	createLiveClient,
	isBackendReachable,
	login,
	parseWith,
	resolveBaseUrl,
	SEEDED_SUPERVISOR,
	type TestClient,
	unwrap,
} from "../helpers/api-client";
import {
	createCallViaLegacyWebhook,
	createContact,
	CreatedRows,
	demoWebhookToken,
	uniquePhone,
} from "../helpers/fixtures";

// ===========================================
// Setup
// ===========================================

let client: TestClient;
let token: string;
const created = new CreatedRows();

/**
 * Pre-existing reads that sit behind authMiddleware.
 *
 * /api/dashboard/summary joined this list when its missing authMiddleware was
 * closed; see the dedicated test below for why that was a deliberate product
 * decision rather than a silent behaviour change.
 */
const AUTHENTICATED_ENDPOINTS = [
	"/api/auth/me",
	"/api/users",
	"/api/contacts",
	"/api/calls",
	"/api/tickets",
	"/api/audit-logs",
	"/api/operator-profiles",
	"/api/calls/me/stats",
	"/api/calls/missed",
	"/api/dashboard/summary",
] as const;

/** Every pre-existing read the dashboard depends on. */
const READ_ENDPOINTS = AUTHENTICATED_ENDPOINTS;

beforeAll(async () => {
	const baseUrl = resolveBaseUrl();

	if (await isBackendReachable(baseUrl)) {
		client = createLiveClient(baseUrl);
	} else {
		const app = createApp();
		app.route("/api", routes);
		client = createInProcessClient((path, init) => app.request(path, init));
	}

	// biome-ignore lint/suspicious/noConsole: the transport must be visible in the run log.
	console.info(`[api-backward-compat] transport: ${client.label}`);

	const session = await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password);
	token = session.accessToken;
});

afterAll(async () => {
	await created.cleanup();
});

// ===========================================
// Health and auth
// ===========================================

describe("health", () => {
	test("GET /api/health is public and reports uptime", async () => {
		const response = await client.get("/api/health");

		expect(response.status).toBe(200);

		const body = response.body as { status: string; timestamp: string; uptime: number };

		expect(body.status).toBe("ok");
		expect(Number.isFinite(body.uptime)).toBe(true);
		expect(body.uptime).toBeGreaterThanOrEqual(0);
		expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
	});
});

describe("auth", () => {
	test("the seeded supervisor can log in and gets both tokens", async () => {
		const response = await client.post("/api/auth/login", {
			json: { phone: SEEDED_SUPERVISOR.phone, password: SEEDED_SUPERVISOR.password },
		});

		expect(response.status).toBe(200);

		const data = unwrap<{
			user: { phone: string; role: string; isActive: boolean };
			accessToken: string;
			refreshToken: string;
		}>(response, "POST /api/auth/login");

		expect(data.user.phone).toBe(SEEDED_SUPERVISOR.phone);
		expect(data.user.role).toBe("supervisor");
		expect(data.user.isActive).toBe(true);
		expect(data.accessToken.length).toBeGreaterThan(20);
		expect(data.refreshToken.length).toBeGreaterThan(20);
	});

	test("a wrong password is still rejected with 401 and no token", async () => {
		const response = await client.post("/api/auth/login", {
			json: { phone: SEEDED_SUPERVISOR.phone, password: "definitely-not-the-password" },
		});

		expect(response.status).toBe(401);
		expect(response.text).not.toContain("accessToken");
	});

	test("GET /api/auth/me returns the caller, matching the published schema", async () => {
		const response = await client.get("/api/auth/me", { token });
		const parsed = parseWith(MeResponseSchema, response, "GET /api/auth/me");

		expect(response.status).toBe(200);
		expect(parsed.data.role).toBe("supervisor");
		expect(parsed.data.phone).toBe(SEEDED_SUPERVISOR.phone);
	});
});

// ===========================================
// The protected surface
// ===========================================

describe("authentication is still enforced", () => {
	for (const path of AUTHENTICATED_ENDPOINTS) {
		test(`GET ${path} without a token is 401`, async () => {
			const response = await client.get(path);

			expect(response.status).toBe(401);

			const body = response.body as { success?: boolean } | null;

			expect(body?.success).toBe(false);
		});
	}

	test("a malformed bearer token is 401, not 500", async () => {
		const response = await client.get("/api/contacts", { token: "not-a-jwt" });

		expect(response.status).toBe(401);
	});

	test("GET /api/dashboard/summary now requires a token", async () => {
		// This endpoint used to answer 200 with no Authorization header, which
		// handed business counters to anyone who could reach the port. The
		// product owner took the decision to close it: no frontend code ever
		// called it, so nothing a user relies on changed. The response body is
		// unchanged and still asserted below.
		const response = await client.get("/api/dashboard/summary");

		expect(response.status).toBe(401);
	});
});

describe("every pre-existing endpoint group answers 200", () => {
	for (const path of READ_ENDPOINTS) {
		test(`GET ${path}`, async () => {
			const response = await client.get(path, { token });

			expect(response.status).toBe(200);
			expect((response.body as { success?: boolean } | null)?.success).toBe(true);
		});
	}
});

describe("list endpoints still match their published schemas", () => {
	const cases = [
		{ path: "/api/users", schema: UsersListSchema },
		{ path: "/api/contacts", schema: ContactsListSchema },
		{ path: "/api/calls", schema: CallsListSchema },
		{ path: "/api/calls/missed", schema: CallsListSchema },
		{ path: "/api/tickets", schema: TicketsListSchema },
		{ path: "/api/audit-logs", schema: AuditLogsListSchema },
		{ path: "/api/operator-profiles", schema: OperatorProfilesListSchema },
	] as const;

	for (const { path, schema } of cases) {
		test(`GET ${path}`, async () => {
			const response = await client.get(path, { token });
			const parsed = parseWith(schema, response, `GET ${path}`);

			expect(Array.isArray(parsed.data.items)).toBe(true);
			expect(parsed.data.meta.page).toBe(1);
			expect(parsed.data.meta.limit).toBe(20);
		});
	}

	test("pagination query parameters are still honoured", async () => {
		const response = await client.get("/api/contacts?page=1&limit=3", { token });
		const parsed = parseWith(ContactsListSchema, response, "GET /api/contacts?limit=3");

		expect(parsed.data.meta.limit).toBe(3);
		expect(parsed.data.items.length).toBeLessThanOrEqual(3);
	});

	test("an out-of-range limit is still rejected by validation", async () => {
		const response = await client.get("/api/contacts?limit=5000", { token });

		expect(response.status).toBe(422);
	});
});

describe("aggregate endpoints", () => {
	test("GET /api/dashboard/summary keeps its six counters", async () => {
		const response = await client.get("/api/dashboard/summary", { token });
		const parsed = parseWith(DashboardSummarySchema, response, "GET /api/dashboard/summary");

		expect(parsed.data.totalCalls).toBeGreaterThanOrEqual(0);
		expect(parsed.data.inboundCalls + parsed.data.outboundCalls).toBeLessThanOrEqual(
			parsed.data.totalCalls
		);
	});

	test("GET /api/calls/me/stats keeps its five counters", async () => {
		const response = await client.get("/api/calls/me/stats", { token });
		const parsed = parseWith(MeStatsOutSchema, response, "GET /api/calls/me/stats");

		expect(parsed.data.answeredCalls).toBeGreaterThanOrEqual(0);
		expect(parsed.data.missedCalls).toBeGreaterThanOrEqual(0);
		expect(parsed.data.totalTalkTime).toBeGreaterThanOrEqual(0);
	});
});

// ===========================================
// Legacy FreePBX webhooks
// ===========================================

describe("legacy FreePBX webhooks behave exactly as before", () => {
	test("call-start with an unknown caller creates a ringing call and no contact", async () => {
		const callerNumber = uniquePhone();
		const result = await createCallViaLegacyWebhook(client, {
			direction: "inbound",
			callerNumber,
		});

		created.calls.push(result.id);

		expect(result.success).toBe(true);
		expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.contact).toBeNull();
		expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
		expect(Number.isNaN(Date.parse(result.createdAt))).toBe(false);

		const listed = await client.get(`/api/calls?limit=100`, { token });
		const parsed = parseWith(CallsListSchema, listed, "GET /api/calls");
		const row = parsed.data.items.find((item) => item.id === result.id);

		expect(row).toBeDefined();
		expect(row?.status).toBe("ringing");
		expect(row?.direction).toBe("inbound");
		expect(row?.callerNumber).toBe(callerNumber);
		expect(row?.endedAt).toBeNull();
	});

	test("call-start still matches a known contact and joins its name", async () => {
		const phoneNumber = uniquePhone();
		const contact = await createContact(client, token, {
			phoneNumber,
			firstName: "Legacy",
			lastName: "Caller",
		});

		created.contacts.push(contact.id);

		// FreePBX sends E.164 with a plus; the webhook normalises before matching.
		const result = await createCallViaLegacyWebhook(client, {
			direction: "inbound",
			callerNumber: `+${phoneNumber}`,
		});

		created.calls.push(result.id);

		expect(result.contact).not.toBeNull();
		expect(result.contact?.id).toBe(contact.id);
		expect(result.contact?.contactName).toBe("Legacy Caller");
	});

	test("call-end stores duration, status and recording path", async () => {
		const result = await createCallViaLegacyWebhook(client, {
			direction: "outbound",
			callerNumber: uniquePhone(),
		});

		created.calls.push(result.id);

		const ended = await client.post(`/api/webhooks/freepbx/${await demoWebhookToken()}/call-end`, {
			json: {
				callId: result.id,
				duration: 42,
				status: "completed",
				recordingPath: "/var/spool/asterisk/monitor/legacy-regression.wav",
			},
		});

		expect(ended.status).toBe(200);

		const body = ended.body as { success: boolean; id: string; status: string; endedAt: string };

		expect(body.success).toBe(true);
		expect(body.id).toBe(result.id);
		expect(body.status).toBe("completed");
		expect(Number.isNaN(Date.parse(body.endedAt))).toBe(false);

		const listed = await client.get("/api/calls?limit=100", { token });
		const parsed = parseWith(CallsListSchema, listed, "GET /api/calls");
		const row = parsed.data.items.find((item) => item.id === result.id);

		expect(row?.duration).toBe(42);
		expect(row?.status).toBe("completed");
		expect(row?.recordingPath).toBe("/var/spool/asterisk/monitor/legacy-regression.wav");
	});

	test("call-end for an unknown call is still 404", async () => {
		const response = await client.post(`/api/webhooks/freepbx/${await demoWebhookToken()}/call-end`, {
			json: {
				callId: "00000000-0000-4000-8000-000000000000",
				duration: 1,
				status: "missed",
			},
		});

		expect(response.status).toBe(404);
	});

	test("an invalid call-start payload is still rejected by validation", async () => {
		const response = await client.post(`/api/webhooks/freepbx/${await demoWebhookToken()}/call-start`, { json: {} });

		expect(response.status).toBe(422);
	});

	test("the webhooks require no bearer token - FreePBX cannot send one", async () => {
		// Both requests above went out unauthenticated; this asserts the route is
		// not merely tolerant but genuinely public, by proving a bogus token does
		// not turn into a 401 either.
		const result = await createCallViaLegacyWebhook(client, {
			direction: "inbound",
			callerNumber: uniquePhone(),
		});

		created.calls.push(result.id);

		const withGarbageToken = await client.post(`/api/webhooks/freepbx/${await demoWebhookToken()}/call-end`, {
			token: "not-a-jwt",
			json: { callId: result.id, duration: 0, status: "abandoned" },
		});

		expect(withGarbageToken.status).toBe(200);
	});
});
