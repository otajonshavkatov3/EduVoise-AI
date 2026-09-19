/**
 * THE STAFF BOUNDARY, over HTTP: users, operators, the audit trail, settings, login.
 *
 * This is the area a customer touches on day one - they log in and create their
 * operators - so it is the area where a missing tenant filter is discovered by a
 * customer rather than by us. Every test here is written so that REMOVING the scope
 * makes it fail:
 *
 *   - a second tenant with its own supervisor, its own operator, its own audit row
 *     and its own settings row exists for the duration of the suite, so "the list is
 *     empty anyway" can never be why a test passes;
 *   - the neighbour's rows are created LAST, so on `ORDER BY created_at DESC` they
 *     would land on page one of any list that forgot its tenant;
 *   - every 404 assertion is paired with a read of the database afterwards, because
 *     a handler that answers 404 AFTER writing has still written;
 *   - the mirror direction is checked too: the neighbour's supervisor sees their own
 *     row and not the demo tenant's.
 *
 * SAFETY. Everything this suite writes, it creates: one probe tenant (plus one
 * already-suspended probe tenant), their users, one operator profile, one audit row,
 * one settings row, and the rows its own HTTP calls create inside the demo tenant.
 * All of them are removed in afterAll - users cascade to operator profiles and status
 * logs, and audit rows keep a NULL user_id by design. No pre-existing row is written
 * or deleted, and the demo tenant's own data is only ever read.
 */
import { asTenantId, type TenantId } from "@shared/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import { auditLogs, operatorProfiles, tenants, users } from "../../apps/backend/src/db/schema";
import { hashPassword } from "../../apps/backend/src/lib/auth";
import { generateAccessToken, verifyAccessToken } from "../../apps/backend/src/lib/auth/jwt";
import { createApp } from "../../apps/backend/src/lib";
import {
	AI_DIALECTS,
	invalidateSettingsCache,
	resetSetting,
	SETTING_DEFINITIONS,
	setSettings,
} from "../../apps/backend/src/lib/settings";
import { getTenantBySlug, invalidateTenantCache } from "../../apps/backend/src/lib/tenancy";
import auditLogsRoutes from "../../apps/backend/src/routes/audit-logs";
import auth from "../../apps/backend/src/routes/auth";
import operatorProfilesRoutes from "../../apps/backend/src/routes/operator-profiles";
import settingsRoutes from "../../apps/backend/src/routes/settings";
import usersRoutes from "../../apps/backend/src/routes/users";
import {
	createInProcessClient,
	createLiveClient,
	isBackendReachable,
	login,
	resolveBaseUrl,
	SEEDED_SUPERVISOR,
	type TestClient,
	unwrap,
} from "../helpers/api-client";

/** Only changes wording, so a stray value could never break a call. */
const DIALECT_KEY = "ai.dialect" as const;
/** A legal dialect that is NOT the default, so a leak would be visible. */
const NEIGHBOUR_DIALECT = AI_DIALECTS.find(
	(dialect) => dialect !== SETTING_DEFINITIONS[DIALECT_KEY].default
);

const NEIGHBOUR_PASSWORD = "probe12345";
/** Distinctive enough that a leaked row is unmistakable in a failure message. */
const NEIGHBOUR_AUDIT_ACTION = "probe.boundary.marker";

interface UserItem {
	id: string;
	phone: string;
	role: string;
}

interface ProfileItem {
	id: string;
	userId: string;
	extension: string;
	currentStatus: string;
}

interface AuditItem {
	id: string;
	action: string;
	userId: string | null;
}

interface SettingsPayload {
	categories: { category: string; items: { key: string; value: unknown }[] }[];
}

let client: TestClient;
let demoTenantId: TenantId;
let demoToken: string;

/** The neighbour: a real tenant with real staff, alive for the whole suite. */
let neighbourTenantId: TenantId;
let neighbourUserId: string;
let neighbourPhone: string;
let neighbourProfileId: string;
let neighbourExtension: string;
let neighbourToken: string;
let neighbourAuditId: string;

/** A tenant that must not be able to obtain credentials at all. */
let suspendedTenantId: TenantId;
let suspendedPhone: string;

/** Rows created inside the DEMO tenant by this suite's own HTTP calls. */
const createdDemoUserIds: string[] = [];

function uniquePhone(): string {
	// 12 digits after the +, unique per run: users.phone is unique platform-wide.
	const tail = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
	return `+9989${tail}`;
}

async function createProbeTenant(
	label: string,
	status: "trial" | "suspended"
): Promise<{ tenantId: TenantId; userId: string; phone: string }> {
	const [tenant] = await db
		.insert(tenants)
		.values({
			name: `Boundary probe (${label})`,
			slug: `boundary-${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
			status,
		})
		.returning({ id: tenants.id });

	if (!tenant) {
		throw new Error("could not create the probe tenant");
	}

	const phone = uniquePhone();
	const [user] = await db
		.insert(users)
		.values({
			tenantId: tenant.id,
			phone,
			passwordHash: await hashPassword(NEIGHBOUR_PASSWORD),
			// A supervisor, so the mirror-direction tests can call the same endpoints the
			// demo supervisor calls. The most powerful role inside an account is the one
			// worth proving cannot see out of it.
			role: "supervisor",
			isActive: true,
		})
		.returning({ id: users.id });

	if (!user) {
		throw new Error("could not create the probe user");
	}

	return { tenantId: tenant.id, userId: user.id, phone };
}

/** An extension the demo tenant does not use, so a collision proves a missing scope. */
async function pickExtensionUnusedByDemo(): Promise<string> {
	const existing = await db
		.select({ extension: operatorProfiles.extension })
		.from(operatorProfiles)
		.where(eq(operatorProfiles.tenantId, demoTenantId));

	const used = new Set(existing.map((row) => row.extension));

	for (let candidate = 700; candidate < 800; candidate += 1) {
		if (!used.has(String(candidate))) {
			return String(candidate);
		}
	}

	throw new Error("no free extension in the 7xx range to probe with");
}

beforeAll(async () => {
	const baseUrl = resolveBaseUrl();

	if (await isBackendReachable(baseUrl)) {
		client = createLiveClient(baseUrl);
	} else {
		const app = createApp();
		app.route("/api/auth", auth);
		app.route("/api/users", usersRoutes);
		app.route("/api/operator-profiles", operatorProfilesRoutes);
		app.route("/api/audit-logs", auditLogsRoutes);
		app.route("/api/settings", settingsRoutes);
		client = createInProcessClient((path, init) => app.request(path, init));
	}

	console.log(`staff boundary suite transport: ${client.label}`);

	if (NEIGHBOUR_DIALECT === undefined) {
		throw new Error("the dialect registry has only one legal value; this suite needs two");
	}

	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	demoTenantId = demo.id;
	demoToken = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password))
		.accessToken;

	const neighbour = await createProbeTenant("live", "trial");
	neighbourTenantId = neighbour.tenantId;
	neighbourUserId = neighbour.userId;
	neighbourPhone = neighbour.phone;

	neighbourExtension = await pickExtensionUnusedByDemo();

	const [profile] = await db
		.insert(operatorProfiles)
		.values({
			tenantId: neighbourTenantId,
			userId: neighbourUserId,
			extension: neighbourExtension,
		})
		.returning({ id: operatorProfiles.id });

	if (!profile) {
		throw new Error("could not create the probe operator profile");
	}

	neighbourProfileId = profile.id;

	const [audit] = await db
		.insert(auditLogs)
		.values({
			tenantId: neighbourTenantId,
			actorTenantId: neighbourTenantId,
			userId: neighbourUserId,
			action: NEIGHBOUR_AUDIT_ACTION,
		})
		.returning({ id: auditLogs.id });

	if (!audit) {
		throw new Error("could not create the probe audit row");
	}

	neighbourAuditId = audit.id;

	await setSettings(neighbourTenantId, [{ key: DIALECT_KEY, value: NEIGHBOUR_DIALECT }], null);

	const suspended = await createProbeTenant("suspended", "suspended");
	suspendedTenantId = suspended.tenantId;
	suspendedPhone = suspended.phone;

	neighbourToken = (await login(client, neighbourPhone, NEIGHBOUR_PASSWORD)).accessToken;
});

afterAll(async () => {
	// Reverse order of creation. Users cascade to operator profiles and status logs;
	// audit rows survive with user_id NULL (ON DELETE SET NULL), which is why the
	// probe tenant's own audit row is deleted explicitly before its tenant row.
	if (createdDemoUserIds.length > 0) {
		await db.delete(users).where(inArray(users.id, createdDemoUserIds));
	}

	if (neighbourTenantId) {
		await resetSetting(neighbourTenantId, DIALECT_KEY);
		await db.delete(users).where(eq(users.tenantId, neighbourTenantId));
		await db.delete(auditLogs).where(eq(auditLogs.tenantId, neighbourTenantId));
		await db.delete(tenants).where(eq(tenants.id, neighbourTenantId));
	}

	if (suspendedTenantId) {
		await db.delete(users).where(eq(users.tenantId, suspendedTenantId));
		await db.delete(auditLogs).where(eq(auditLogs.tenantId, suspendedTenantId));
		await db.delete(tenants).where(eq(tenants.id, suspendedTenantId));
	}

	// This suite briefly made "how many customers are there" answer three. Dropping
	// both caches leaves the process as the next suite expects to find it.
	invalidateSettingsCache();
	invalidateTenantCache();
});

describe("the neighbour exists, so nothing here passes vacuously", () => {
	test("two different tenants, each with a supervisor and a token", async () => {
		expect(neighbourTenantId).not.toBe(demoTenantId);

		const demoPayload = await verifyAccessToken(demoToken);
		const neighbourPayload = await verifyAccessToken(neighbourToken);

		expect(demoPayload.tid).toBe(demoTenantId);
		// THE login claim: a phone that belongs to the neighbour authenticates INTO the
		// neighbour. Nothing in the request said which tenant - the user's row did.
		expect(neighbourPayload.tid).toBe(neighbourTenantId);
		expect(neighbourPayload.tid).not.toBe(demoTenantId);
		// Neither token is an impersonation: no vendor is involved anywhere here.
		expect(demoPayload.act).toBeUndefined();
		expect(neighbourPayload.act).toBeUndefined();
	});
});

describe("GET /api/users is one tenant's staff list", () => {
	test("the demo supervisor does not see the neighbour's user", async () => {
		const data = unwrap<{ items: UserItem[]; meta: { total: number } }>(
			await client.get("/api/users?page=1&limit=100", { token: demoToken }),
			"GET /api/users"
		);

		expect(data.items.some((item) => item.id === neighbourUserId)).toBe(false);
		expect(data.items.some((item) => item.phone === neighbourPhone)).toBe(false);
		// The count is part of the boundary: a total that includes the neighbour leaks
		// how many staff another business has without returning a single row.
		expect(data.meta.total).toBe(data.items.length);
	});

	test("a role filter does not widen the tenant", async () => {
		// The neighbour's user is a supervisor, so this is the filter most likely to
		// reach it if the role condition were applied without the tenant.
		const data = unwrap<{ items: UserItem[] }>(
			await client.get("/api/users?page=1&limit=100&role=supervisor", { token: demoToken }),
			"GET /api/users?role=supervisor"
		);

		expect(data.items.some((item) => item.id === neighbourUserId)).toBe(false);
		expect(data.items.length).toBeGreaterThan(0);
	});

	test("the neighbour's supervisor sees their own user and not the demo tenant's", async () => {
		const data = unwrap<{ items: UserItem[]; meta: { total: number } }>(
			await client.get("/api/users?page=1&limit=100", { token: neighbourToken }),
			"GET /api/users (neighbour)"
		);

		expect(data.items.map((item) => item.id)).toEqual([neighbourUserId]);
		expect(data.meta.total).toBe(1);
		expect(data.text).toBeUndefined();
	});
});

describe("another tenant's user id is a 404, and stays untouched", () => {
	test("GET /api/users/{id}", async () => {
		const response = await client.get(`/api/users/${neighbourUserId}`, { token: demoToken });

		// 404, not 403: a 403 confirms the account exists somewhere.
		expect(response.status).toBe(404);
		expect(response.text).not.toContain(neighbourPhone);
	});

	test("PATCH /api/users/{id} changes nothing", async () => {
		const response = await client.patch(`/api/users/${neighbourUserId}`, {
			token: demoToken,
			json: { username: "taken-over", isActive: false, role: "manager" },
		});

		expect(response.status).toBe(404);

		// A 404 written after the UPDATE would still be a cross-tenant write, so the row
		// itself is the assertion.
		const row = await db.query.users.findFirst({
			where: eq(users.id, neighbourUserId),
			columns: { username: true, isActive: true, role: true, tenantId: true },
		});

		expect(row?.username).toBeNull();
		expect(row?.isActive).toBe(true);
		expect(row?.role).toBe("supervisor");
		expect(row?.tenantId).toBe(neighbourTenantId);
	});

	test("DELETE /api/users/{id} deletes nothing", async () => {
		const response = await client.del(`/api/users/${neighbourUserId}`, { token: demoToken });

		expect(response.status).toBe(404);

		const row = await db.query.users.findFirst({
			where: eq(users.id, neighbourUserId),
			columns: { isDeleted: true, deletedAt: true },
		});

		expect(row?.isDeleted).toBe(false);
		expect(row?.deletedAt).toBeNull();
	});
});

describe("POST /api/auth/register creates staff in the CALLER's tenant", () => {
	test("the new account belongs to the demo tenant, with two tenants in existence", async () => {
		// This is also the regression test for the transitional seam: the handler used to
		// resolve "the only customer there is", which throws once a second tenant exists -
		// and a second tenant exists right now, for the whole of this suite.
		const phone = uniquePhone();
		const created = unwrap<{ user: { id: string; role: string } }>(
			await client.post("/api/auth/register", {
				token: demoToken,
				json: { phone, password: "probe12345" },
			}),
			"POST /api/auth/register"
		);

		createdDemoUserIds.push(created.user.id);

		const row = await db.query.users.findFirst({
			where: eq(users.id, created.user.id),
			columns: { tenantId: true, role: true },
		});

		expect(row?.tenantId).toBe(demoTenantId);
		expect(row?.tenantId).not.toBe(neighbourTenantId);
		expect(row?.role).toBe("manager");
	});

	test("a phone already used by ANOTHER tenant is refused, not duplicated", async () => {
		// users.phone is unique platform-wide because login has no tenant field. The
		// answer must be a clean 409 - never a 500 from the unique index, and never a
		// second row that makes one phone ambiguous at login.
		const response = await client.post("/api/auth/register", {
			token: demoToken,
			json: { phone: neighbourPhone, password: "probe12345" },
		});

		expect(response.status).toBe(409);

		const rows = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.phone, neighbourPhone));

		expect(rows.length).toBe(1);
	});
});

describe("operator profiles: the digits are shared, the operators are not", () => {
	test("GET /api/operator-profiles excludes the neighbour's operator", async () => {
		const data = unwrap<{ items: ProfileItem[]; meta: { total: number } }>(
			await client.get("/api/operator-profiles?page=1&limit=100", { token: demoToken }),
			"GET /api/operator-profiles"
		);

		expect(data.items.some((item) => item.id === neighbourProfileId)).toBe(false);
		expect(data.items.some((item) => item.extension === neighbourExtension)).toBe(false);
		expect(data.meta.total).toBe(data.items.length);
	});

	test("includeDeleted=true widens what is listed, not whose", async () => {
		const data = unwrap<{ items: ProfileItem[] }>(
			await client.get("/api/operator-profiles?page=1&limit=100&includeDeleted=true", {
				token: demoToken,
			}),
			"GET /api/operator-profiles?includeDeleted=true"
		);

		expect(data.items.some((item) => item.id === neighbourProfileId)).toBe(false);
	});

	test("GET /api/operator-profiles/{id} of another tenant is 404", async () => {
		const response = await client.get(`/api/operator-profiles/${neighbourProfileId}`, {
			token: demoToken,
		});

		expect(response.status).toBe(404);
		expect(response.text).not.toContain(neighbourExtension);
	});

	test("PATCH /api/operator-profiles/{id} of another tenant changes nothing", async () => {
		const response = await client.patch(`/api/operator-profiles/${neighbourProfileId}`, {
			token: demoToken,
			json: { status: "busy", extension: "999" },
		});

		expect(response.status).toBe(404);

		const row = await db.query.operatorProfiles.findFirst({
			where: eq(operatorProfiles.id, neighbourProfileId),
			columns: { currentStatus: true, extension: true, isDeleted: true },
		});

		// Status matters more than it looks: an operator forced to "busy" by a stranger
		// stops receiving that business's calls.
		expect(row?.currentStatus).toBe("offline");
		expect(row?.extension).toBe(neighbourExtension);
		expect(row?.isDeleted).toBe(false);
	});

	test("DELETE /api/operator-profiles/{id} of another tenant deletes nothing", async () => {
		const response = await client.del(`/api/operator-profiles/${neighbourProfileId}`, {
			token: demoToken,
		});

		expect(response.status).toBe(404);

		const row = await db.query.operatorProfiles.findFirst({
			where: eq(operatorProfiles.id, neighbourProfileId),
			columns: { isDeleted: true },
		});

		expect(row?.isDeleted).toBe(false);
	});

	test("a userId from another tenant in the BODY is 404, and creates nothing", async () => {
		// The parent-ownership case: the id is client input, and the foreign key alone
		// would happily accept it.
		const response = await client.post("/api/operator-profiles", {
			token: demoToken,
			json: { userId: neighbourUserId, extension: "798" },
		});

		expect(response.status).toBe(404);

		const rows = await db
			.select({ id: operatorProfiles.id })
			.from(operatorProfiles)
			.where(eq(operatorProfiles.userId, neighbourUserId));

		// Still exactly the one the suite created, in the neighbour's tenant.
		expect(rows.map((row) => row.id)).toEqual([neighbourProfileId]);
	});

	test("an extension another tenant already uses is accepted - '101' is an operator code", async () => {
		// Decision #1, proven: the neighbour holds this extension, and the demo tenant
		// must still be able to take it. A platform-wide uniqueness probe would answer
		// 409 here and tell one customer their numbering is owned by a business they
		// cannot see.
		const phone = uniquePhone();
		const registered = unwrap<{ user: { id: string } }>(
			await client.post("/api/auth/register", {
				token: demoToken,
				json: { phone, password: "probe12345" },
			}),
			"POST /api/auth/register (for the extension test)"
		);

		createdDemoUserIds.push(registered.user.id);

		const created = unwrap<ProfileItem>(
			await client.post("/api/operator-profiles", {
				token: demoToken,
				json: { userId: registered.user.id, extension: neighbourExtension },
			}),
			"POST /api/operator-profiles"
		);

		expect(created.extension).toBe(neighbourExtension);

		const row = await db.query.operatorProfiles.findFirst({
			where: eq(operatorProfiles.id, created.id),
			columns: { tenantId: true },
		});

		expect(row?.tenantId).toBe(demoTenantId);

		// And the neighbour's operator on the same digits is untouched.
		const neighbourRow = await db.query.operatorProfiles.findFirst({
			where: eq(operatorProfiles.id, neighbourProfileId),
			columns: { tenantId: true, extension: true },
		});

		expect(neighbourRow?.tenantId).toBe(neighbourTenantId);
		expect(neighbourRow?.extension).toBe(neighbourExtension);
	});
});

describe("the audit trail is per tenant, filters included", () => {
	test("GET /api/audit-logs does not show the neighbour's row", async () => {
		const data = unwrap<{ items: AuditItem[] }>(
			await client.get("/api/audit-logs?page=1&limit=100", { token: demoToken }),
			"GET /api/audit-logs"
		);

		expect(data.items.some((item) => item.id === neighbourAuditId)).toBe(false);
		expect(data.items.some((item) => item.action === NEIGHBOUR_AUDIT_ACTION)).toBe(false);
	});

	test("an action filter cannot reach out of the tenant", async () => {
		// The strongest shape of the leak: the caller names exactly the row they want.
		const response = await client.get(
			`/api/audit-logs?page=1&limit=50&action=${NEIGHBOUR_AUDIT_ACTION}`,
			{ token: demoToken }
		);
		const data = unwrap<{ items: AuditItem[]; meta: { total: number } }>(
			response,
			"GET /api/audit-logs?action=..."
		);

		expect(data.items).toEqual([]);
		expect(data.meta.total).toBe(0);
		expect(response.text).not.toContain(neighbourAuditId);
	});

	test("a userId filter naming another tenant's user returns nothing", async () => {
		const data = unwrap<{ items: AuditItem[]; meta: { total: number } }>(
			await client.get(`/api/audit-logs?page=1&limit=50&userId=${neighbourUserId}`, {
				token: demoToken,
			}),
			"GET /api/audit-logs?userId=..."
		);

		expect(data.items).toEqual([]);
		expect(data.meta.total).toBe(0);
	});

	test("the neighbour's supervisor sees their own row", async () => {
		// The mirror direction, which also proves the row is genuinely there - so the
		// assertions above are about scoping and not about an empty table.
		const data = unwrap<{ items: AuditItem[] }>(
			await client.get(`/api/audit-logs?page=1&limit=50&action=${NEIGHBOUR_AUDIT_ACTION}`, {
				token: neighbourToken,
			}),
			"GET /api/audit-logs (neighbour)"
		);

		expect(data.items.some((item) => item.id === neighbourAuditId)).toBe(true);
	});
});

describe("settings are per tenant over HTTP, cache included", () => {
	function dialectOf(payload: SettingsPayload): unknown {
		for (const group of payload.categories) {
			for (const item of group.items) {
				if (item.key === DIALECT_KEY) {
					return item.value;
				}
			}
		}

		return undefined;
	}

	test("the neighbour's stored value is served to the neighbour only", async () => {
		// Read the DEMO tenant first: with a cache keyed by key alone, the first reader
		// decides what every later reader is told.
		const demoPayload = unwrap<SettingsPayload>(
			await client.get("/api/settings", { token: demoToken }),
			"GET /api/settings (demo)"
		);
		const neighbourPayload = unwrap<SettingsPayload>(
			await client.get("/api/settings", { token: neighbourToken }),
			"GET /api/settings (neighbour)"
		);

		expect(dialectOf(neighbourPayload)).toBe(NEIGHBOUR_DIALECT);
		expect(dialectOf(demoPayload)).not.toBe(NEIGHBOUR_DIALECT);
	});

	test("a write by one tenant does not move another tenant's value", async () => {
		const before = dialectOf(
			unwrap<SettingsPayload>(
				await client.get("/api/settings", { token: demoToken }),
				"GET /api/settings (demo, before)"
			)
		);

		// The neighbour writes its own row through the HTTP layer, mask handling and all.
		const response = await client.patch("/api/settings", {
			token: neighbourToken,
			json: { values: { [DIALECT_KEY]: SETTING_DEFINITIONS[DIALECT_KEY].default } },
		});

		expect(response.status).toBe(200);

		const after = dialectOf(
			unwrap<SettingsPayload>(
				await client.get("/api/settings", { token: demoToken }),
				"GET /api/settings (demo, after)"
			)
		);

		expect(after).toBe(before);

		// Put the neighbour back, so the earlier assertion's fixture is restored for any
		// later run in the same process.
		await setSettings(
			neighbourTenantId,
			[{ key: DIALECT_KEY, value: NEIGHBOUR_DIALECT as string }],
			null
		);
	});
});

describe("the self-service endpoints read the TOKEN's tenant, not just its user id", () => {
	/**
	 * The one class of mistake lib/tenancy cannot catch by types or by the ratchet: a
	 * handler that trusts an id and ignores the tenant. /auth/me, /users/me/profile and
	 * /auth/change-password all look a user up by the id in the token, so a plain
	 * `eq(users.id, ...)` in any of them is perfectly typed, passes the scanner, and
	 * still serves a foreign account.
	 *
	 * So this mints a token whose two halves DISAGREE - the neighbour's user id, the
	 * demo tenant's tid. It is signed with the real key, so the middleware admits it and
	 * the handler decides. With the tenant in the WHERE the answer is 404; without it,
	 * every one of these returns the neighbour's phone, and change-password rotates a
	 * stranger's credential.
	 *
	 * A forged pairing like this is not only theoretical: it is the shape of any future
	 * bug that mints a token from the wrong row - the vendor "enter" flow, an SSO
	 * mapping, a background job that builds a token for a user it looked up elsewhere.
	 */
	let mismatchedToken: string;

	beforeAll(async () => {
		mismatchedToken = await generateAccessToken({
			userId: neighbourUserId,
			role: "supervisor",
			tenantId: demoTenantId,
		});
	});

	test("the mismatched token is a VALID token, so the 404s below come from the handlers", async () => {
		// Otherwise the whole block could pass because the middleware rejected a malformed
		// credential, proving nothing about any query.
		const payload = await verifyAccessToken(mismatchedToken);

		expect(payload.sub).toBe(neighbourUserId);
		expect(payload.tid).toBe(demoTenantId);
	});

	test("GET /api/auth/me does not return the neighbour's account", async () => {
		const response = await client.get("/api/auth/me", { token: mismatchedToken });

		expect(response.status).toBe(404);
		expect(response.text).not.toContain(neighbourPhone);
	});

	test("GET /api/users/me/profile does not return the neighbour's account or operator", async () => {
		const response = await client.get("/api/users/me/profile", { token: mismatchedToken });

		expect(response.status).toBe(404);
		expect(response.text).not.toContain(neighbourPhone);
		// The operator profile is a SECOND query in that handler, scoped separately, and
		// the extension is the value it would leak.
		expect(response.text).not.toContain(neighbourExtension);
	});

	test("POST /api/auth/change-password does not rotate the neighbour's password", async () => {
		const before = await db.query.users.findFirst({
			where: eq(users.id, neighbourUserId),
			columns: { passwordHash: true },
		});

		// The CORRECT current password, so nothing but the tenant term can refuse this.
		const response = await client.post("/api/auth/change-password", {
			token: mismatchedToken,
			json: { currentPassword: NEIGHBOUR_PASSWORD, newPassword: "hijacked12345" },
		});

		expect(response.status).toBe(404);

		const after = await db.query.users.findFirst({
			where: eq(users.id, neighbourUserId),
			columns: { passwordHash: true },
		});

		expect(after?.passwordHash).toBe(before?.passwordHash as string);

		// And the account still works, because a handler that revoked the sessions before
		// refusing would have locked a stranger out without changing a single column.
		const stillWorks = await client.post("/api/auth/login", {
			json: { phone: neighbourPhone, password: NEIGHBOUR_PASSWORD },
		});

		expect(stillWorks.status).toBe(200);
	});
});

describe("PATCH /api/users/{id} cannot take over a phone another tenant holds", () => {
	test("a phone owned by the neighbour is a clean 409, not a 500 and not a steal", async () => {
		// This locks the phone DECISION in place from the update path as well as register.
		// users.phone is unique platform-wide, so the probe in updateHandler is deliberately
		// NOT tenant-scoped. If somebody later "fixes" that probe by scoping it, this test
		// fails with a 500 from the unique index instead of the 409 a client can act on -
		// which is exactly the regression the comment there is warning about.
		const phone = uniquePhone();
		const created = unwrap<{ user: { id: string } }>(
			await client.post("/api/auth/register", {
				token: demoToken,
				json: { phone, password: "probe12345" },
			}),
			"POST /api/auth/register (for the phone takeover test)"
		);

		createdDemoUserIds.push(created.user.id);

		const response = await client.patch(`/api/users/${created.user.id}`, {
			token: demoToken,
			json: { phone: neighbourPhone },
		});

		expect(response.status).toBe(409);

		// Neither row moved: the neighbour keeps its login, and the demo user keeps its own.
		const neighbourRow = await db.query.users.findFirst({
			where: eq(users.id, neighbourUserId),
			columns: { phone: true, tenantId: true },
		});

		expect(neighbourRow?.phone).toBe(neighbourPhone);
		expect(neighbourRow?.tenantId).toBe(neighbourTenantId);

		const demoRow = await db.query.users.findFirst({
			where: eq(users.id, created.user.id),
			columns: { phone: true },
		});

		expect(demoRow?.phone).toBe(phone);
	});
});

describe("a suspended tenant gets no credentials at all", () => {
	test("login is refused for a user whose tenant is suspended", async () => {
		// The tenant was created suspended and never logged into, so no cache anywhere
		// can be hiding the status - this is the database's answer, over HTTP.
		const response = await client.post("/api/auth/login", {
			json: { phone: suspendedPhone, password: NEIGHBOUR_PASSWORD },
		});

		expect(response.status).toBe(401);
		expect(response.text).not.toContain("accessToken");
	});

	test("the refusal is about the tenant, not the password", async () => {
		// The same account with a wrong password is refused too, of course. What matters
		// is that the correct password did not produce a token above: an account we have
		// cut off must not be able to mint one.
		const response = await client.post("/api/auth/login", {
			json: { phone: suspendedPhone, password: "definitely-wrong" },
		});

		expect(response.status).toBe(401);

		const row = await db.query.users.findFirst({
			where: eq(users.phone, suspendedPhone),
			columns: { tenantId: true, isActive: true },
		});

		// The user is perfectly fine; it is the tenant that is not.
		expect(row?.isActive).toBe(true);
		expect(row?.tenantId).toBe(asTenantId(suspendedTenantId));
	});
});
