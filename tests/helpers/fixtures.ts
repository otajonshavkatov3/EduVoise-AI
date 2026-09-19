/**
 * Test data the integration suites need, created through the public API and
 * removed again afterwards.
 *
 * Two rules this module exists to enforce:
 *
 *   1. Nothing is created by reaching into the database. Rows are created the
 *      way the product creates them (POST /api/contacts, the legacy FreePBX
 *      webhook, ...), so a fixture that stops working is a real regression.
 *   2. Everything created is recorded and deleted in afterAll. The CRM database
 *      is in use; a verification run must leave no residue except audit_logs
 *      rows, which are append-only by design and are themselves evidence that
 *      the endpoints ran.
 *
 * The one long-lived fixture is the test manager (a `manager` user plus an
 * operator profile). It is reused across runs instead of being recreated,
 * because deleting a user would cascade into calls and tickets. See
 * tests/README.md for how to remove it by hand.
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import {
	bookings,
	calls,
	callTranscripts,
	contacts,
	followUpTasks,
	tenants,
} from "../../apps/backend/src/db/schema";
import { login, type TestClient, unwrap } from "./api-client";

/**
 * The RBAC fixture: a real `manager` account with an operator profile.
 *
 * Extension 991 is deliberately outside the deployment's real range (101-104
 * are the softphones, 900 is the AI agent), so this profile can never be picked
 * as a transfer target by the live dialplan.
 */
export const TEST_MANAGER = {
	phone: "+998900000911",
	password: "verify-manager-123",
	extension: "991",
} as const;

export interface ManagerFixture {
	userId: string;
	/** Access token for the manager, for the RBAC assertions. */
	token: string;
	/** operatorProfiles.id - what follow-ups and bookings mean by `assignedTo`. */
	operatorProfileId: string;
}

interface OperatorProfileItem {
	id: string;
	userId: string;
	extension: string;
	isDeleted: boolean;
}

interface ContactItem {
	id: string;
	phoneNumber: string;
	firstName: string | null;
	lastName: string | null;
}

export interface LegacyCallStartResult {
	id: string;
	success: true;
	createdAt: string;
	startedAt: string;
	contact: {
		id: string;
		firstName: string | null;
		lastName: string | null;
		contactName?: string | null;
		address: unknown;
	} | null;
}

// ===========================================
// Manager + operator profile
// ===========================================

async function findOperatorProfile(
	client: TestClient,
	supervisorToken: string,
	userId: string
): Promise<OperatorProfileItem | null> {
	const response = await client.get("/api/operator-profiles?limit=100", {
		token: supervisorToken,
	});
	const { items } = unwrap<{ items: OperatorProfileItem[] }>(
		response,
		"GET /api/operator-profiles"
	);

	return items.find((item) => item.userId === userId && !item.isDeleted) ?? null;
}

async function ensureOperatorProfile(
	client: TestClient,
	supervisorToken: string,
	userId: string
): Promise<string> {
	const existing = await findOperatorProfile(client, supervisorToken, userId);

	if (existing) {
		return existing.id;
	}

	const created = await client.post("/api/operator-profiles", {
		token: supervisorToken,
		json: { userId, extension: TEST_MANAGER.extension },
	});

	if (created.status === 409) {
		throw new Error(
			`extension ${TEST_MANAGER.extension} already belongs to another operator profile. ` +
				"Free it, or change TEST_MANAGER.extension in tests/helpers/fixtures.ts."
		);
	}

	const profile = unwrap<OperatorProfileItem>(created, "POST /api/operator-profiles");

	return profile.id;
}

/**
 * Return the test manager, creating the account on first use.
 *
 * POST /api/auth/register always produces role `manager`, which is exactly the
 * role the RBAC assertions need; 409 means a previous run already made it.
 */
export async function ensureTestManager(
	client: TestClient,
	supervisorToken: string
): Promise<ManagerFixture> {
	const registered = await client.post("/api/auth/register", {
		token: supervisorToken,
		json: { phone: TEST_MANAGER.phone, password: TEST_MANAGER.password },
	});

	if (registered.status !== 200 && registered.status !== 409) {
		throw new Error(
			`could not create the test manager: HTTP ${registered.status} ${registered.text.slice(0, 400)}`
		);
	}

	const session = await login(client, TEST_MANAGER.phone, TEST_MANAGER.password);

	if (session.user.role !== "manager") {
		throw new Error(
			`${TEST_MANAGER.phone} exists with role "${session.user.role}", but the RBAC assertions ` +
				"need a manager. Delete that user or change TEST_MANAGER.phone."
		);
	}

	const operatorProfileId = await ensureOperatorProfile(client, supervisorToken, session.user.id);

	return { userId: session.user.id, token: session.accessToken, operatorProfileId };
}

// ===========================================
// Disposable rows
// ===========================================

/**
 * A phone number no other run will reuse.
 *
 * Digits only, no leading "+", because that is what the legacy FreePBX webhook
 * matches against: it strips every non-digit from the caller id and compares the
 * result to `contacts.phone_number` verbatim. A contact stored as
 * "+998901234567" would therefore never be matched - a real trap this suite
 * exercises rather than papers over.
 */
export function uniquePhone(): string {
	const suffix = String(Date.now()).slice(-7);

	return `99890${suffix}`;
}

export async function createContact(
	client: TestClient,
	token: string,
	input: { phoneNumber: string; firstName?: string; lastName?: string }
): Promise<ContactItem> {
	const response = await client.post("/api/contacts", { token, json: input });

	return unwrap<ContactItem>(response, "POST /api/contacts");
}

/**
 * The demo tenant's webhook secret, read once per test process.
 *
 * Not a constant: it is generated per install by the seeder, precisely so two
 * deployments never share one.
 */
let cachedWebhookToken: string | null = null;

export async function demoWebhookToken(): Promise<string> {
	if (cachedWebhookToken !== null) {
		return cachedWebhookToken;
	}

	const [row] = await db
		.select({ token: tenants.webhookToken })
		.from(tenants)
		.where(eq(tenants.slug, "avilab"))
		.limit(1);

	if (row === undefined) {
		throw new Error("the demo tenant (slug \"avilab\") is missing: run the seeders");
	}

	cachedWebhookToken = row.token;

	return row.token;
}

/**
 * Create a `calls` row the way FreePBX still does it.
 *
 * Used as a fixture *and* as the backward-compatibility assertion: if this
 * stops working, the legacy PBX integration is broken. The webhook still takes
 * no bearer token - a PBX has nowhere to put one - but it is now per tenant: the
 * secret sits in the URL, which is the one thing a PBX can be configured with.
 * The token is read from the demo tenant so the helper needs no fixture of its own.
 */
export async function createCallViaLegacyWebhook(
	client: TestClient,
	body: {
		direction: "inbound" | "outbound";
		callerNumber: string;
		calleeExtension?: string;
		contactId?: string;
	}
): Promise<LegacyCallStartResult> {
	const token = await demoWebhookToken();
	const path = `/api/webhooks/freepbx/${token}/call-start`;
	const response = await client.post(path, { json: body });

	if (response.status !== 200) {
		throw new Error(`POST ${path} answered HTTP ${response.status}: ${response.text.slice(0, 400)}`);
	}

	return response.body as LegacyCallStartResult;
}

/**
 * Ids of rows a suite created, deleted in reverse dependency order.
 *
 * Direct database deletes on purpose: the API only soft-deletes (correctly), so
 * this is the only way for a verification run to leave the CRM as it found it.
 */
export class CreatedRows {
	readonly transcripts: string[] = [];
	readonly followUps: string[] = [];
	readonly bookings: string[] = [];
	readonly calls: string[] = [];
	readonly contacts: string[] = [];

	async cleanup(): Promise<void> {
		if (this.transcripts.length > 0) {
			await db.delete(callTranscripts).where(inArray(callTranscripts.id, this.transcripts));
		}
		if (this.followUps.length > 0) {
			await db.delete(followUpTasks).where(inArray(followUpTasks.id, this.followUps));
		}
		if (this.bookings.length > 0) {
			await db.delete(bookings).where(inArray(bookings.id, this.bookings));
		}
		if (this.calls.length > 0) {
			await db.delete(calls).where(inArray(calls.id, this.calls));
		}
		if (this.contacts.length > 0) {
			await db.delete(contacts).where(inArray(contacts.id, this.contacts));
		}

		this.transcripts.length = 0;
		this.followUps.length = 0;
		this.bookings.length = 0;
		this.calls.length = 0;
		this.contacts.length = 0;
	}
}

let dbClosed = false;

/**
 * Release the Postgres pool.
 *
 * Only for a standalone script (tests/e2e/run-verification.ts). Test suites must
 * NOT call this: `bun test` runs every file in one process, so the first suite
 * to end the pool would break every suite after it - `db` is a module-level
 * singleton and a closed pg pool cannot be reopened. The test runner exits on
 * its own, so nothing leaks.
 */
export async function closeDb(): Promise<void> {
	if (dbClosed) {
		return;
	}

	dbClosed = true;

	const client = db.$client as { end?: () => Promise<void> };

	if (typeof client.end === "function") {
		await client.end();
	}
}
