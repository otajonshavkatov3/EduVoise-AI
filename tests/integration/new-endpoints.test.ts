/**
 * The AI voice layer's HTTP surface: follow-ups, bookings, transcripts,
 * live calls, Asterisk control and the AI assistant.
 *
 * What is asserted, and why it is asserted this way:
 *
 *   auth      every new route group must sit behind authMiddleware. A single
 *             forgotten `router.use("/*", authMiddleware)` would expose call
 *             transcripts to the internet, so this is checked per group.
 *   RBAC      a `manager` must not be able to change how the AI agent behaves or
 *             to drive Asterisk. Role checks live inside the handlers
 *             (requireRoles), which is easy to forget, so each protected verb is
 *             probed with a manager token.
 *   shapes    responses are validated against the exact zod schemas the routes
 *             publish in their OpenAPI definitions. Drift between handler and
 *             contract fails here rather than in the frontend.
 *   secrets   the Asterisk and AI endpoints handle credentials. Their payloads
 *             are asserted not to contain the ARI/AMI passwords or the OpenAI
 *             key, whatever else changes.
 *
 * Deliberately NOT exercised, because a test must not disturb a running system:
 *
 *   POST /api/asterisk/originate      would ring a real softphone.
 *   POST /api/asterisk/hangup         would drop a real call.
 *   POST /api/asterisk/extensions/sync writes reconciled state into
 *                                     sip_extensions for the whole deployment.
 *   PATCH /api/ai-assistant/config    would switch the live agent's language,
 *                                     voice or on/off state.
 *
 * For each of those, the closest observable thing is tested instead: the 403 a
 * manager gets, and (for the config patch) the 400 a supervisor gets for an
 * empty patch - which proves the route is reachable and validating without
 * mutating anything. The genuinely un-testable parts (audio actually flowing,
 * a transfer connecting) need a live call and are covered by
 * tests/e2e/run-verification.ts plus a manual softphone call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../apps/backend/src/lib";
import { getAmiClient } from "../../apps/backend/src/lib/asterisk";
import aiAssistant from "../../apps/backend/src/routes/ai-assistant";
import {
	AiConfigOutSchema,
	AiStatusOutSchema,
	SessionsOutSchema,
} from "../../apps/backend/src/routes/ai-assistant/ai-assistant.schemas";
import asterisk from "../../apps/backend/src/routes/asterisk";
import {
	AsteriskStatusOutSchema,
	ExtensionsOutSchema,
} from "../../apps/backend/src/routes/asterisk/asterisk.schemas";
import auth from "../../apps/backend/src/routes/auth";
import bookings from "../../apps/backend/src/routes/bookings";
import {
	CalendarOutSchema,
	ListOutSchema as BookingsListSchema,
	OneOutSchema as BookingOneSchema,
} from "../../apps/backend/src/routes/bookings/bookings.schemas";
import contactsRoutes from "../../apps/backend/src/routes/contacts";
import followUps from "../../apps/backend/src/routes/follow-ups";
import {
	ListOutSchema as FollowUpsListSchema,
	OneOutSchema as FollowUpOneSchema,
} from "../../apps/backend/src/routes/follow-ups/follow-ups.schemas";
import liveCalls from "../../apps/backend/src/routes/live-calls";
import { LiveCallsOutSchema } from "../../apps/backend/src/routes/live-calls/live-calls.schemas";
import operatorProfilesRoutes from "../../apps/backend/src/routes/operator-profiles";
import transcripts from "../../apps/backend/src/routes/transcripts";
import {
	ListOutSchema as TranscriptsListSchema,
	OneOutSchema as TranscriptOneSchema,
} from "../../apps/backend/src/routes/transcripts/transcripts.schemas";
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
} from "../helpers/api-client";
import {
	createCallViaLegacyWebhook,
	createContact,
	CreatedRows,
	ensureTestManager,
	type ManagerFixture,
	TEST_MANAGER,
	uniquePhone,
} from "../helpers/fixtures";

// ===========================================
// Fixtures
// ===========================================

/** Any well-formed uuid that cannot exist, for the 404 assertions. */
const MISSING_UUID = "00000000-0000-4000-8000-000000000000";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

let client: TestClient;
let supervisorToken: string;
let manager: ManagerFixture;
/** contacts.id - bookings require one. */
let contactId: string;
/** A call routed to the test manager's extension, so it is "their" call. */
let ownedCallId: string;
/** A call with no operator, which the manager must not be able to read. */
let unownedCallId: string;

const created = new CreatedRows();

/**
 * The wiring src/routes/index.ts is expected to declare. Kept here as data so
 * the in-process app and the live-mount probe cannot drift apart.
 */
const NEW_GROUPS = [
	"/api/follow-ups",
	"/api/bookings",
	"/api/transcripts",
	"/api/live-calls",
	"/api/asterisk",
	"/api/ai-assistant",
] as const;

function buildInProcessApp() {
	const app = createApp();

	// The pre-existing groups the fixtures need...
	app.route("/api/auth", auth);
	app.route("/api/contacts", contactsRoutes);
	app.route("/api/operator-profiles", operatorProfilesRoutes);
	app.route("/api/webhooks", webhooks);

	// ...and the six groups under test, at the paths the lead mounts them on.
	app.route("/api/follow-ups", followUps);
	app.route("/api/bookings", bookings);
	app.route("/api/transcripts", transcripts);
	app.route("/api/live-calls", liveCalls);
	app.route("/api/asterisk", asterisk);
	app.route("/api/ai-assistant", aiAssistant);

	return app;
}

beforeAll(async () => {
	const baseUrl = resolveBaseUrl();
	const live = await isBackendReachable(baseUrl);
	// 401 means "mounted and behind auth"; 404 means routes/index.ts has not been
	// wired yet, in which case the same routers are tested in-process instead.
	const mounted = live ? (await probeStatus(baseUrl, "/api/live-calls")) === 401 : false;

	if (live && mounted) {
		client = createLiveClient(baseUrl);
	} else {
		const app = buildInProcessApp();
		client = createInProcessClient((path, init) => app.request(path, init));

		if (live) {
			// biome-ignore lint/suspicious/noConsole: this is the one thing a reader must not miss.
			console.warn(
				`[new-endpoints] ${baseUrl} is running but does not serve ${NEW_GROUPS.join(", ")} - ` +
					"the routers are being tested in-process. Run tests/e2e/run-verification.ts to " +
					"gate the live wiring in src/routes/index.ts."
			);
		}
	}

	// biome-ignore lint/suspicious/noConsole: the transport must be visible in the run log.
	console.info(`[new-endpoints] transport: ${client.label}`);

	supervisorToken = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password))
		.accessToken;
	manager = await ensureTestManager(client, supervisorToken);

	const contact = await createContact(client, supervisorToken, {
		phoneNumber: uniquePhone(),
		firstName: "Voice",
		lastName: "Fixture",
	});
	contactId = contact.id;
	created.contacts.push(contactId);

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
	// GET /api/asterisk/status opens a shared AMI connection when it runs
	// in-process; without this the socket outlives the suite.
	getAmiClient().close();
});

// ===========================================
// Authentication
// ===========================================

describe("every new route group requires authentication", () => {
	const paths = [
		"/api/follow-ups",
		`/api/follow-ups/${MISSING_UUID}`,
		"/api/bookings",
		"/api/bookings/calendar",
		`/api/transcripts/call/${MISSING_UUID}`,
		"/api/live-calls",
		`/api/live-calls/${MISSING_UUID}`,
		"/api/asterisk/status",
		"/api/asterisk/extensions",
		"/api/ai-assistant/status",
		"/api/ai-assistant/config",
		"/api/ai-assistant/sessions",
	];

	for (const path of paths) {
		test(`GET ${path} without a token is 401`, async () => {
			const response = await client.get(path);

			expect(response.status).toBe(401);
			expect((response.body as { success?: boolean } | null)?.success).toBe(false);
		});
	}

	test("a malformed bearer token is 401, not 500", async () => {
		const response = await client.get("/api/live-calls", { token: "not-a-jwt" });

		expect(response.status).toBe(401);
	});

	test("write verbs are behind auth too", async () => {
		const followUp = await client.post("/api/follow-ups", { json: { title: "no token" } });
		const booking = await client.post("/api/bookings", { json: { contactId, title: "x" } });
		const transcript = await client.post(`/api/transcripts/call/${ownedCallId}`, {
			json: { role: "caller", content: "no token" },
		});

		expect(followUp.status).toBe(401);
		expect(booking.status).toBe(401);
		expect(transcript.status).toBe(401);
	});
});

// ===========================================
// RBAC
// ===========================================

describe("RBAC: a manager cannot drive the AI or Asterisk", () => {
	test("PATCH /api/ai-assistant/config is supervisor-only", async () => {
		const response = await client.patch("/api/ai-assistant/config", {
			token: manager.token,
			json: { enabled: true },
		});

		expect(response.status).toBe(403);
	});

	test("POST /api/asterisk/extensions/sync is supervisor-only", async () => {
		const response = await client.post("/api/asterisk/extensions/sync", {
			token: manager.token,
		});

		expect(response.status).toBe(403);
	});

	test("POST /api/asterisk/originate is refused before Asterisk is contacted", async () => {
		const response = await client.post("/api/asterisk/originate", {
			token: manager.token,
			json: { toNumber: "998901234567", fromExtension: "101" },
		});

		expect(response.status).toBe(403);
	});

	test("POST /api/asterisk/hangup is refused before the call is touched", async () => {
		const response = await client.post("/api/asterisk/hangup", {
			token: manager.token,
			json: { callId: ownedCallId },
		});

		expect(response.status).toBe(403);
	});

	test("a supervisor reaches PATCH /api/ai-assistant/config and it validates", async () => {
		// An empty patch is rejected before anything is applied, so this proves
		// reachability for a supervisor without changing the live agent.
		const response = await client.patch("/api/ai-assistant/config", {
			token: supervisorToken,
			json: {},
		});

		expect(response.status).toBe(400);
		expect(response.status).not.toBe(403);
	});

	test("reading the AI config is allowed for a manager", async () => {
		const response = await client.get("/api/ai-assistant/config", { token: manager.token });

		expect(response.status).toBe(200);
		parseWith(AiConfigOutSchema, response, "GET /api/ai-assistant/config");
	});
});

describe("RBAC: a manager only sees their own rows", () => {
	let unassignedFollowUpId: string;

	test("a follow-up assigned to nobody is invisible to the manager", async () => {
		const response = await client.post("/api/follow-ups", {
			token: supervisorToken,
			json: { title: "Supervisor-only task" },
		});

		expect(response.status).toBe(201);

		const task = parseWith(FollowUpOneSchema, response, "POST /api/follow-ups").data;

		unassignedFollowUpId = task.id;
		created.followUps.push(task.id);

		expect(task.assignedTo).toBeNull();

		const managerList = await client.get("/api/follow-ups?limit=100", { token: manager.token });
		const listed = parseWith(FollowUpsListSchema, managerList, "GET /api/follow-ups (manager)");

		expect(listed.data.items.some((item) => item.id === unassignedFollowUpId)).toBe(false);
	});

	test("reading it by id is 404 for the manager, not 403", async () => {
		// Deliberate: a 403 would confirm the row exists. tickets and calls behave
		// the same way, and the AI routes must not be the odd one out.
		const response = await client.get(`/api/follow-ups/${unassignedFollowUpId}`, {
			token: manager.token,
		});

		expect(response.status).toBe(404);
	});

	test("a manager cannot reassign a task to somebody else", async () => {
		const mine = await client.post("/api/follow-ups", {
			token: manager.token,
			json: { title: "Manager's own task" },
		});

		expect(mine.status).toBe(201);

		const task = parseWith(FollowUpOneSchema, mine, "POST /api/follow-ups (manager)").data;

		created.followUps.push(task.id);
		// A manager may only ever assign to themselves.
		expect(task.assignedTo).toBe(manager.operatorProfileId);

		const reassigned = await client.patch(`/api/follow-ups/${task.id}`, {
			token: manager.token,
			json: { assignedTo: MISSING_UUID },
		});

		expect(reassigned.status).toBe(403);
	});

	test("transcript access follows call ownership", async () => {
		const own = await client.get(`/api/transcripts/call/${ownedCallId}`, { token: manager.token });
		const other = await client.get(`/api/transcripts/call/${unownedCallId}`, {
			token: manager.token,
		});

		expect(own.status).toBe(200);
		expect(other.status).toBe(404);
	});

	test("live calls are scoped for a manager and unscoped for a supervisor", async () => {
		const asManager = await client.get("/api/live-calls", { token: manager.token });
		const asSupervisor = await client.get("/api/live-calls", { token: supervisorToken });

		const managerView = parseWith(LiveCallsOutSchema, asManager, "GET /api/live-calls (manager)");
		const supervisorView = parseWith(
			LiveCallsOutSchema,
			asSupervisor,
			"GET /api/live-calls (supervisor)"
		);

		expect(managerView.data.scopedToOperator).toBe(true);
		expect(supervisorView.data.scopedToOperator).toBe(false);
	});
});

// ===========================================
// Follow-ups
// ===========================================

describe("follow-ups CRUD", () => {
	let taskId: string;

	test("create links the call, contact and assignee", async () => {
		const dueAt = new Date(Date.now() + DAY_MS).toISOString();
		const response = await client.post("/api/follow-ups", {
			token: supervisorToken,
			json: {
				title: "Call the customer back",
				description: "Ask whether the meter was replaced",
				dueAt,
				callId: ownedCallId,
				contactId,
				assignedTo: manager.operatorProfileId,
			},
		});

		expect(response.status).toBe(201);

		const task = parseWith(FollowUpOneSchema, response, "POST /api/follow-ups").data;

		taskId = task.id;
		created.followUps.push(taskId);

		expect(task.status).toBe("open");
		expect(task.createdBySystem).toBe(false);
		expect(task.isOverdue).toBe(false);
		expect(task.dueAt).toBe(dueAt);
		expect(task.callId).toBe(ownedCallId);
		expect(task.contact?.id).toBe(contactId);
		expect(task.assignee?.extension).toBe(TEST_MANAGER.extension);
		expect(task.completedAt).toBeNull();
	});

	test("get by id returns the same row", async () => {
		const response = await client.get(`/api/follow-ups/${taskId}`, { token: supervisorToken });
		const task = parseWith(FollowUpOneSchema, response, "GET /api/follow-ups/{id}").data;

		expect(task.id).toBe(taskId);
		expect(task.title).toBe("Call the customer back");
	});

	test("the assignee sees it in their own list", async () => {
		const response = await client.get("/api/follow-ups?limit=100", { token: manager.token });
		const listed = parseWith(FollowUpsListSchema, response, "GET /api/follow-ups (assignee)");

		expect(listed.data.items.some((item) => item.id === taskId)).toBe(true);
		expect(listed.data.meta.total).toBeGreaterThanOrEqual(1);
	});

	test("filtering by assignedTo works for a supervisor", async () => {
		const response = await client.get(
			`/api/follow-ups?assignedTo=${manager.operatorProfileId}&limit=100`,
			{ token: supervisorToken }
		);
		const listed = parseWith(FollowUpsListSchema, response, "GET /api/follow-ups?assignedTo");

		expect(listed.data.items.length).toBeGreaterThanOrEqual(1);
		for (const item of listed.data.items) {
			expect(item.assignedTo).toBe(manager.operatorProfileId);
		}
	});

	test("open -> in_progress is allowed and leaves completedAt empty", async () => {
		const response = await client.patch(`/api/follow-ups/${taskId}`, {
			token: supervisorToken,
			json: { status: "in_progress" },
		});
		const task = parseWith(FollowUpOneSchema, response, "PATCH /api/follow-ups/{id}").data;

		expect(task.status).toBe("in_progress");
		expect(task.completedAt).toBeNull();
	});

	test("-> done stamps completedAt, and leaving done clears it again", async () => {
		const done = await client.patch(`/api/follow-ups/${taskId}`, {
			token: supervisorToken,
			json: { status: "done" },
		});
		const doneTask = parseWith(FollowUpOneSchema, done, "PATCH status=done").data;

		expect(doneTask.status).toBe("done");
		expect(doneTask.completedAt).not.toBeNull();

		const reopened = await client.patch(`/api/follow-ups/${taskId}`, {
			token: supervisorToken,
			json: { status: "open" },
		});
		const reopenedTask = parseWith(FollowUpOneSchema, reopened, "PATCH status=open").data;

		expect(reopenedTask.status).toBe("open");
		expect(reopenedTask.completedAt).toBeNull();
	});

	test("delete cancels instead of removing the row", async () => {
		const response = await client.del(`/api/follow-ups/${taskId}`, { token: supervisorToken });

		expect(response.status).toBe(200);

		const after = await client.get(`/api/follow-ups/${taskId}`, { token: supervisorToken });
		const task = parseWith(FollowUpOneSchema, after, "GET after cancel").data;

		expect(task.status).toBe("cancelled");
	});

	test("cancelled -> done is refused as a business rule violation", async () => {
		const response = await client.patch(`/api/follow-ups/${taskId}`, {
			token: supervisorToken,
			json: { status: "done" },
		});

		expect(response.status).toBe(422);
		expect((response.body as { error?: { code?: string } } | null)?.error?.code).toBe(
			"BUSINESS_RULE_VIOLATION"
		);
	});

	test("an overdue task is flagged and filterable", async () => {
		const response = await client.post("/api/follow-ups", {
			token: supervisorToken,
			json: {
				title: "Overdue task",
				dueAt: new Date(Date.now() - DAY_MS).toISOString(),
				assignedTo: manager.operatorProfileId,
			},
		});
		const task = parseWith(FollowUpOneSchema, response, "POST overdue follow-up").data;

		created.followUps.push(task.id);

		expect(task.isOverdue).toBe(true);

		const filtered = await client.get("/api/follow-ups?overdue=true&limit=100", {
			token: supervisorToken,
		});
		const listed = parseWith(FollowUpsListSchema, filtered, "GET /api/follow-ups?overdue=true");

		expect(listed.data.items.some((item) => item.id === task.id)).toBe(true);
		for (const item of listed.data.items) {
			expect(item.isOverdue).toBe(true);
		}
	});

	test("an unknown id is 404 and a linked record that does not exist is 404", async () => {
		const missing = await client.get(`/api/follow-ups/${MISSING_UUID}`, {
			token: supervisorToken,
		});
		const badLink = await client.post("/api/follow-ups", {
			token: supervisorToken,
			json: { title: "dangling", callId: MISSING_UUID },
		});

		expect(missing.status).toBe(404);
		expect(badLink.status).toBe(404);
	});
});

// ===========================================
// Bookings
// ===========================================

describe("bookings CRUD", () => {
	let bookingId: string;
	let scheduledAt: string;

	test("create computes endsAt from the duration", async () => {
		// Far enough ahead that a slow run cannot make it "in the past".
		const start = new Date(Date.now() + 3 * DAY_MS);

		start.setUTCSeconds(0, 0);
		scheduledAt = start.toISOString();

		const response = await client.post("/api/bookings", {
			token: supervisorToken,
			json: {
				contactId,
				callId: ownedCallId,
				assignedTo: manager.operatorProfileId,
				title: "Meter inspection",
				notes: "Second floor, ask for the building manager",
				scheduledAt,
				durationMinutes: 45,
				location: "Chilonzor 12-4",
			},
		});

		expect(response.status).toBe(201);

		const booking = parseWith(BookingOneSchema, response, "POST /api/bookings").data;

		bookingId = booking.id;
		created.bookings.push(bookingId);

		expect(booking.status).toBe("scheduled");
		expect(booking.createdBySystem).toBe(false);
		expect(booking.durationMinutes).toBe(45);
		expect(booking.scheduledAt).toBe(scheduledAt);
		expect(Date.parse(booking.endsAt) - Date.parse(booking.scheduledAt)).toBe(45 * MINUTE_MS);
		expect(booking.contact?.id).toBe(contactId);
		expect(booking.assignee?.id).toBe(manager.operatorProfileId);
	});

	test("double-booking the same operator is 409", async () => {
		const overlapping = new Date(Date.parse(scheduledAt) + 15 * MINUTE_MS).toISOString();
		const response = await client.post("/api/bookings", {
			token: supervisorToken,
			json: {
				contactId,
				assignedTo: manager.operatorProfileId,
				title: "Clashing visit",
				scheduledAt: overlapping,
				durationMinutes: 30,
			},
		});

		expect(response.status).toBe(409);
		expect((response.body as { error?: { code?: string } } | null)?.error?.code).toBe("CONFLICT");
	});

	test("a slot after the first booking ends is accepted", async () => {
		const later = new Date(Date.parse(scheduledAt) + 2 * HOUR_MS).toISOString();
		const response = await client.post("/api/bookings", {
			token: supervisorToken,
			json: {
				contactId,
				assignedTo: manager.operatorProfileId,
				title: "Later visit",
				scheduledAt: later,
				durationMinutes: 30,
			},
		});

		expect(response.status).toBe(201);

		const booking = parseWith(BookingOneSchema, response, "POST /api/bookings (later)").data;

		created.bookings.push(booking.id);
	});

	test("a booking in the past is 422", async () => {
		const response = await client.post("/api/bookings", {
			token: supervisorToken,
			json: {
				contactId,
				title: "Yesterday",
				scheduledAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
			},
		});

		expect(response.status).toBe(422);
	});

	test("get and list return the booking", async () => {
		const one = await client.get(`/api/bookings/${bookingId}`, { token: supervisorToken });
		const listed = await client.get(
			`/api/bookings?assignedTo=${manager.operatorProfileId}&limit=100`,
			{ token: supervisorToken }
		);

		expect(parseWith(BookingOneSchema, one, "GET /api/bookings/{id}").data.id).toBe(bookingId);
		expect(
			parseWith(BookingsListSchema, listed, "GET /api/bookings").data.items.some(
				(item) => item.id === bookingId
			)
		).toBe(true);
	});

	test("the calendar groups the booking under its UTC day", async () => {
		const day = scheduledAt.slice(0, 10);
		const response = await client.get(`/api/bookings/calendar?view=month&date=${day}`, {
			token: supervisorToken,
		});
		const calendar = parseWith(CalendarOutSchema, response, "GET /api/bookings/calendar").data;

		expect(calendar.view).toBe("month");
		expect(calendar.total).toBeGreaterThanOrEqual(1);

		const bucket = calendar.days.find((entry) => entry.date === day);

		expect(bucket).toBeDefined();
		expect(bucket?.count).toBe(bucket?.items.length);
		expect(bucket?.items.some((item) => item.id === bookingId)).toBe(true);
	});

	test("rescheduling and confirming both work", async () => {
		const moved = new Date(Date.parse(scheduledAt) + DAY_MS).toISOString();
		const rescheduled = await client.patch(`/api/bookings/${bookingId}`, {
			token: supervisorToken,
			json: { scheduledAt: moved, durationMinutes: 60 },
		});
		const afterMove = parseWith(BookingOneSchema, rescheduled, "PATCH scheduledAt").data;

		expect(afterMove.scheduledAt).toBe(moved);
		expect(Date.parse(afterMove.endsAt) - Date.parse(afterMove.scheduledAt)).toBe(60 * MINUTE_MS);

		const confirmed = await client.patch(`/api/bookings/${bookingId}`, {
			token: supervisorToken,
			json: { status: "confirmed" },
		});

		expect(parseWith(BookingOneSchema, confirmed, "PATCH status").data.status).toBe("confirmed");
	});

	test("delete cancels instead of removing the row", async () => {
		const response = await client.del(`/api/bookings/${bookingId}`, { token: supervisorToken });

		expect(response.status).toBe(200);

		const after = await client.get(`/api/bookings/${bookingId}`, { token: supervisorToken });

		expect(parseWith(BookingOneSchema, after, "GET after cancel").data.status).toBe("cancelled");
	});

	test("a contact that does not exist is 404", async () => {
		const response = await client.post("/api/bookings", {
			token: supervisorToken,
			json: {
				contactId: MISSING_UUID,
				title: "Nobody",
				scheduledAt: new Date(Date.now() + DAY_MS).toISOString(),
			},
		});

		expect(response.status).toBe(404);
	});
});

// ===========================================
// Transcripts
// ===========================================

describe("transcripts: append and read", () => {
	let callerLineId: string;

	test("appending a caller line stores it as final by default", async () => {
		const response = await client.post(`/api/transcripts/call/${ownedCallId}`, {
			token: supervisorToken,
			json: { role: "caller", content: "Gaz hisoblagichi ishlamayapti", startMs: 0, endMs: 1500 },
		});

		expect(response.status).toBe(201);

		const line = parseWith(TranscriptOneSchema, response, "POST /api/transcripts/call/{callId}")
			.data;

		callerLineId = line.id;
		created.transcripts.push(line.id);

		expect(line.callId).toBe(ownedCallId);
		expect(line.role).toBe("caller");
		expect(line.isFinal).toBe(true);
		expect(line.startMs).toBe(0);
		expect(line.endMs).toBe(1500);
	});

	test("appending an agent line and an interim line both work", async () => {
		const agent = await client.post(`/api/transcripts/call/${ownedCallId}`, {
			token: supervisorToken,
			json: {
				role: "agent",
				content: "Tushundim, ustani yuboramiz",
				startMs: 1600,
				endMs: 3200,
				confidence: 92,
			},
		});
		const interim = await client.post(`/api/transcripts/call/${ownedCallId}`, {
			token: supervisorToken,
			json: { role: "caller", content: "rahm...", startMs: 3300, isFinal: false },
		});

		const agentLine = parseWith(TranscriptOneSchema, agent, "POST agent line").data;
		const interimLine = parseWith(TranscriptOneSchema, interim, "POST interim line").data;

		created.transcripts.push(agentLine.id, interimLine.id);

		expect(agentLine.confidence).toBe(92);
		expect(interimLine.isFinal).toBe(false);
	});

	test("the list returns final lines in call order", async () => {
		const response = await client.get(`/api/transcripts/call/${ownedCallId}?limit=100`, {
			token: supervisorToken,
		});
		const listed = parseWith(TranscriptsListSchema, response, "GET transcript").data;

		expect(listed.items).toHaveLength(2);
		expect(listed.items.map((item) => item.role)).toEqual(["caller", "agent"]);
		expect(listed.items[0]?.startMs).toBe(0);
		expect(listed.items.every((item) => item.isFinal)).toBe(true);
		expect(listed.meta.total).toBe(2);
	});

	test("includeInterim, role and search filters all apply", async () => {
		const all = await client.get(
			`/api/transcripts/call/${ownedCallId}?includeInterim=true&limit=100`,
			{ token: supervisorToken }
		);
		const callerOnly = await client.get(
			`/api/transcripts/call/${ownedCallId}?role=caller&limit=100`,
			{ token: supervisorToken }
		);
		const searched = await client.get(
			`/api/transcripts/call/${ownedCallId}?search=hisoblagichi&limit=100`,
			{ token: supervisorToken }
		);

		expect(parseWith(TranscriptsListSchema, all, "GET includeInterim").data.items).toHaveLength(3);
		expect(parseWith(TranscriptsListSchema, callerOnly, "GET role=caller").data.items).toHaveLength(
			1
		);

		const hits = parseWith(TranscriptsListSchema, searched, "GET search").data.items;

		expect(hits).toHaveLength(1);
		expect(hits[0]?.content).toContain("hisoblagichi");
	});

	test("descending order reverses the lines", async () => {
		const response = await client.get(`/api/transcripts/call/${ownedCallId}?order=desc&limit=100`, {
			token: supervisorToken,
		});
		const listed = parseWith(TranscriptsListSchema, response, "GET order=desc").data;

		expect(listed.items.map((item) => item.role)).toEqual(["agent", "caller"]);
	});

	test("the txt export is offset-prefixed plain text", async () => {
		const response = await client.get(`/api/transcripts/call/${ownedCallId}/export?format=txt`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");
		expect(response.text).toContain("[00:00] caller: Gaz hisoblagichi ishlamayapti");
		expect(response.text).toContain("[00:01] agent: Tushundim, ustani yuboramiz");
	});

	test("the csv export starts with the documented header", async () => {
		const response = await client.get(`/api/transcripts/call/${ownedCallId}/export?format=csv`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/csv");
		expect(response.text.split("\n")[0]).toBe(
			"id,role,startMs,endMs,isFinal,confidence,createdAt,content"
		);
	});

	test("a line can be corrected", async () => {
		const response = await client.patch(`/api/transcripts/${callerLineId}`, {
			token: supervisorToken,
			json: { content: "Gaz hisoblagichi buzilgan", confidence: 100 },
		});
		const line = parseWith(TranscriptOneSchema, response, "PATCH /api/transcripts/{id}").data;

		expect(line.id).toBe(callerLineId);
		expect(line.content).toBe("Gaz hisoblagichi buzilgan");
		expect(line.confidence).toBe(100);
	});

	test("endMs before startMs is rejected", async () => {
		const response = await client.post(`/api/transcripts/call/${ownedCallId}`, {
			token: supervisorToken,
			json: { role: "system", content: "reversed", startMs: 5000, endMs: 100 },
		});

		expect(response.status).toBe(400);
	});

	test("appending to an unknown call is 404", async () => {
		const response = await client.post(`/api/transcripts/call/${MISSING_UUID}`, {
			token: supervisorToken,
			json: { role: "system", content: "nowhere" },
		});

		expect(response.status).toBe(404);
	});
});

// ===========================================
// Status endpoints
// ===========================================

describe("GET /api/asterisk/status", () => {
	test("matches its schema and never leaks credentials", async () => {
		const response = await client.get("/api/asterisk/status", { token: supervisorToken });
		const status = parseWith(AsteriskStatusOutSchema, response, "GET /api/asterisk/status").data;

		expect(status.ari.app).toBe(process.env.ASTERISK_ARI_APP ?? "callcenter-ai");
		expect(status.backend.uptimeSeconds).toBeGreaterThanOrEqual(0);
		expect(status.channels.active).toBeGreaterThanOrEqual(0);
		expect(status.aiCalls.active).toBeGreaterThanOrEqual(0);
		expect(typeof status.eventStream.running).toBe("boolean");

		// The ARI url is built from credentials; they must be stripped.
		expect(status.ari.baseUrl).not.toContain("@");
		expect(status.ari.baseUrl).not.toContain(process.env.ASTERISK_ARI_PASSWORD ?? "__unset__");
		expect(response.text).not.toContain(process.env.ASTERISK_ARI_PASSWORD ?? "__unset__");
		expect(response.text).not.toContain(process.env.ASTERISK_AMI_PASSWORD ?? "__unset__");
	});

	test("reports the Asterisk version when ARI answers, and an error when it does not", async () => {
		const response = await client.get("/api/asterisk/status", { token: supervisorToken });
		const status = parseWith(AsteriskStatusOutSchema, response, "GET /api/asterisk/status").data;

		// One of the two must hold - the endpoint is never allowed to claim
		// "reachable" without evidence, nor stay silent about why it is not.
		if (status.reachable) {
			expect(status.ari.ok).toBe(true);
			expect(status.ari.version).not.toBeNull();
			expect(status.ari.error).toBeNull();
			expect(status.ari.uptimeSeconds ?? -1).toBeGreaterThanOrEqual(0);
		} else {
			expect(status.ari.ok).toBe(false);
			expect(status.ari.error).not.toBeNull();
		}
	});
});

describe("GET /api/asterisk/extensions", () => {
	test("returns the sip_extensions rows with AMI state or an explicit AMI error", async () => {
		const response = await client.get("/api/asterisk/extensions", { token: supervisorToken });
		const data = parseWith(ExtensionsOutSchema, response, "GET /api/asterisk/extensions").data;

		expect(data.total).toBe(data.items.length);
		expect(response.text).not.toContain(process.env.ASTERISK_AMI_PASSWORD ?? "__unset__");

		for (const item of data.items) {
			expect(item.extension).toMatch(/^\d{2,10}$/);
		}

		if (data.ami.connected) {
			expect(data.ami.error).toBeNull();
			expect(data.ami.banner).toContain("Asterisk Call Manager");
		} else {
			// "offline" is never faked: no AMI means live state is null.
			expect(data.ami.error).not.toBeNull();
			for (const item of data.items) {
				expect(item.live).toBeNull();
			}
		}
	});
});

describe("GET /api/live-calls", () => {
	test("matches its schema and reports orchestrator state", async () => {
		const response = await client.get("/api/live-calls", { token: supervisorToken });
		const data = parseWith(LiveCallsOutSchema, response, "GET /api/live-calls").data;

		expect(data.total).toBe(data.items.length);
		expect(typeof data.orchestratorRunning).toBe("boolean");

		// A call the database knows about is not a live call: only the
		// orchestrator's in-memory set counts.
		expect(data.items.some((item) => item.callId === ownedCallId)).toBe(false);
	});

	test("a call that is not live is 404", async () => {
		const response = await client.get(`/api/live-calls/${ownedCallId}`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
	});
});

describe("GET /api/ai-assistant/status", () => {
	test("reports a coherent provider verdict without leaking the API key", async () => {
		const response = await client.get("/api/ai-assistant/status", { token: supervisorToken });
		const status = parseWith(AiStatusOutSchema, response, "GET /api/ai-assistant/status").data;

		// Three providers exist now; the endpoint reports whichever one
		// AI_VOICE_PROVIDER selected, which is the whole point of the field.
		expect(["openai-realtime", "gemini-live", "fallback-ivr"]).toContain(status.provider);
		expect(status.detail.length).toBeGreaterThan(0);
		expect(status.model.length).toBeGreaterThan(0);
		expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);

		// The invariant that matters operationally: if a session cannot be opened,
		// the status page must name the fallback, not the AI.
		if (!status.available) {
			expect(status.provider).toBe("fallback-ivr");
		}

		const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();

		expect(status.apiKeyConfigured).toBe(apiKey.length > 0);

		if (apiKey.length > 0) {
			expect(response.text).not.toContain(apiKey);
		}
	}, 40_000);

	test("sessions list matches its schema", async () => {
		const response = await client.get("/api/ai-assistant/sessions?limit=5", {
			token: supervisorToken,
		});
		const data = parseWith(SessionsOutSchema, response, "GET /api/ai-assistant/sessions").data;

		expect(data.meta.limit).toBe(5);
		expect(Array.isArray(data.items)).toBe(true);
	});

	test("an unknown session is 404", async () => {
		const response = await client.get(`/api/ai-assistant/sessions/${MISSING_UUID}`, {
			token: supervisorToken,
		});

		expect(response.status).toBe(404);
	});

	test("the effective config exposes flags, never the key", async () => {
		const response = await client.get("/api/ai-assistant/config", { token: supervisorToken });
		const config = parseWith(AiConfigOutSchema, response, "GET /api/ai-assistant/config").data;
		const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();

		expect(config.knownVoices.length).toBeGreaterThan(0);
		expect(config.knownVoices).toContain(config.voice);
		expect(config.agentExtension.length).toBeGreaterThan(0);
		expect(config.maxCallSeconds).toBeGreaterThan(0);
		expect(config.sources.enabled).toMatch(/^(env|override)$/);

		if (apiKey.length > 0) {
			expect(response.text).not.toContain(apiKey);
		}
	});
});

describe("POST /api/asterisk/transfer", () => {
	test("an unknown call is 404, before any channel is touched", async () => {
		const response = await client.post("/api/asterisk/transfer", {
			token: supervisorToken,
			json: { callId: MISSING_UUID, reason: "verification" },
		});

		expect(response.status).toBe(404);
	});
});
