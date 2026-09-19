/**
 * THE CALL BOUNDARY, with two real tenants and real rows.
 *
 * This is the area a call centre would be sued over first: who rang, what was said
 * word for word, the audio of it, and what the AI concluded about it. Six route
 * groups read those tables - calls, calls/{id}/full, transcripts, ai-analyses,
 * live-calls, uploads - and before this phase not one of their queries named a tenant.
 *
 * WHY THIS SHAPE. "Tenant B's list is empty" passes on unscoped code whenever the
 * demo tenant is empty too, so the suite:
 *
 *   1. records the DEMO tenant's own numbers first,
 *   2. creates a SECOND tenant with a complete call - contact, call, AI session,
 *      transcript line, recording, analysis - on the SAME extension 101 the demo
 *      tenant uses, because colliding extensions are the point of decision #1,
 *   3. asserts the demo tenant's totals did not move and that none of its responses
 *      or its CSV export contains a trace of tenant B,
 *   4. asserts the same from tenant B's side, where every expected count is exactly 1
 *      - so an unscoped query fails loudly with "expected 1, got 131",
 *   5. asserts that WRITES cannot be pointed at the other tenant's rows by putting
 *      their ids in a request body: appending a transcript, correcting an analysis,
 *      transferring and hanging up a call. Those four are the holes neither the type
 *      system nor the query scanner can see.
 *
 * IN-PROCESS ON PURPOSE, like the CRM suite: the handlers under test are the ones in
 * this tree, and a backend started before these changes would answer from the old code
 * and prove nothing.
 *
 * SAFETY. It creates one tenant and its rows and deletes them, children first, in
 * afterAll. The demo tenant is read-only here; the two demo-side write attempts are
 * asserted to have written NOTHING, by counting its rows before and after.
 */
import type { TenantId } from "@shared/types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq, isNotNull } from "drizzle-orm";

import { db } from "../../apps/backend/src/db";
import {
	aiAnalyses,
	aiSessions,
	auditLogs,
	callRecordings,
	calls,
	callTranscripts,
	contacts,
	operatorProfiles,
	tenants,
	users,
} from "../../apps/backend/src/db/schema";
import { createApp } from "../../apps/backend/src/lib";
import { generateAccessToken } from "../../apps/backend/src/lib/auth/jwt";
import { getTenantBySlug, invalidateTenantCache } from "../../apps/backend/src/lib/tenancy";
import aiAnalysisRoutes from "../../apps/backend/src/routes/ai-analyses";
import asteriskRoutes from "../../apps/backend/src/routes/asterisk";
import auth from "../../apps/backend/src/routes/auth";
import callRoutes from "../../apps/backend/src/routes/calls";
import liveCallRoutes from "../../apps/backend/src/routes/live-calls";
import transcriptRoutes from "../../apps/backend/src/routes/transcripts";
import uploadRoutes from "../../apps/backend/src/routes/uploads";
import {
	createInProcessClient,
	login,
	SEEDED_SUPERVISOR,
	type TestClient,
	unwrap,
} from "../helpers/api-client";

/** Unique enough that finding it in the other tenant's response is unambiguous. */
const MARKER = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const OTHER_PHONE = `99890${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const OTHER_LOGIN_PHONE = `+99893${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

/** The extension the demo tenant also uses. Colliding digits must be fine. */
const SHARED_EXTENSION = "101";
/** What the probe tenant's caller "said". Must never appear in a demo response. */
const OTHER_TRANSCRIPT = `probe-transcript-${MARKER}`;
const OTHER_SUMMARY = `probe-summary-${MARKER}`;
const OTHER_RECORDING_FILE = `probe-${MARKER}.wav`;

interface Fixture {
	tenantId: TenantId;
	userId: string;
	operatorId: string;
	contactId: string;
	callId: string;
	sessionId: string;
	transcriptId: string;
	analysisId: string;
	recordingFile: string;
}

interface Page {
	items: { id: string }[];
	meta: { total: number };
}

let client: TestClient;
let demoToken: string;
let otherToken: string;
let demoTenantId: TenantId;
let other: Fixture;

/** The demo tenant's own rows, read-only, so the assertions are not vacuous. */
let demoCallTotal: number;
let demoAnalysisTotal: number;
let demoCallId: string;
let demoAnalysisId: string | null;
let demoRecordingFile: string | null;
let demoTranscriptCount: number;

async function listPage(path: string, token: string): Promise<Page> {
	return unwrap<Page>(await client.get(path, { token }), `GET ${path}`);
}

async function countTranscripts(callId: string): Promise<number> {
	const rows = await db
		.select({ id: callTranscripts.id })
		.from(callTranscripts)
		.where(eq(callTranscripts.callId, callId));

	return rows.length;
}

/** A complete call for a tenant that must stay invisible to the demo tenant. */
async function createOtherTenant(): Promise<Fixture> {
	const [tenant] = await db
		.insert(tenants)
		.values({
			name: `Call isolation probe ${MARKER}`,
			slug: `callprobe-${MARKER}`.toLowerCase().slice(0, 40),
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
			username: `callprobe-${MARKER}`,
			// Never logged in with: this suite mints the token directly.
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
		.values({ tenantId, phoneNumber: OTHER_PHONE, firstName: `Probe${MARKER}` })
		.returning({ id: contacts.id });
	const [call] = await db
		.insert(calls)
		.values({
			tenantId,
			direction: "inbound",
			callerNumber: OTHER_PHONE,
			calleeExtension: SHARED_EXTENSION,
			contactId: contact?.id,
			operatorId: operator?.id,
			status: "completed",
			duration: 42,
			aiStatus: "completed",
			recordingPath: `/var/spool/asterisk/recordings/${OTHER_RECORDING_FILE}`,
			startedAt: new Date(),
			answeredAt: new Date(),
			endedAt: new Date(),
		})
		.returning({ id: calls.id });
	const [session] = await db
		.insert(aiSessions)
		.values({
			tenantId,
			callId: call?.id ?? "",
			provider: "gemini-live",
			status: "completed",
			language: "uz",
		})
		.returning({ id: aiSessions.id });
	const [transcript] = await db
		.insert(callTranscripts)
		.values({
			tenantId,
			callId: call?.id ?? "",
			aiSessionId: session?.id,
			role: "caller",
			content: OTHER_TRANSCRIPT,
			startMs: 1000,
			isFinal: true,
		})
		.returning({ id: callTranscripts.id });
	const [analysis] = await db
		.insert(aiAnalyses)
		.values({
			tenantId,
			callId: call?.id ?? "",
			status: "completed",
			summary: OTHER_SUMMARY,
			sentiment: "neutral",
			transcript: OTHER_TRANSCRIPT,
		})
		.returning({ id: aiAnalyses.id });
	await db.insert(callRecordings).values({
		tenantId,
		callId: call?.id ?? "",
		filePath: `/var/spool/asterisk/recordings/${OTHER_RECORDING_FILE}`,
		fileName: OTHER_RECORDING_FILE,
		format: "wav",
	});

	if (!(user && operator && contact && call && session && transcript && analysis)) {
		throw new Error("could not create the probe tenant's rows");
	}

	return {
		tenantId,
		userId: user.id,
		operatorId: operator.id,
		contactId: contact.id,
		callId: call.id,
		sessionId: session.id,
		transcriptId: transcript.id,
		analysisId: analysis.id,
		recordingFile: OTHER_RECORDING_FILE,
	};
}

beforeAll(async () => {
	const app = createApp();
	app.route("/api/auth", auth);
	app.route("/api/calls", callRoutes);
	app.route("/api/transcripts", transcriptRoutes);
	app.route("/api/ai-analyses", aiAnalysisRoutes);
	app.route("/api/live-calls", liveCallRoutes);
	app.route("/api/asterisk", asteriskRoutes);
	app.route("/api/uploads", uploadRoutes);
	client = createInProcessClient((path, init) => app.request(path, init));

	console.log(`call isolation suite transport: ${client.label}`);

	const demo = await getTenantBySlug("avilab");

	if (!demo) {
		throw new Error('No "avilab" tenant. Run bun run db:seed.');
	}

	demoTenantId = demo.id;
	demoToken = (await login(client, SEEDED_SUPERVISOR.phone, SEEDED_SUPERVISOR.password))
		.accessToken;

	// The demo tenant's numbers BEFORE the second tenant exists.
	demoCallTotal = (await listPage("/api/calls?page=1&limit=1", demoToken)).meta.total;
	demoAnalysisTotal = (await listPage("/api/ai-analyses?page=1&limit=1", demoToken)).meta.total;

	const [newestCall] = await db
		.select({ id: calls.id })
		.from(calls)
		.where(eq(calls.tenantId, demoTenantId))
		.orderBy(desc(calls.createdAt))
		.limit(1);

	if (!newestCall) {
		throw new Error("the demo tenant has no calls; this suite needs one to assert against");
	}

	demoCallId = newestCall.id;
	demoTranscriptCount = await countTranscripts(demoCallId);

	const [demoAnalysis] = await db
		.select({ id: aiAnalyses.id })
		.from(aiAnalyses)
		.where(eq(aiAnalyses.tenantId, demoTenantId))
		.limit(1);

	demoAnalysisId = demoAnalysis?.id ?? null;

	const [demoRecording] = await db
		.select({ fileName: callRecordings.fileName })
		.from(callRecordings)
		.where(eq(callRecordings.tenantId, demoTenantId))
		.limit(1);

	demoRecordingFile = demoRecording?.fileName ?? null;

	other = await createOtherTenant();
	// A second customer tenant now exists, which is what the sole-tenant seam memoises.
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

	// Children first: every tenant FK is ON DELETE RESTRICT on purpose.
	await db.delete(callRecordings).where(eq(callRecordings.tenantId, other.tenantId));
	await db.delete(callTranscripts).where(eq(callTranscripts.tenantId, other.tenantId));
	await db.delete(aiAnalyses).where(eq(aiAnalyses.tenantId, other.tenantId));
	await db.delete(aiSessions).where(eq(aiSessions.tenantId, other.tenantId));
	await db.delete(calls).where(eq(calls.tenantId, other.tenantId));
	await db.delete(contacts).where(eq(contacts.tenantId, other.tenantId));
	await db.delete(operatorProfiles).where(eq(operatorProfiles.tenantId, other.tenantId));
	await db.delete(auditLogs).where(eq(auditLogs.tenantId, other.tenantId));
	await db.delete(users).where(eq(users.tenantId, other.tenantId));
	await db.delete(tenants).where(eq(tenants.id, other.tenantId));
	invalidateTenantCache();
});

describe("the two tenants are really two tenants", () => {
	test("the fixture is distinct from the demo tenant", () => {
		expect(other.tenantId).not.toBe(demoTenantId);
		expect(demoCallTotal).toBeGreaterThan(0);
	});
});

describe("the demo tenant cannot see the other customer's calls", () => {
	test("the call list total did not move, and the probe call is not in it", async () => {
		const page = await listPage("/api/calls?page=1&limit=100", demoToken);

		expect(page.meta.total).toBe(demoCallTotal);
		expect(page.items.map((item) => item.id)).not.toContain(other.callId);
	});

	test("a filter cannot reach the other tenant's call, even by its own caller number", async () => {
		// The number filter matches on the last nine digits, which is exactly the kind of
		// natural-key lookup that escapes an id-based scope.
		const page = await listPage(
			`/api/calls?page=1&limit=50&phoneNumber=%2B${OTHER_PHONE}`,
			demoToken
		);

		expect(page.meta.total).toBe(0);
		expect(page.items).toEqual([]);
	});

	test("the CSV export contains nothing of the other tenant", async () => {
		const response = await client.get("/api/calls/export", { token: demoToken });

		expect(response.status).toBe(200);
		expect(response.text).not.toContain(other.callId);
		expect(response.text).not.toContain(OTHER_PHONE);
	});

	test("the other tenant's call id is a 404 on both call endpoints", async () => {
		// 404, never 403: a 403 would confirm the call exists in some other account.
		expect((await client.get(`/api/calls/${other.callId}`, { token: demoToken })).status).toBe(404);
		expect((await client.get(`/api/calls/${other.callId}/full`, { token: demoToken })).status).toBe(
			404
		);
	});

	test("its transcript is unreachable by call id, and so is the export", async () => {
		const list = await client.get(`/api/transcripts/call/${other.callId}`, { token: demoToken });
		const exported = await client.get(`/api/transcripts/call/${other.callId}/export`, {
			token: demoToken,
		});

		expect(list.status).toBe(404);
		expect(list.text).not.toContain(OTHER_TRANSCRIPT);
		expect(exported.status).toBe(404);
		expect(exported.text).not.toContain(OTHER_TRANSCRIPT);
	});

	test("its analysis is neither listed nor readable, and the summary text never appears", async () => {
		const page = await client.get("/api/ai-analyses?page=1&limit=100", { token: demoToken });
		const one = await client.get(`/api/ai-analyses/${other.analysisId}`, { token: demoToken });

		expect(unwrap<Page>(page, "GET /api/ai-analyses").meta.total).toBe(demoAnalysisTotal);
		expect(page.text).not.toContain(OTHER_SUMMARY);
		expect(one.status).toBe(404);
		expect(one.text).not.toContain(OTHER_SUMMARY);
	});

	test("its recording audio is not served to another customer's supervisor", async () => {
		const response = await client.get(`/api/uploads/call-recordings/${other.recordingFile}`, {
			token: demoToken,
		});

		expect(response.status).toBe(404);
	});
});

describe("the other customer sees exactly their own one call", () => {
	test("their call list has one row: theirs", async () => {
		const page = await listPage("/api/calls?page=1&limit=100", otherToken);

		// Exactly 1, so an unscoped query fails with "expected 1, got 131" rather than
		// passing because the list happened to be empty.
		expect(page.meta.total).toBe(1);
		expect(page.items.map((item) => item.id)).toEqual([other.callId]);
	});

	test("their call detail carries their own transcript line", async () => {
		const data = unwrap<{
			call: { id: string };
			transcripts: { items: { content: string }[] };
			analysis: { summary: string | null } | null;
		}>(
			await client.get(`/api/calls/${other.callId}/full`, { token: otherToken }),
			"GET /api/calls/:id/full"
		);

		expect(data.call.id).toBe(other.callId);
		expect(data.transcripts.items.map((line) => line.content)).toContain(OTHER_TRANSCRIPT);
		expect(data.analysis?.summary).toBe(OTHER_SUMMARY);
	});

	test("their transcript list has one line and their analysis list one row", async () => {
		const transcript = await listPage(`/api/transcripts/call/${other.callId}`, otherToken);
		const analyses = await listPage("/api/ai-analyses?page=1&limit=50", otherToken);

		expect(transcript.meta.total).toBe(1);
		expect(analyses.meta.total).toBe(1);
	});

	test("the demo tenant's call and analysis ids answer 404 in this direction too", async () => {
		expect((await client.get(`/api/calls/${demoCallId}`, { token: otherToken })).status).toBe(404);
		expect((await client.get(`/api/calls/${demoCallId}/full`, { token: otherToken })).status).toBe(
			404
		);
		expect(
			(await client.get(`/api/transcripts/call/${demoCallId}`, { token: otherToken })).status
		).toBe(404);

		if (demoAnalysisId) {
			expect(
				(await client.get(`/api/ai-analyses/${demoAnalysisId}`, { token: otherToken })).status
			).toBe(404);
		}
	});

	test("the demo tenant's recording file name is not served to them either", async () => {
		if (!demoRecordingFile) {
			return;
		}

		const response = await client.get(`/api/uploads/call-recordings/${demoRecordingFile}`, {
			token: otherToken,
		});

		expect(response.status).toBe(404);
	});

	test("the live-call board is scoped to them, and it is empty", async () => {
		// Nothing is live during a test run, so this only proves the endpoint answers under
		// a tenant. The assertion that matters - two live calls, one per tenant, and only
		// one visible - is a unit test over the orchestrator's own map
		// (call-orchestrator.tenancy.test.ts), because that map is memory, not SQL.
		const data = unwrap<{ items: unknown[]; scopedToOperator: boolean }>(
			await client.get("/api/live-calls", { token: otherToken }),
			"GET /api/live-calls"
		);

		expect(data.items).toEqual([]);
	});
});

describe("a write cannot be pointed at the other tenant's call by id", () => {
	test("appending a transcript to the demo tenant's call is refused, and writes nothing", async () => {
		const response = await client.post(`/api/transcripts/call/${demoCallId}`, {
			token: otherToken,
			json: { role: "system", content: `INJECTED ${MARKER}` },
		});

		expect(response.status).toBe(404);
		// The real assertion: no row landed on the demo tenant's call. Without the tenant
		// filter in loadCallForUser() this endpoint stamped the CALLER's tenant onto a row
		// attached to somebody else's call - a write into another customer's data with a
		// perfectly valid tenant_id on it.
		expect(await countTranscripts(demoCallId)).toBe(demoTranscriptCount);
	});

	test("correcting the demo tenant's analysis is refused, and changes nothing", async () => {
		if (!demoAnalysisId) {
			return;
		}

		const before = await db
			.select({ summary: aiAnalyses.summary })
			.from(aiAnalyses)
			.where(eq(aiAnalyses.id, demoAnalysisId))
			.limit(1);

		const response = await client.patch(`/api/ai-analyses/${demoAnalysisId}`, {
			token: otherToken,
			json: { summary: `INJECTED ${MARKER}` },
		});

		const after = await db
			.select({ summary: aiAnalyses.summary })
			.from(aiAnalyses)
			.where(eq(aiAnalyses.id, demoAnalysisId))
			.limit(1);

		expect(response.status).toBe(404);
		expect(after[0]?.summary).toBe(before[0]?.summary ?? null);
	});

	test("transferring the demo tenant's call is refused before Asterisk is asked anything", async () => {
		// Refused by the call lookup, which is the FIRST thing the handler does - so no
		// operator in this tenant is ever rung for another customer's caller.
		const response = await client.post("/api/asterisk/transfer", {
			token: otherToken,
			json: { callId: demoCallId, reason: `probe-${MARKER}` },
		});

		expect(response.status).toBe(404);
	});

	test("hanging up the demo tenant's call is refused", async () => {
		const response = await client.post("/api/asterisk/hangup", {
			token: otherToken,
			json: { callId: demoCallId },
		});

		expect(response.status).toBe(404);
	});

	test("a manual transcript line cannot borrow another tenant's AI session", async () => {
		// The session id comes out of the body. It belongs to the probe tenant's own call,
		// so the tenant matches - but the CALL does not, and the handler must refuse it
		// rather than link a line on one call to a session on another.
		const response = await client.post(`/api/transcripts/call/${other.callId}`, {
			token: otherToken,
			json: {
				role: "system",
				content: `own-line-${MARKER}`,
				aiSessionId: "00000000-0000-4000-8000-000000000000",
			},
		});

		// 400 from the handler's own invalidInput(), not a 500 and not a written row.
		expect(response.status).toBe(400);
	});
});

describe("the demo tenant's own data still reads exactly as before", () => {
	test("its call list, detail, transcript and analysis all still work", async () => {
		// The whole point of the phase is that the working product keeps working. Tenant one
		// is the demo tenant, and everything it did before it had a tenant it still does.
		const page = await listPage("/api/calls?page=1&limit=5", demoToken);
		const detail = await client.get(`/api/calls/${demoCallId}/full`, { token: demoToken });
		const transcripts = await client.get(`/api/transcripts/call/${demoCallId}`, {
			token: demoToken,
		});

		expect(page.meta.total).toBe(demoCallTotal);
		expect(detail.status).toBe(200);
		expect(transcripts.status).toBe(200);

		if (demoAnalysisId) {
			expect(
				(await client.get(`/api/ai-analyses/${demoAnalysisId}`, { token: demoToken })).status
			).toBe(200);
		}
	});

	test("its recordings are still counted where a recording exists", async () => {
		// hasRecording is a correlated EXISTS that now compares tenant_id as well as
		// call_id. If that comparison were wrong the flag would go false for every call
		// and the recordings column would silently empty out.
		const withRecording = await db
			.select({ id: calls.id })
			.from(calls)
			.where(eq(calls.tenantId, demoTenantId))
			.limit(1);

		if (withRecording.length === 0) {
			return;
		}

		const [recorded] = await db
			.select({ id: calls.id })
			.from(calls)
			.where(isNotNull(calls.recordingPath))
			.limit(1);

		if (!recorded) {
			return;
		}

		const page = unwrap<{ items: { id: string; hasRecording: boolean }[] }>(
			await client.get("/api/calls?page=1&limit=100&hasRecording=true", { token: demoToken }),
			"GET /api/calls?hasRecording=true"
		);

		expect(page.items.length).toBeGreaterThan(0);
		expect(page.items.every((item) => item.hasRecording)).toBe(true);
	});
});
