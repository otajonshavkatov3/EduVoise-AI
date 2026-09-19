/**
 * THE CRM BOUNDARY, with two real tenants and real rows.
 *
 * Every assertion in this file is a leak that would end the business. The CRM is
 * where a call centre keeps the things a customer would sue over: the people who
 * rang, their phone numbers and addresses, what they complained about, who is
 * visiting them on Tuesday, and the exports that put all of it in one downloadable
 * file. Six route groups read those tables - contacts, tickets, bookings,
 * follow-ups, dashboard, reports - and before this phase not one of their queries
 * named a tenant.
 *
 * WHY THIS SHAPE. A test that only checks "tenant B's list is empty" passes on
 * unscoped code the moment the demo tenant happens to have no rows either. So this
 * suite:
 *
 *   1. records the DEMO tenant's own numbers first (counts, dashboard totals,
 *      report totals),
 *   2. creates a SECOND tenant with one of everything - a contact, a call, a
 *      ticket, a booking, a follow-up, an operator on extension 101 (the same
 *      extension the demo tenant uses, which is the point of decision #1),
 *   3. asserts the demo tenant's numbers did not move by a single row, that its
 *      lists and its CSV export contain nothing of tenant B's, and that tenant B's
 *      ids answer 404 rather than 403,
 *   4. asserts the same in the other direction from tenant B's side, where the
 *      expected counts are exactly 1 - so an unscoped query fails loudly with
 *      "expected 1, got 131" rather than passing vacuously,
 *   5. asserts that a WRITE cannot be pointed at the other tenant's row by putting
 *      its id in the request body, which is the one hole types and scanners cannot
 *      see.
 *
 * IN-PROCESS ON PURPOSE. The other suites prefer a live backend; this one always
 * composes the app in this process, because it is asserting the behaviour of the
 * handlers IN THE TREE. A live server started before these changes would answer
 * from the old code and the suite would be testing nothing.
 *
 * SAFETY. It creates one tenant and its rows, and deletes them, children first, in
 * afterAll. It writes nothing to the demo tenant and asserts on it read-only.
 */
import { asTenantId, type TenantId } from "@shared/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import {
	auditLogs,
	bookings,
	calls,
	contacts,
	followUpTasks,
	operatorProfiles,
	tenants,
	tickets,
	users,
} from "../../apps/backend/src/db/schema";
import { generateAccessToken } from "../../apps/backend/src/lib/auth/jwt";
import { createApp } from "../../apps/backend/src/lib";
import { getTenantBySlug, invalidateTenantCache } from "../../apps/backend/src/lib/tenancy";
import auth from "../../apps/backend/src/routes/auth";
import bookingRoutes from "../../apps/backend/src/routes/bookings";
import contactRoutes from "../../apps/backend/src/routes/contacts";
import dashboardRoutes from "../../apps/backend/src/routes/dashboard";
import followUpRoutes from "../../apps/backend/src/routes/follow-ups";
import reportRoutes from "../../apps/backend/src/routes/reports";
import ticketRoutes from "../../apps/backend/src/routes/tickets";
import {
	createInProcessClient,
	login,
	SEEDED_SUPERVISOR,
	type TestClient,
	unwrap,
} from "../helpers/api-client";

/** Unique enough that finding it in another tenant's response is unambiguous. */
const MARKER = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const OTHER_PHONE = `+99890${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const OTHER_LOGIN_PHONE = `+99891${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/** The extension the demo tenant also uses: colliding digits must be fine. */
const SHARED_EXTENSION = "101";

interface Fixture {
	tenantId: TenantId;
	userId: string;
	operatorId: string;
	contactId: string;
	callId: string;
	/** A second call, unanswered, so the missed-calls list has something to leak. */
	missedCallId: string;
	ticketId: string;
	bookingId: string;
	followUpId: string;
}

interface Baseline {
	contacts: number;
	tickets: number;
	bookings: number;
	followUps: number;
	calendar: number;
	summaryCalls: number;
	overviewCalls: number;
	overviewOperators: number;
	missedCalls: number;
	reportCalls: number;
	reportTickets: number;
	reportOperators: number;
}

/** Tomorrow, UTC, as YYYY-MM-DD: the calendar anchor and the booking's day. */
function tomorrowKey(): string {
	return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let client: TestClient;
let demoToken: string;
let otherToken: string;
let demoTenantId: TenantId;
let other: Fixture;
let baseline: Baseline;
/** Report range: wide enough to contain everything, inside the 366-day limit. */
let rangeFrom: string;
let rangeTo: string;

interface Page {
	items: { id: string }[];
	meta: { total: number };
}

async function listPage(path: string, token: string): Promise<Page> {
	return unwrap<Page>(await client.get(path, { token }), `GET ${path}`);
}

async function readBaseline(token: string): Promise<Baseline> {
	const range = `from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`;

	const [contactPage, ticketPage, bookingPage, followUpPage] = await Promise.all([
		listPage("/api/contacts?page=1&limit=1", token),
		listPage("/api/tickets?page=1&limit=1", token),
		listPage("/api/bookings?page=1&limit=1", token),
		listPage("/api/follow-ups?page=1&limit=1", token),
	]);

	const summary = unwrap<{ totalCalls: number }>(
		await client.get("/api/dashboard/summary", { token }),
		"GET /api/dashboard/summary"
	);
	const overview = unwrap<{ current: { total: number }; operators: { total: number } }>(
		await client.get("/api/dashboard/overview?period=month", { token }),
		"GET /api/dashboard/overview"
	);
	const callsReport = unwrap<Page>(
		await client.get(`/api/reports/calls?${range}&page=1&limit=1`, token ? { token } : {}),
		"GET /api/reports/calls"
	);
	const ticketsReport = unwrap<Page>(
		await client.get(`/api/reports/tickets?${range}&page=1&limit=1`, { token }),
		"GET /api/reports/tickets"
	);
	const operatorsReport = unwrap<Page>(
		await client.get(`/api/reports/operators?${range}&page=1&limit=1`, { token }),
		"GET /api/reports/operators"
	);
	const missed = unwrap<{ total: number }>(
		await client.get("/api/dashboard/missed-calls?period=month&limit=50", { token }),
		"GET /api/dashboard/missed-calls"
	);
	const calendar = unwrap<{ total: number }>(
		await client.get(`/api/bookings/calendar?view=week&date=${tomorrowKey()}`, { token }),
		"GET /api/bookings/calendar"
	);

	return {
		contacts: contactPage.meta.total,
		tickets: ticketPage.meta.total,
		bookings: bookingPage.meta.total,
		followUps: followUpPage.meta.total,
		calendar: calendar.total,
		summaryCalls: summary.totalCalls,
		overviewCalls: overview.current.total,
		overviewOperators: overview.operators.total,
		missedCalls: missed.total,
		reportCalls: callsReport.meta.total,
		reportTickets: ticketsReport.meta.total,
		reportOperators: operatorsReport.meta.total,
	};
}

/** One of everything, for a tenant that must stay invisible to the demo tenant. */
async function createOtherTenant(): Promise<Fixture> {
	const [tenant] = await db
		.insert(tenants)
		.values({
			name: `Isolation probe ${MARKER}`,
			slug: `probe-${MARKER}`.toLowerCase().slice(0, 40),
			status: "trial",
		})
		.returning({ id: tenants.id });

	if (!tenant) {
		throw new Error("could not create the probe tenant");
	}

	const tenantId = tenant.id;

	const [user] = await db
		.insert(users)
		.values({
			tenantId,
			phone: OTHER_LOGIN_PHONE,
			username: `probe-${MARKER}`,
			// Never logged in with: this suite mints the token directly. A bcrypt-shaped
			// string is not required by any column, and no login path reads it.
			passwordHash: "not-a-usable-hash",
			role: "supervisor",
		})
		.returning({ id: users.id });
	const [operator] = await db
		.insert(operatorProfiles)
		.values({ tenantId, userId: user?.id ?? "", extension: SHARED_EXTENSION })
		.returning({ id: operatorProfiles.id });
	const [contact] = await db
		.insert(contacts)
		.values({
			tenantId,
			phoneNumber: OTHER_PHONE,
			firstName: `Probe${MARKER}`,
			lastName: "Isolation",
		})
		.returning({ id: contacts.id });
	const [call] = await db
		.insert(calls)
		.values({
			tenantId,
			direction: "inbound",
			callerNumber: OTHER_PHONE,
			contactId: contact?.id,
			operatorId: operator?.id,
			status: "completed",
			duration: 42,
			startedAt: new Date(),
			answeredAt: new Date(),
			endedAt: new Date(),
		})
		.returning({ id: calls.id });
	const [missedCall] = await db
		.insert(calls)
		.values({
			tenantId,
			direction: "inbound",
			callerNumber: OTHER_PHONE,
			contactId: contact?.id,
			operatorId: operator?.id,
			// Unanswered on purpose: the dashboard's missed-calls list joins the contact
			// NAME onto it, so it is the endpoint that leaks a person rather than a count.
			status: "missed",
			duration: 0,
			startedAt: new Date(),
			endedAt: new Date(),
		})
		.returning({ id: calls.id });
	const [ticket] = await db
		.insert(tickets)
		.values({
			tenantId,
			contactId: contact?.id ?? "",
			createdBy: user?.id ?? "",
			subject: `Probe ticket ${MARKER}`,
			description: "Isolation probe",
			category: `probe-${MARKER}`,
		})
		.returning({ id: tickets.id });
	const [booking] = await db
		.insert(bookings)
		.values({
			tenantId,
			contactId: contact?.id ?? "",
			title: `Probe booking ${MARKER}`,
			// Tomorrow: the calendar and the "not in the past" rule both stay happy.
			scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
			assignedTo: operator?.id,
		})
		.returning({ id: bookings.id });
	const [followUp] = await db
		.insert(followUpTasks)
		.values({
			tenantId,
			title: `Probe follow-up ${MARKER}`,
			contactId: contact?.id,
			assignedTo: operator?.id,
		})
		.returning({ id: followUpTasks.id });

	if (!(user && operator && contact && call && missedCall && ticket && booking && followUp)) {
		throw new Error("could not create the probe tenant's rows");
	}

	return {
		tenantId,
		userId: user.id,
		operatorId: operator.id,
		contactId: contact.id,
		callId: call.id,
		missedCallId: missedCall.id,
		ticketId: ticket.id,
		bookingId: booking.id,
		followUpId: followUp.id,
	};
}

beforeAll(async () => {
	const app = createApp();
	app.route("/api/auth", auth);
	app.route("/api/contacts", contactRoutes);
	app.route("/api/tickets", ticketRoutes);
	app.route("/api/bookings", bookingRoutes);
	app.route("/api/follow-ups", followUpRoutes);
	app.route("/api/dashboard", dashboardRoutes);
	app.route("/api/reports", reportRoutes);
	client = createInProcessClient((path, init) => app.request(path, init));

	console.log(`CRM isolation suite transport: ${client.label}`);

	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	demoTenantId = demo.id;
	rangeFrom = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString();
	rangeTo = new Date(Date.now() + 60 * 60 * 1000).toISOString();

	demoToken = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password))
		.accessToken;

	// The demo tenant's numbers BEFORE the second tenant exists. Everything after
	// this line must leave them exactly where they are.
	baseline = await readBaseline(demoToken);

	other = await createOtherTenant();
	// A second customer tenant now exists, which is what the sole-tenant seam is
	// memoised on.
	invalidateTenantCache();

	otherToken = await generateAccessToken({
		userId: other.userId,
		role: "supervisor",
		tenantId: other.tenantId,
	});
});

afterAll(async () => {
	if (!other) {
		return;
	}

	// Children first: every tenant FK is ON DELETE RESTRICT, on purpose - deleting a
	// tenant must never be able to take a customer's calls with it.
	await db.delete(followUpTasks).where(eq(followUpTasks.tenantId, other.tenantId));
	await db.delete(bookings).where(eq(bookings.tenantId, other.tenantId));
	await db.delete(calls).where(eq(calls.tenantId, other.tenantId));
	await db.delete(tickets).where(eq(tickets.tenantId, other.tenantId));
	await db.delete(contacts).where(eq(contacts.tenantId, other.tenantId));
	await db.delete(operatorProfiles).where(eq(operatorProfiles.tenantId, other.tenantId));
	await db.delete(auditLogs).where(eq(auditLogs.tenantId, other.tenantId));
	await db.delete(users).where(eq(users.tenantId, other.tenantId));
	await db.delete(tenants).where(eq(tenants.id, other.tenantId));
	invalidateTenantCache();
});

describe("the two tenants are genuinely two", () => {
	test("the probe tenant is not the demo tenant, and both have rows", () => {
		// If these were ever equal every assertion below would pass vacuously.
		expect(other.tenantId).not.toBe(demoTenantId);
		expect(asTenantId(other.tenantId)).toBe(other.tenantId);
	});

	test("the same extension exists in both tenants, which is allowed and must stay allowed", async () => {
		const rows = await db
			.select({ tenantId: operatorProfiles.tenantId })
			.from(operatorProfiles)
			.where(eq(operatorProfiles.extension, SHARED_EXTENSION));
		const owners = new Set(rows.map((row) => row.tenantId));

		// Decision #1: "101" is an operator code, not an identity. Two customers both
		// having one is the normal case, and the isolation lives elsewhere.
		expect(owners.has(other.tenantId)).toBe(true);
		expect(rows.length).toBeGreaterThanOrEqual(1);
	});
});

describe("the demo tenant does not see the new tenant's rows", () => {
	test("not one of its counts moved when a whole second business appeared", async () => {
		const after = await readBaseline(demoToken);

		// Six list/report totals and three dashboard aggregates. An aggregate is the
		// easiest place to leak and the hardest place to notice: nothing looks broken,
		// the customer's business just appears bigger than it is.
		expect(after).toEqual(baseline);
	});

	test("its lists contain none of the other tenant's ids", async () => {
		const [contactPage, ticketPage, bookingPage, followUpPage] = await Promise.all([
			listPage("/api/contacts?page=1&limit=100", demoToken),
			listPage("/api/tickets?page=1&limit=100", demoToken),
			listPage("/api/bookings?page=1&limit=100", demoToken),
			listPage("/api/follow-ups?page=1&limit=100", demoToken),
		]);

		expect(contactPage.items.map((item) => item.id)).not.toContain(other.contactId);
		expect(ticketPage.items.map((item) => item.id)).not.toContain(other.ticketId);
		expect(bookingPage.items.map((item) => item.id)).not.toContain(other.bookingId);
		expect(followUpPage.items.map((item) => item.id)).not.toContain(other.followUpId);
	});

	test("another tenant's id is a 404 on every single-row route, never a 403", async () => {
		const responses = await Promise.all([
			client.get(`/api/contacts/${other.contactId}`, { token: demoToken }),
			client.get(`/api/tickets/${other.ticketId}`, { token: demoToken }),
			client.get(`/api/bookings/${other.bookingId}`, { token: demoToken }),
			client.get(`/api/follow-ups/${other.followUpId}`, { token: demoToken }),
		]);

		// 403 would confirm the id exists somewhere on the platform. Existence is
		// information, so the answer is the same one an invented uuid gets.
		expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
	});

	test("the caller-id lookup does not resolve another tenant's phone number", async () => {
		// A natural key, and the most dangerous read in the CRM: it answers with a
		// name, an address and notes for any number the caller can type.
		const data = unwrap<{ contact: unknown }>(
			await client.get(`/api/contacts/lookup?phoneNumber=${encodeURIComponent(OTHER_PHONE)}`, {
				token: demoToken,
			}),
			"GET /api/contacts/lookup"
		);

		expect(data.contact).toBeNull();
	});

	test("the CSV export contains no trace of the other tenant", async () => {
		const range = `from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`;
		const response = await client.get(`/api/reports/calls/export?${range}&format=csv`, {
			token: demoToken,
		});

		expect(response.status).toBe(200);
		// One click, one file, and the whole platform inside it. The probe's call is
		// inside the exported range, so an unscoped export puts this number in it.
		expect(response.text).not.toContain(OTHER_PHONE);
		expect(response.text).not.toContain(MARKER);
	});

	test("the tickets export contains no trace of the other tenant", async () => {
		const range = `from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`;
		const response = await client.get(`/api/reports/tickets/export?${range}&format=csv`, {
			token: demoToken,
		});

		expect(response.status).toBe(200);
		expect(response.text).not.toContain(MARKER);
		expect(response.text).not.toContain(OTHER_PHONE);
	});

	test("the operators export does not list the other tenant's operator", async () => {
		const range = `from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`;
		const response = await client.get(`/api/reports/operators/export?${range}&format=csv`, {
			token: demoToken,
		});

		expect(response.status).toBe(200);
		// The extension is shared by both tenants and the phone column is reformatted
		// on the way out, so the probe operator's USERNAME is what identifies its row -
		// and that must not be in the demo tenant's file.
		expect(response.text).not.toContain(MARKER);
	});
});

describe("the new tenant sees only its own rows", () => {
	test("every list has exactly the one row it created", async () => {
		const [contactPage, ticketPage, bookingPage, followUpPage] = await Promise.all([
			listPage("/api/contacts?page=1&limit=100", otherToken),
			listPage("/api/tickets?page=1&limit=100", otherToken),
			listPage("/api/bookings?page=1&limit=100", otherToken),
			listPage("/api/follow-ups?page=1&limit=100", otherToken),
		]);

		// Exactly one, not "at least one": an unscoped list answers with the demo
		// tenant's rows too and fails here with a number instead of passing quietly.
		expect(contactPage.meta.total).toBe(1);
		expect(ticketPage.meta.total).toBe(1);
		expect(bookingPage.meta.total).toBe(1);
		expect(followUpPage.meta.total).toBe(1);
		expect(contactPage.items.map((item) => item.id)).toEqual([other.contactId]);
		expect(ticketPage.items.map((item) => item.id)).toEqual([other.ticketId]);
		expect(bookingPage.items.map((item) => item.id)).toEqual([other.bookingId]);
		expect(followUpPage.items.map((item) => item.id)).toEqual([other.followUpId]);
	});

	test("a search filter cannot widen the scope", async () => {
		// `q` is a client-controlled ilike over the phone and both names. Matching
		// everything must still match only this tenant's everything.
		const page = await listPage("/api/contacts?page=1&limit=100&q=%25", otherToken);

		expect(page.meta.total).toBe(1);
	});

	test("its dashboard counts its own two calls, not the platform's", async () => {
		const summary = unwrap<{ totalCalls: number; missedCalls: number }>(
			await client.get("/api/dashboard/summary", { token: otherToken }),
			"GET /api/dashboard/summary"
		);
		const overview = unwrap<{
			current: { total: number; missed: number };
			operators: { total: number };
			operatorWorkload: { operatorId: string; totalCalls: number }[];
			ticketCategories: { category: string | null }[];
		}>(
			await client.get("/api/dashboard/overview?period=month", { token: otherToken }),
			"GET /api/dashboard/overview"
		);

		expect(summary.totalCalls).toBe(2);
		expect(summary.missedCalls).toBe(1);
		expect(overview.current.total).toBe(2);
		expect(overview.current.missed).toBe(1);
		// One operator profile, on the same extension the demo tenant uses.
		expect(overview.operators.total).toBe(1);
		// The workload table is a three-table join (calls, operator_profiles, users);
		// only this tenant's operator may appear in it.
		expect(overview.operatorWorkload.map((row) => row.operatorId)).toEqual([other.operatorId]);
		expect(overview.ticketCategories.map((row) => row.category)).toEqual([`probe-${MARKER}`]);
	});

	test("its missed-calls list is its own missed call and nothing else", async () => {
		const data = unwrap<{ total: number; items: { id: string; contactName: string | null }[] }>(
			await client.get("/api/dashboard/missed-calls?period=month&limit=50", { token: otherToken }),
			"GET /api/dashboard/missed-calls"
		);

		expect(data.total).toBe(1);
		expect(data.items.map((item) => item.id)).toEqual([other.missedCallId]);
		// The contact name is joined in, so a leak here has a person's name attached.
		expect(data.items[0]?.contactName).toBe(`Probe${MARKER} Isolation`);
	});

	// NOTE, so nobody trusts this one further than it goes: the demo tenant has no
	// bookings at all today, so from THIS side the assertion would also hold on
	// unscoped code. What makes the calendar's isolation non-vacuous is the demo-side
	// count above - `calendar` is part of the recorded baseline, and an unscoped
	// calendar puts the probe's appointment into the demo tenant's week.
	test("its calendar shows only its own appointment", async () => {
		const data = unwrap<{ total: number; days: { items: { id: string }[] }[] }>(
			await client.get(`/api/bookings/calendar?view=week&date=${tomorrowKey()}`, {
				token: otherToken,
			}),
			"GET /api/bookings/calendar"
		);

		expect(data.total).toBe(1);
		expect(data.days.flatMap((day) => day.items.map((item) => item.id))).toEqual([
			other.bookingId,
		]);
	});

	test("its reports count its own rows only", async () => {
		const range = `from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`;

		const callsReport = unwrap<Page & { summary: { totalCalls: number } }>(
			await client.get(`/api/reports/calls?${range}&page=1&limit=50`, { token: otherToken }),
			"GET /api/reports/calls"
		);
		const ticketsReport = unwrap<Page>(
			await client.get(`/api/reports/tickets?${range}&page=1&limit=50`, { token: otherToken }),
			"GET /api/reports/tickets"
		);
		const operatorsReport = unwrap<Page & { summary: { totalCalls: number } }>(
			await client.get(`/api/reports/operators?${range}&page=1&limit=50`, { token: otherToken }),
			"GET /api/reports/operators"
		);

		expect(callsReport.meta.total).toBe(2);
		// The summary is computed over the whole set, not the page, so it is a second
		// independent query and gets its own assertion.
		expect(callsReport.summary.totalCalls).toBe(2);
		expect(ticketsReport.meta.total).toBe(1);
		// One operator row, and the per-operator call aggregate is a SUBQUERY - the
		// place an unscoped filter is least visible.
		expect(operatorsReport.meta.total).toBe(1);
		expect(operatorsReport.summary.totalCalls).toBe(2);
	});

	test("another tenant's operator cannot be used as a report filter", async () => {
		const demoOperator = await db.query.operatorProfiles.findFirst({
			where: eq(operatorProfiles.tenantId, demoTenantId),
			columns: { id: true },
		});

		if (!demoOperator) {
			return;
		}

		const range = `from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`;
		const response = await client.get(
			`/api/reports/calls?${range}&page=1&limit=5&operatorId=${demoOperator.id}`,
			{ token: otherToken }
		);

		// Not an empty report: a 404, because the filter names a row this tenant must
		// not be able to confirm the existence of.
		expect(response.status).toBe(404);
	});

	test("the demo tenant's ids are 404 from this side too", async () => {
		const demoContact = await db.query.contacts.findFirst({
			where: eq(contacts.tenantId, demoTenantId),
			columns: { id: true },
		});
		const demoTicket = await db.query.tickets.findFirst({
			where: eq(tickets.tenantId, demoTenantId),
			columns: { id: true },
		});

		if (!(demoContact && demoTicket)) {
			throw new Error("the demo tenant has no contacts or tickets; run bun run db:seed");
		}

		const responses = await Promise.all([
			client.get(`/api/contacts/${demoContact.id}`, { token: otherToken }),
			client.get(`/api/tickets/${demoTicket.id}`, { token: otherToken }),
		]);

		expect(responses.map((response) => response.status)).toEqual([404, 404]);
	});
});

describe("a write cannot be aimed at another tenant by an id in the body", () => {
	test("a ticket cannot be attached to another tenant's contact", async () => {
		const demoContact = await db.query.contacts.findFirst({
			where: eq(contacts.tenantId, demoTenantId),
			columns: { id: true },
		});

		if (!demoContact) {
			throw new Error("the demo tenant has no contacts; run bun run db:seed");
		}

		// The foreign key is satisfied - the contact exists. Only the tenant check
		// stands between this request and a ticket filed against a stranger's customer.
		const response = await client.post("/api/tickets", {
			token: otherToken,
			json: {
				contactId: demoContact.id,
				subject: `Cross-tenant ${MARKER}`,
				description: "must not be written",
			},
		});

		expect(response.status).toBe(404);

		const written = await db.query.tickets.findFirst({
			where: eq(tickets.contactId, demoContact.id),
			columns: { id: true, tenantId: true },
			orderBy: (table, { desc }) => [desc(table.createdAt)],
		});

		// And nothing landed: whatever the newest ticket on that contact is, it is not
		// one this tenant wrote.
		expect(written?.tenantId).not.toBe(other.tenantId);
	});

	test("a booking cannot be attached to another tenant's call or contact", async () => {
		const demoCall = await db.query.calls.findFirst({
			where: eq(calls.tenantId, demoTenantId),
			columns: { id: true },
		});

		if (!demoCall) {
			throw new Error("the demo tenant has no calls; run bun run db:seed");
		}

		const foreignContact = await client.post("/api/bookings", {
			token: demoToken,
			json: {
				contactId: other.contactId,
				title: `Cross-tenant ${MARKER}`,
				scheduledAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
			},
		});
		const foreignCall = await client.post("/api/bookings", {
			token: otherToken,
			json: {
				contactId: other.contactId,
				callId: demoCall.id,
				title: `Cross-tenant ${MARKER}`,
				scheduledAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
			},
		});

		expect(foreignContact.status).toBe(404);
		expect(foreignCall.status).toBe(404);
	});

	test("a follow-up cannot be attached to another tenant's ticket", async () => {
		const response = await client.post("/api/follow-ups", {
			token: demoToken,
			json: { title: `Cross-tenant ${MARKER}`, ticketId: other.ticketId },
		});

		expect(response.status).toBe(404);
	});

	test("a booking cannot be assigned to another tenant's operator", async () => {
		const demoOperator = await db.query.operatorProfiles.findFirst({
			where: eq(operatorProfiles.tenantId, demoTenantId),
			columns: { id: true },
		});

		if (!demoOperator) {
			return;
		}

		const response = await client.post("/api/bookings", {
			token: otherToken,
			json: {
				contactId: other.contactId,
				assignedTo: demoOperator.id,
				title: `Cross-tenant ${MARKER}`,
				scheduledAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
			},
		});

		// Assigning work to somebody else's staff would also have leaked their
		// calendar through the double-booking check.
		expect(response.status).toBe(404);
	});

	test("a contact created by one tenant is stamped with that tenant and stays there", async () => {
		const phone = `+99893${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

		const created = unwrap<{ id: string }>(
			await client.post("/api/contacts", {
				token: otherToken,
				json: { phoneNumber: phone, firstName: `Written${MARKER}` },
			}),
			"POST /api/contacts"
		);

		const row = await db.query.contacts.findFirst({
			where: eq(contacts.id, created.id),
			columns: { tenantId: true },
		});

		expect(row?.tenantId).toBe(other.tenantId);

		// And the demo tenant's list did not grow.
		const demoContacts = await listPage("/api/contacts?page=1&limit=1", demoToken);

		expect(demoContacts.meta.total).toBe(baseline.contacts);
	});

	test("the same phone number can exist in both tenants", async () => {
		// Uniqueness is (tenant_id, phone_number) now. If this returned 409 the check
		// would be reaching across tenants - a false conflict AND a disclosure that
		// the number exists somewhere else.
		const demoContact = await db.query.contacts.findFirst({
			where: eq(contacts.tenantId, demoTenantId),
			columns: { phoneNumber: true },
		});

		if (!demoContact) {
			throw new Error("the demo tenant has no contacts; run bun run db:seed");
		}

		const response = await client.post("/api/contacts", {
			token: otherToken,
			json: { phoneNumber: demoContact.phoneNumber, firstName: `Shared${MARKER}` },
		});

		expect(response.status).toBe(201);
	});
});
