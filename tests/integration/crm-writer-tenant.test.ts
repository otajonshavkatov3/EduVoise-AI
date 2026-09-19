/**
 * THE WRITE PATH WITH NO REQUEST BEHIND IT.
 *
 * lib/telephony/crm-writer.ts is where the voice layer writes: the call row, the AI
 * session, every transcript line, the recording, the analysis. It is driven by ARI
 * events, so there is no token and no logged-in user - the tenant is an argument. Which
 * raises the question this file answers: what happens when that argument and the callId
 * disagree?
 *
 * The answer is "nothing is written", enforced twice over:
 *   - every UPDATE carries `tenant_id = $tenant` as its leading term, so it matches no
 *     row of another customer and reports `updated: false`;
 *   - every child INSERT takes its tenant from a subquery over the PARENT which requires
 *     the parent to be this tenant's, so a wrong callId yields NULL and the NOT NULL
 *     constraint refuses the row - the upsert path included, where the ON CONFLICT
 *     branch would otherwise have rewritten another customer's analysis in place.
 *
 * Both halves run against a real database, because both are database behaviour: a mock
 * would assert the shape of a query rather than what Postgres does with it.
 *
 * SAFETY. TWO probe tenants, deleted in afterAll. Every cross-tenant attempt is aimed at
 * the OTHER PROBE's call, never at the demo tenant's - the demo tenant is read-only here
 * (one read, asserting that its transcripts are invisible to a probe). Aiming writes at
 * real rows would be both unsafe and non-deterministic: a demo row can be locked by the
 * running backend, which is a hang rather than a result.
 */
import type { TenantId } from "@shared/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq, inArray } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import {
	aiAnalyses,
	aiSessions,
	callRecordings,
	calls,
	callTranscripts,
	contacts,
	tenants,
	users,
} from "../../apps/backend/src/db/schema";
import {
	appendTranscript,
	buildTranscriptText,
	createAiSession,
	createInboundCall,
	markCallEnded,
	saveRecording,
	writeAiAnalysis,
} from "../../apps/backend/src/lib/telephony";
import { getTenantBySlug, invalidateTenantCache } from "../../apps/backend/src/lib/tenancy";

const MARKER = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

/** Two customers of the platform. "Ours" writes; "theirs" is what it must not reach. */
let ourTenantId: TenantId;
let theirTenantId: TenantId;
let demoTenantId: TenantId;
let ourCallId: string;
let theirCallId: string;
let theirTranscriptCount: number;

/**
 * True when the work threw.
 *
 * Written as a catch rather than `expect(...).rejects.toThrow()` deliberately: the
 * rejection here is a DrizzleQueryError carrying the whole failed statement, and bun's
 * rejects matcher does not settle on the second such assertion in one file - the test
 * times out instead of failing, which is indistinguishable from a hang in the code under
 * test. What is being asserted is the same thing, visibly.
 */
async function refused(work: () => Promise<unknown>): Promise<boolean> {
	try {
		await work();

		return false;
	} catch {
		return true;
	}
}

async function transcriptCount(callId: string): Promise<number> {
	const rows = await db
		.select({ id: callTranscripts.id })
		.from(callTranscripts)
		.where(eq(callTranscripts.callId, callId));

	return rows.length;
}

async function createProbeTenant(suffix: string): Promise<TenantId> {
	const [tenant] = await db
		.insert(tenants)
		.values({
			name: `Writer probe ${suffix} ${MARKER}`,
			slug: `wprobe${suffix}-${MARKER}`.toLowerCase().slice(0, 40),
			status: "trial",
		})
		.returning({ id: tenants.id });

	if (!tenant) {
		throw new Error("could not create a probe tenant");
	}

	return tenant.id;
}

beforeAll(async () => {
	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	demoTenantId = demo.id;
	ourTenantId = await createProbeTenant("a");
	theirTenantId = await createProbeTenant("b");
	invalidateTenantCache();

	// The same entry point the orchestrator uses for an inbound channel, with the tenant
	// resolved from the channel (inbound-tenant.ts) passed in explicitly.
	ourCallId = (
		await createInboundCall({
			tenantId: ourTenantId,
			callerNumber: `99890${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
			channelId: `probe-a-${MARKER}`,
			direction: "inbound",
			calleeExtension: "101",
		})
	).callId;

	theirCallId = (
		await createInboundCall({
			tenantId: theirTenantId,
			callerNumber: `99891${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
			channelId: `probe-b-${MARKER}`,
			// The same extension digits as the other tenant's call, deliberately.
			calleeExtension: "101",
		})
	).callId;

	// Their call already has a transcript line and an analysis, so the cross-tenant
	// attempts below hit the paths that would REWRITE something: an existing row and an
	// ON CONFLICT branch, not just an empty table.
	await appendTranscript(theirTenantId, {
		callId: theirCallId,
		role: "caller",
		content: `their line ${MARKER}`,
		startMs: 100,
	});
	await writeAiAnalysis(theirTenantId, {
		callId: theirCallId,
		summary: `their summary ${MARKER}`,
		status: "completed",
	});
	await saveRecording(theirTenantId, {
		callId: theirCallId,
		filePath: `/var/spool/asterisk/recordings/their-${MARKER}.wav`,
	});

	theirTranscriptCount = await transcriptCount(theirCallId);
});

afterAll(async () => {
	const ids = [ourTenantId, theirTenantId].filter(Boolean);

	if (ids.length === 0) {
		return;
	}

	// Children first: every tenant FK is ON DELETE RESTRICT on purpose.
	await db.delete(callRecordings).where(inArray(callRecordings.tenantId, ids));
	await db.delete(callTranscripts).where(inArray(callTranscripts.tenantId, ids));
	await db.delete(aiAnalyses).where(inArray(aiAnalyses.tenantId, ids));
	await db.delete(aiSessions).where(inArray(aiSessions.tenantId, ids));
	await db.delete(calls).where(inArray(calls.tenantId, ids));
	await db.delete(contacts).where(inArray(contacts.tenantId, ids));
	await db.delete(users).where(inArray(users.tenantId, ids));
	await db.delete(tenants).where(inArray(tenants.id, ids));
	invalidateTenantCache();
});

describe("a call written from an ARI event belongs to the tenant it was resolved for", () => {
	test("the call row, its contact and its children all carry that tenant", async () => {
		const session = await createAiSession(ourTenantId, {
			callId: ourCallId,
			channelId: `probe-a-${MARKER}`,
			provider: "gemini-live",
		});
		const line = await appendTranscript(ourTenantId, {
			callId: ourCallId,
			aiSessionId: session.id,
			role: "caller",
			content: `our line ${MARKER}`,
			startMs: 500,
		});

		expect(line).not.toBeNull();

		const [call] = await db
			.select({ tenantId: calls.tenantId, contactId: calls.contactId })
			.from(calls)
			.where(eq(calls.id, ourCallId))
			.limit(1);
		const [storedSession] = await db
			.select({ tenantId: aiSessions.tenantId })
			.from(aiSessions)
			.where(eq(aiSessions.id, session.id))
			.limit(1);
		const [storedLine] = await db
			.select({ tenantId: callTranscripts.tenantId })
			.from(callTranscripts)
			.where(eq(callTranscripts.id, line?.id ?? ""))
			.limit(1);

		expect(call?.tenantId).toBe(ourTenantId);
		expect(storedSession?.tenantId).toBe(ourTenantId);
		// Read from the parent call inside the same statement that wrote the child, so a
		// child cannot land in a different tenant than the call it belongs to.
		expect(storedLine?.tenantId).toBe(ourTenantId);

		if (call?.contactId) {
			const [contact] = await db
				.select({ tenantId: contacts.tenantId })
				.from(contacts)
				.where(eq(contacts.id, call.contactId))
				.limit(1);

			expect(contact?.tenantId).toBe(ourTenantId);
		}
	});

	test("the transcript text reads back for its own tenant and is empty for any other", async () => {
		const own = await buildTranscriptText(ourTenantId, ourCallId);
		const foreign = await buildTranscriptText(theirTenantId, ourCallId);
		const demo = await buildTranscriptText(demoTenantId, ourCallId);

		expect(own.text).toContain(MARKER);
		// This text is what the summariser is fed and what ends up on
		// ai_analyses.transcript. Unscoped it would send one customer's conversation to the
		// model and file the result under another customer's call.
		expect(foreign.text).toBe("");
		expect(foreign.turnCount).toBe(0);
		expect(demo.text).toBe("");
	});

	test("their call is equally invisible from our side, on the same extension digits", async () => {
		const theirs = await buildTranscriptText(ourTenantId, theirCallId);

		expect(theirs.text).toBe("");
	});
});

describe("a callId from another tenant writes nothing", () => {
	test("appendTranscript is refused by the parent-ownership subquery", async () => {
		// The tenant argument is ours, the callId is theirs. The subquery that supplies
		// tenant_id requires BOTH to agree, so it yields NULL and NOT NULL rejects the
		// insert. Without that agreement the row would have landed on another customer's
		// call carrying a perfectly valid tenant_id of ours - a leak with no error anywhere.
		expect(
			await refused(() =>
				appendTranscript(ourTenantId, {
					callId: theirCallId,
					role: "system",
					content: `INJECTED ${MARKER}`,
				})
			)
		).toBe(true);

		expect(await transcriptCount(theirCallId)).toBe(theirTranscriptCount);
	});

	test("writeAiAnalysis is refused even where a row exists to be overwritten", async () => {
		const before = await db
			.select({ summary: aiAnalyses.summary, retryCount: aiAnalyses.retryCount })
			.from(aiAnalyses)
			.where(eq(aiAnalyses.callId, theirCallId))
			.limit(1);

		// Their analysis exists, so this takes the ON CONFLICT branch - the one that would
		// have UPDATED their row in place, leaving their tenant_id intact and their
		// summary replaced by ours. Postgres checks NOT NULL on the proposed row first, so
		// the whole statement fails instead.
		expect(
			await refused(() =>
				writeAiAnalysis(ourTenantId, {
					callId: theirCallId,
					summary: `INJECTED ${MARKER}`,
					status: "failed",
				})
			)
		).toBe(true);

		const after = await db
			.select({
				summary: aiAnalyses.summary,
				retryCount: aiAnalyses.retryCount,
				tenantId: aiAnalyses.tenantId,
			})
			.from(aiAnalyses)
			.where(eq(aiAnalyses.callId, theirCallId))
			.limit(1);

		expect(after[0]?.summary).toBe(before[0]?.summary ?? null);
		expect(after[0]?.retryCount).toBe(before[0]?.retryCount ?? 0);
		expect(after[0]?.tenantId).toBe(theirTenantId);
	});

	test("their call's ai_status is not moved by our analysis attempt", async () => {
		const [call] = await db
			.select({ aiStatus: calls.aiStatus })
			.from(calls)
			.where(eq(calls.id, theirCallId))
			.limit(1);

		// writeAiAnalysis also writes calls.ai_status. That UPDATE is tenant-scoped, and the
		// insert above never got far enough to reach it.
		expect(call?.aiStatus).toBe("completed");
	});

	test("saveRecording is refused, and their recording pointer is untouched", async () => {
		const [before] = await db
			.select({ recordingPath: calls.recordingPath })
			.from(calls)
			.where(eq(calls.id, theirCallId))
			.limit(1);

		expect(
			await refused(() =>
				saveRecording(ourTenantId, {
					callId: theirCallId,
					filePath: `/var/spool/asterisk/recordings/injected-${MARKER}.wav`,
				})
			)
		).toBe(true);

		const [after] = await db
			.select({ recordingPath: calls.recordingPath })
			.from(calls)
			.where(eq(calls.id, theirCallId))
			.limit(1);
		const rows = await db
			.select({ id: callRecordings.id })
			.from(callRecordings)
			.where(eq(callRecordings.callId, theirCallId));

		expect(after?.recordingPath).toBe(before?.recordingPath ?? null);
		// One recording: theirs. Not a second row filed under our tenant.
		expect(rows.length).toBe(1);
	});

	test("markCallEnded reports no update rather than finalising their call", async () => {
		// An UPDATE with a tenant term simply matches nothing - no error, no row. This is
		// the one that would have been a BILLING error as well as a data one: calls.duration
		// is what the minute ledger gets reconstructed from.
		const result = await markCallEnded(ourTenantId, theirCallId, {
			status: "completed",
			durationSeconds: 9999,
		});

		expect(result.updated).toBe(false);

		const [after] = await db
			.select({ endedAt: calls.endedAt, duration: calls.duration })
			.from(calls)
			.where(eq(calls.id, theirCallId))
			.limit(1);

		expect(after?.endedAt).toBeNull();
		expect(after?.duration).not.toBe(9999);
	});

	test("our own call still finalises normally", async () => {
		// The negative tests above are only worth anything if the positive path works: the
		// point of the phase is that a call still gets written exactly as it did before.
		const result = await markCallEnded(ourTenantId, ourCallId, {
			status: "completed",
			durationSeconds: 42,
		});

		expect(result.updated).toBe(true);
		expect(result.durationSeconds).toBe(42);

		const [row] = await db
			.select({ status: calls.status, duration: calls.duration, tenantId: calls.tenantId })
			.from(calls)
			.where(eq(calls.id, ourCallId))
			.limit(1);

		expect(row?.status).toBe("completed");
		expect(row?.duration).toBe(42);
		expect(row?.tenantId).toBe(ourTenantId);
	});
});

describe("the demo tenant's own rows are only ever read here", () => {
	test("its newest call is still there, untouched, with its own tenant", async () => {
		const [demoCall] = await db
			.select({ id: calls.id, tenantId: calls.tenantId })
			.from(calls)
			.where(eq(calls.tenantId, demoTenantId))
			.orderBy(desc(calls.createdAt))
			.limit(1);

		expect(demoCall?.tenantId).toBe(demoTenantId);
	});
});
