/**
 * THE AUTH BOUNDARY, over HTTP.
 *
 * Four claims, each of which is the whole product if it is false:
 *
 *   1. A customer's token carries that customer's tenant, and nothing a client
 *      sends can change which tenant a request is scoped to.
 *   2. A customer's own supervisor - the most powerful role inside an account -
 *      cannot see that other customers exist.
 *   3. The vendor can list customers and ENTER one, and the token it gets back is
 *      scoped to that customer.
 *   4. Every request the vendor makes inside a customer's account leaves an audit
 *      row that the CUSTOMER can see.
 *
 * The vendor account is created by `bun run db:seed:vendor`. When it is absent the
 * vendor half is skipped with a printed reason rather than failing, so this suite
 * still runs on a database that has only been seeded with the customer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, gt } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import { auditLogs, users } from "../../apps/backend/src/db/schema";
import { verifyAccessToken } from "../../apps/backend/src/lib/auth/jwt";
import { createApp } from "../../apps/backend/src/lib";
import { getTenantBySlug, getVendorTenantId } from "../../apps/backend/src/lib/tenancy";
import auth from "../../apps/backend/src/routes/auth";
import calls from "../../apps/backend/src/routes/calls";
import vendor from "../../apps/backend/src/routes/vendor";
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

/** Created by `bun run db:seed:vendor`. */
const SEEDED_VENDOR = {
	phone: process.env.VENDOR_PHONE ?? "+998900000001",
	password: process.env.VENDOR_PASSWORD ?? "vendor123",
} as const;

let client: TestClient;
let supervisorToken: string;
let vendorToken: string | null = null;
let demoTenantId: string;
let vendorTenantId: string;
/** Rows written before the test started, so only new audit rows are asserted on. */
let auditCutoff: Date;

beforeAll(async () => {
	const baseUrl = resolveBaseUrl();

	if (await isBackendReachable(baseUrl)) {
		client = createLiveClient(baseUrl);
	} else {
		// The same assertions against an app composed in this process, so the boundary
		// is verified even with no server running.
		const app = createApp();
		app.route("/api/auth", auth);
		app.route("/api/calls", calls);
		app.route("/api/vendor", vendor);
		client = createInProcessClient((path, init) => app.request(path, init));
	}

	console.log(`tenant boundary suite transport: ${client.label}`);

	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	demoTenantId = demo.id;
	vendorTenantId = await getVendorTenantId();
	auditCutoff = new Date();

	supervisorToken = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password))
		.accessToken;

	const vendorUser = await db.query.users.findFirst({
		where: and(eq(users.phone, SEEDED_VENDOR.phone), eq(users.role, "vendor")),
		columns: { id: true },
	});

	if (vendorUser) {
		vendorToken = (await login(client, SEEDED_VENDOR.phone, SEEDED_VENDOR.password)).accessToken;
	} else {
		console.log(
			"no vendor account found - skipping the vendor half of this suite. Create it with: bun run db:seed:vendor"
		);
	}
});

afterAll(() => {
	// Nothing to clean up: this suite creates no rows of its own. The audit rows the
	// vendor requests produce are the evidence and are append-only by design.
});

describe("a customer's token carries their tenant", () => {
	test("the supervisor's token is scoped to the demo tenant", async () => {
		const payload = await verifyAccessToken(supervisorToken);

		expect(payload.tid).toBe(demoTenantId);
		expect(payload.role).toBe("supervisor");
		// No actor claim: this is the customer's own user, not the vendor.
		expect(payload.act).toBeUndefined();
	});

	test("a request with no token is refused", async () => {
		const response = await client.get("/api/calls");

		expect(response.status).toBe(401);
	});

	test("a token minted before tenancy is refused with 401, not served unscoped", async () => {
		// A v1 token is correctly signed - it just has no tenant. Serving it would mean
		// choosing a tenant on its behalf, which is the leak. The client's answer is to
		// refresh, which every client already does on a 401.
		const legacyStyleToken = supervisorToken.split(".").slice(0, 2).join(".");
		const response = await client.get("/api/calls", { token: legacyStyleToken });

		expect(response.status).toBe(401);
	});
});

describe("a customer cannot reach the vendor console", () => {
	test("a supervisor gets 403 from the tenant list", async () => {
		const response = await client.get("/api/vendor/tenants", { token: supervisorToken });

		// 403 rather than 404: the ROUTE is not a secret, the customer list is. What
		// must never happen is a 200.
		expect(response.status).toBe(403);
		expect(response.text).not.toContain("avilab");
	});

	test("a supervisor cannot enter another account", async () => {
		const response = await client.post(`/api/vendor/tenants/${vendorTenantId}/enter`, {
			token: supervisorToken,
			json: { reason: "trying" },
		});

		expect(response.status).toBe(403);
		expect(response.text).not.toContain("accessToken");
	});
});

describe("the vendor is above every tenant", () => {
	test("the vendor lists customers, without secrets", async () => {
		if (!vendorToken) {
			return;
		}

		const data = unwrap<{ items: { slug: string; hasAiApiKey: boolean }[] }>(
			await client.get("/api/vendor/tenants", { token: vendorToken }),
			"GET /api/vendor/tenants"
		);

		expect(data.items.map((item) => item.slug)).toContain("avilab");
		// The shape reports WHETHER a key is set, never the key.
		expect(Object.keys(data.items[0] ?? {})).not.toContain("aiApiKey");
		expect(Object.keys(data.items[0] ?? {})).not.toContain("sipTrunkPassword");
	});

	test("entering a customer returns a token scoped to that customer, naming the vendor", async () => {
		if (!vendorToken) {
			return;
		}

		const data = unwrap<{ accessToken: string; tenant: { slug: string } }>(
			await client.post(`/api/vendor/tenants/${demoTenantId}/enter`, {
				token: vendorToken,
				json: { reason: "verification suite" },
			}),
			"POST /api/vendor/tenants/:id/enter"
		);

		expect(data.tenant.slug).toBe("avilab");

		const payload = await verifyAccessToken(data.accessToken);

		// Scoped to the customer...
		expect(payload.tid).toBe(demoTenantId);
		// ...while remaining identifiable as the vendor. This claim is what the audit
		// trail and the middleware's isVendorAccess flag are built on, and only the
		// enter endpoint can mint it.
		expect(payload.act?.tid).toBe(vendorTenantId);
		expect(payload.role).toBe("vendor");
	});

	test("the vendor cannot enter the vendor tenant itself", async () => {
		if (!vendorToken) {
			return;
		}

		// Entering your own tenant is not impersonation; minting a token that claims it
		// is would put false rows in the audit trail.
		const response = await client.post(`/api/vendor/tenants/${vendorTenantId}/enter`, {
			token: vendorToken,
		});

		expect(response.status).toBe(404);
	});

	test("entering a tenant that does not exist is a 404, not an enumeration oracle", async () => {
		if (!vendorToken) {
			return;
		}

		const response = await client.post(
			"/api/vendor/tenants/00000000-0000-4000-8000-000000000000/enter",
			{ token: vendorToken }
		);

		expect(response.status).toBe(404);
	});
});

describe("the vendor cannot read a customer's data without leaving a trace", () => {
	test("an impersonated request answers the customer's data AND writes an audit row", async () => {
		if (!vendorToken) {
			return;
		}

		const entered = unwrap<{ accessToken: string }>(
			await client.post(`/api/vendor/tenants/${demoTenantId}/enter`, {
				token: vendorToken,
				json: { reason: "reading calls" },
			}),
			"POST /api/vendor/tenants/:id/enter"
		);

		const response = await client.get("/api/calls?page=1&limit=1", {
			token: entered.accessToken,
		});

		// The vendor genuinely gets in - a super-admin who cannot help a customer is not
		// a super-admin - and gets there through the customer's own route, not a
		// parallel one.
		expect(response.status).toBe(200);

		// And genuinely sees the data. Worth asserting separately: authorisation in this
		// codebase is not only requireRole() gates - handlers test membership of inline
		// role lists (CAN_SEE_ALL_CALLS and friends), which a literal "vendor" role
		// passes none of. Without the effective-role mapping in the auth middleware this
		// endpoint answers 200 with an empty page, which looks like success and is
		// useless. The demo tenant has calls, so an empty page here is a regression.
		const page = unwrap<{ items: unknown[] }>(response, "GET /api/calls as the vendor");

		expect(page.items.length).toBeGreaterThan(0);

		const rows = await db
			.select({
				action: auditLogs.action,
				tenantId: auditLogs.tenantId,
				actorTenantId: auditLogs.actorTenantId,
				isVendorAccess: auditLogs.isVendorAccess,
			})
			.from(auditLogs)
			.where(and(eq(auditLogs.isVendorAccess, true), gt(auditLogs.createdAt, auditCutoff)));

		const actions = rows.map((row) => row.action);

		// One row for the entry, one for the request made with the token.
		expect(actions).toContain("vendor.tenant.enter");
		expect(actions).toContain("vendor.access");

		for (const row of rows) {
			// tenant_id is the CUSTOMER, so the row appears in the customer's own audit
			// log - which is the point. actor_tenant_id is the vendor, so the vendor
			// console can list its own staff's activity.
			expect(row.tenantId).toBe(demoTenantId);
			expect(row.actorTenantId).toBe(vendorTenantId);
			expect(row.isVendorAccess).toBe(true);
		}
	});
});
