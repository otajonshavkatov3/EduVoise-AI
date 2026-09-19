/**
 * THE ARI ENTRY POINT, end to end, with no Asterisk.
 *
 * An inbound call is the one write path in the platform with no request behind it:
 * StasisStart arrives on a WebSocket, and whatever the orchestrator decides at that
 * moment becomes the tenant of the `calls` row and of every row that hangs off it. The
 * two behaviours that matter are both here:
 *
 *   1. a channel that says which customer it belongs to gets a call row for THAT
 *      customer - the dialplan's word (a Stasis argument, a channel variable, a
 *      per-tenant context or a per-tenant endpoint) is what identifies it;
 *   2. a channel nobody can attribute is RELEASED. Not attributed to a guess, not
 *      attributed to the first tenant in the table: hung up with congestion, having
 *      written nothing. A caller hearing congestion is a bad minute; a caller recorded
 *      inside another company's account is the end of the business.
 *
 * The orchestrator is driven with a fake ARI, so this needs no carrier and no Asterisk -
 * but it does use the real database, because the row it writes is the whole point.
 *
 * SAFETY. One probe tenant, deleted in afterAll. Nothing belonging to the demo tenant is
 * written or read here.
 */
import type { TenantId } from "@shared/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { AudioSocketServer } from "../../apps/backend/src/lib/ai";
import type { AriEventStream } from "../../apps/backend/src/lib/asterisk";
import { db } from "../../apps/backend/src/db";
import {
	aiSessions,
	callNotes,
	callRecordings,
	calls,
	callTranscripts,
	contacts,
	tenants,
	users,
} from "../../apps/backend/src/db/schema";
import { CallOrchestrator } from "../../apps/backend/src/lib/telephony/call-orchestrator";
import type {
	AriClient,
	AsteriskChannel,
} from "../../apps/backend/src/lib/telephony/contracts";
import { invalidateTenantCache } from "../../apps/backend/src/lib/tenancy";

const MARKER = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const PROBE_SLUG = `inprobe-${MARKER}`.toLowerCase().slice(0, 40);
const CALLER = `99892${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

let probeTenantId: TenantId;

interface Internals {
	beginCall(channel: AsteriskChannel, args?: string[]): Promise<void>;
	calls: Map<string, { callId: string; tenantId: TenantId }>;
}

interface Fake {
	orchestrator: CallOrchestrator;
	internals: Internals;
	answered: string[];
	hangups: { channelId: string; cause: string }[];
}

function channel(id: string, context: string, callerNumber = CALLER): AsteriskChannel {
	return {
		id,
		name: `PJSIP/trunk-${id.slice(0, 8)}`,
		state: "Ring",
		caller: { number: callerNumber, name: "" },
		connected: { number: "", name: "" },
		dialplan: { context, exten: "101", priority: 1 },
		creationtime: "2026-08-14T09:00:00.000+0000",
		language: "uz",
	};
}

/**
 * An orchestrator whose ARI records what it was asked to do and refuses everything
 * beyond answering, so beginCall() stops right after the CRM row is written.
 */
function fakeOrchestrator(): Fake {
	const answered: string[] = [];
	const hangups: { channelId: string; cause: string }[] = [];

	const ari = {
		answer: async (channelId: string) => {
			answered.push(channelId);
			// Stops beginCall() before it launches a voice provider: everything this suite
			// asserts has already happened by now, and nothing here should reach Gemini.
			throw new Error("no Asterisk in this test");
		},
		hangup: async (channelId: string, cause: string) => {
			hangups.push({ channelId, cause });
		},
		originate: async () => {
			throw new Error("no Asterisk in this test");
		},
		destroyBridge: async () => undefined,
		setVariable: async () => undefined,
		playback: async () => undefined,
		stopPlayback: async () => undefined,
	} as unknown as AriClient;

	const orchestrator = new CallOrchestrator({
		ari,
		events: {
			on: () => () => undefined,
			start: () => undefined,
			stop: () => undefined,
		} as unknown as AriEventStream,
		audioSocket: {
			start: async () => ({ host: "127.0.0.1", port: 0 }),
			stop: async () => undefined,
			on: () => () => undefined,
		} as unknown as AudioSocketServer,
	});

	return {
		orchestrator,
		internals: orchestrator as unknown as Internals,
		answered,
		hangups,
	};
}

beforeAll(async () => {
	const [tenant] = await db
		.insert(tenants)
		.values({ name: `Inbound probe ${MARKER}`, slug: PROBE_SLUG, status: "trial" })
		.returning({ id: tenants.id });

	if (!tenant) {
		throw new Error("could not create the probe tenant");
	}

	probeTenantId = tenant.id;
	invalidateTenantCache();
});

afterAll(async () => {
	if (!probeTenantId) {
		return;
	}

	await db.delete(callRecordings).where(eq(callRecordings.tenantId, probeTenantId));
	await db.delete(callTranscripts).where(eq(callTranscripts.tenantId, probeTenantId));
	await db.delete(callNotes).where(eq(callNotes.tenantId, probeTenantId));
	await db.delete(aiSessions).where(eq(aiSessions.tenantId, probeTenantId));
	await db.delete(calls).where(eq(calls.tenantId, probeTenantId));
	await db.delete(contacts).where(eq(contacts.tenantId, probeTenantId));
	await db.delete(users).where(eq(users.tenantId, probeTenantId));
	await db.delete(tenants).where(eq(tenants.id, probeTenantId));
	invalidateTenantCache();
});

describe("an inbound channel is written to the customer it names", () => {
	test("a Stasis tenant argument decides the tenant of the call row and its contact", async () => {
		const fake = fakeOrchestrator();
		const channelId = `inbound-arg-${MARKER}`;

		await fake.internals.beginCall(channel(channelId, "from-external"), [
			`tenant=${PROBE_SLUG}`,
		]);

		// The channel was answered, so the call was accepted rather than released.
		expect(fake.answered).toEqual([channelId]);

		const rows = await db
			.select({ id: calls.id, tenantId: calls.tenantId, callerNumber: calls.callerNumber })
			.from(calls)
			.where(eq(calls.tenantId, probeTenantId));

		expect(rows.length).toBe(1);
		expect(rows[0]?.callerNumber).toBe(CALLER);

		// And the contact it created belongs to the same customer - this is the row that
		// would otherwise have been matched against, or created in, somebody else's CRM.
		const contactRows = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(eq(contacts.tenantId, probeTenantId));

		expect(contactRows.length).toBe(1);
	});

	test("the tenant's own dialplan context decides it too, with no argument at all", async () => {
		const fake = fakeOrchestrator();
		const channelId = `inbound-ctx-${MARKER}`;

		// This is what the per-tenant dialplan will actually look like:
		// [from-external-<slug>] with a plain Stasis() line.
		await fake.internals.beginCall(channel(channelId, `from-external-${PROBE_SLUG}`));

		expect(fake.answered).toEqual([channelId]);

		const rows = await db
			.select({ id: calls.id })
			.from(calls)
			.where(eq(calls.tenantId, probeTenantId));

		// Two calls now: this one and the previous test's.
		expect(rows.length).toBe(2);
	});
});

describe("a channel nobody can attribute is released, not guessed at", () => {
	test("an unknown tenant slug writes no call row and hangs the channel up", async () => {
		const fake = fakeOrchestrator();
		const channelId = `inbound-unknown-${MARKER}`;
		const before = await db.select({ id: calls.id }).from(calls);

		await fake.internals.beginCall(channel(channelId, "from-external-nosuchtenant-x"), []);

		const after = await db.select({ id: calls.id }).from(calls);

		// Nothing anywhere on the platform: not for this tenant, not for any other.
		expect(after.length).toBe(before.length);
		expect(fake.answered).toEqual([]);
		// Released with congestion, which is what the caller hears. The alternative - a call
		// filed against whichever tenant happened to be first - is the failure this whole
		// phase exists to prevent.
		expect(fake.hangups).toEqual([{ channelId, cause: "congestion" }]);
		expect(fake.orchestrator.activeCallCount).toBe(0);
	});

	test("the vendor's own tenant is not a call centre and cannot answer calls", async () => {
		const fake = fakeOrchestrator();
		const channelId = `inbound-vendor-${MARKER}`;
		const before = await db.select({ id: calls.id }).from(calls);

		await fake.internals.beginCall(channel(channelId, "from-external-vendor"), []);

		const after = await db.select({ id: calls.id }).from(calls);

		expect(after.length).toBe(before.length);
		expect(fake.hangups.map((entry) => entry.cause)).toEqual(["congestion"]);
	});
});
