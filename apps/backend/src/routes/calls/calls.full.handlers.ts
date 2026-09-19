/**
 * GET /calls/{id}/full - one request that answers "everything about this call".
 *
 * WHY A NEW PATH RATHER THAN A BIGGER GET /calls/{id}
 *
 * The detail page needed five round trips (the call, its transcripts, its
 * analysis, its AI session, and a cost figure that only existed on a
 * range-scoped endpoint), so one of the two had to happen. Extending
 * GET /calls/{id} was rejected because that response is already consumed by the
 * softphone's call-pop modal and by the call list's row expander, neither of
 * which renders a transcript: bolting a page-sized payload onto it would make
 * every cheap read pay for the expensive one. A separate operation also gets its
 * own OpenAPI schema, its own cache story, and - the part that mattered most -
 * its own rule about who may see the money, without touching a contract other
 * screens depend on.
 *
 * QUERY COUNT
 *
 * Fixed, and independent of how much happened on the call:
 *
 *   1  the call + contact + operator + operator's user + ticket + analysis
 *      + AI session, in one row (every one of those is at most 1:1 with a call;
 *      ai_analyses and ai_sessions are unique on call_id)
 *   1  the caller's own operator profile - ONLY for a manager, whose access has
 *      to be checked against it
 *   6  transcripts, recordings, transfers, follow-ups, bookings, notes - issued
 *      concurrently after the access check passes
 *   0  the rate table, which lib/settings keeps in an in-process cache (1 on a
 *      cold start)
 *
 * So 7 for a supervisor or admin, 8 for a manager reading their own call. There
 * is no per-row lookup anywhere: names are resolved by joining, not by looping.
 */
import type { UserRoleType } from "@shared/types";
import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
	aiAnalyses,
	aiSessions,
	bookings,
	callNotes,
	callRecordings,
	calls,
	callTranscripts,
	callTransfers,
	contacts,
	followUpTasks,
	operatorProfiles,
	tickets,
	users,
} from "@/db/schema";
import {
	type AnalysisTokens,
	buildSessionCostView,
	loadRates,
	NO_SESSION_TOKENS,
	type SessionCostView,
	type SessionTokens,
} from "@/lib/ai-cost";
import { notFound } from "@/lib/errors";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler } from "@/lib/types";
import type {
	CallFullActions,
	CallFullRecording,
	CallFullTranscriptLine,
	FullQuery,
} from "./calls.full.schemas";
import type * as r from "./calls.routes";

/** Admin and supervisor read every call; a manager reads only their own. */
const CAN_SEE_ALL_CALLS: UserRoleType[] = ["admin", "supervisor"];

/**
 * Who may see what the call cost.
 *
 * The same two roles /ai-costs is gated to. Spend is business finance, and a
 * manager who is refused the cost page must not be able to read the identical
 * figure by opening one of their own calls - that would make the restriction
 * decorative rather than real.
 */
const CAN_SEE_COST: UserRoleType[] = ["admin", "supervisor"];

/** One call's transcript is bounded so a single request cannot read a novel. */
const MAX_TRANSCRIPT_LINES = 2000;

/**
 * A bound on each action list. Far above anything a real call produces (the
 * busiest call in this deployment has one transfer), but a page must not be able
 * to turn into an unbounded read because a retry loop wrote ten thousand notes.
 */
const MAX_ACTION_ROWS = 200;

const MS_PER_SECOND = 1000;

// ===========================================
// Pure helpers (exported for the unit tests)
// ===========================================

/**
 * A person's display name.
 *
 * `users.username` is nullable, so the phone number is the fallback - it is the
 * login identity here and is always present. Never the uuid: the detail page
 * used to print one under the "Operator" label.
 */
export function displayName(username: string | null, phone: string | null): string {
	const trimmed = username?.trim();

	if (trimmed) {
		return trimmed;
	}

	return phone?.trim() || "Noma'lum";
}

/**
 * Where the browser fetches a recording from, as a path relative to the API root.
 *
 * `calls.recording_path` arrives in three shapes and one route serves all of them:
 *   - a browser upload, already `/uploads/call-recordings/<file>`
 *   - MixMonitor's own path for a call after tenancy,
 *     `/var/spool/asterisk/recordings/<slug>/<calls.id>.wav`
 *   - the same from before tenancy, with no tenant directory
 *
 * THE TENANT DIRECTORY IS CARRIED THROUGH, and that is the point of this function
 * rather than a bare basename: the recordings of two customers now live in two
 * directories, and a URL that dropped the directory would ask the server to find
 * the file by name alone - which is precisely the lookup that has no tenant in it.
 * A pre-tenancy path keeps producing exactly the URL it always did, so the demo
 * tenant's 130+ existing recordings keep playing.
 */
export function recordingUrl(filePath: string): string {
	if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
		return filePath;
	}

	if (filePath.startsWith("/uploads/call-recordings/")) {
		return filePath;
	}

	const directory = recordingTenantDirectory(filePath);
	const fileName = recordingFileName(filePath);

	return directory === null
		? `/uploads/call-recordings/${fileName}`
		: `/uploads/call-recordings/${directory}/${fileName}`;
}

/**
 * The tenant directory a stored recording path sits in, or null.
 *
 * Only ever the segment immediately before the file name, and only when it looks
 * like a tenant slug - anything else (a Windows drive, a date directory somebody
 * invented) is ignored rather than turned into a URL segment the serving route
 * would then have to defend against.
 */
export function recordingTenantDirectory(filePath: string): string | null {
	const parts = filePath.split(/[\\/]/).filter((part) => part.length > 0);
	const directory = parts.at(-2);
	const parent = parts.at(-3);

	// The tenant directory is the one INSIDE the recordings root, and the root is named
	// by the two settings that produce these paths - ASTERISK_RECORDINGS_DIR
	// ("/var/spool/asterisk/recordings") and RECORDINGS_DIR (".../call-recordings").
	// Requiring the parent to be one of them is what keeps a pre-tenancy path flat:
	// without it "/var/spool/asterisk/recordings/abc.wav" would read "recordings" as a
	// tenant slug and every existing recording would get an URL nothing serves.
	if (parent === undefined || !RECORDINGS_ROOT_NAMES.has(parent)) {
		return null;
	}

	if (directory === undefined || !TENANT_SLUG_PATTERN.test(directory)) {
		return null;
	}

	return directory;
}

/** Matches tenants_slug_format_chk, i.e. the only directory names we generate. */
const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
/** The last segment of either recordings root: container side, then host side. */
const RECORDINGS_ROOT_NAMES = new Set(["recordings", "call-recordings"]);

/** The last path segment, tolerating both separators. */
export function recordingFileName(filePath: string): string {
	const parts = filePath.split(/[\\/]/);

	return parts.at(-1) || filePath;
}

/** Whole seconds between two instants, or null when either end is missing. */
export function secondsBetween(from: Date | null, to: Date | null): number | null {
	if (from === null || to === null) {
		return null;
	}

	const delta = Math.round((to.getTime() - from.getTime()) / MS_PER_SECOND);

	// A negative gap means the clocks disagreed, which is not a duration.
	return delta >= 0 ? delta : null;
}

/**
 * The duration to divide the cost by.
 *
 * The session's own measurement where there is one: `calls.duration` also counts
 * ringing and the scripted greeting, which no model was billed for. Same rule as
 * the /ai-costs list, so the two pages report the same cost per minute.
 */
export function costDurationMs(
	sessionDurationMs: number | null,
	callDurationSeconds: number | null
): number | null {
	if (sessionDurationMs !== null && sessionDurationMs > 0) {
		return sessionDurationMs;
	}

	return callDurationSeconds !== null && callDurationSeconds > 0
		? callDurationSeconds * MS_PER_SECOND
		: null;
}

/** A follow-up is overdue when its due date has passed and it is still open. */
export function isOverdue(dueAt: Date | null, status: string, now: Date): boolean {
	if (dueAt === null) {
		return false;
	}

	return dueAt.getTime() < now.getTime() && (status === "open" || status === "in_progress");
}

export function countActions(actions: Omit<CallFullActions, "counts" | "isEmpty">) {
	return {
		tickets: actions.ticket === null ? 0 : 1,
		transfers: actions.transfers.length,
		followUps: actions.followUps.length,
		bookings: actions.bookings.length,
		notes: actions.notes.length,
	};
}

// ===========================================
// Queries
// ===========================================

/**
 * The call and everything that is at most one row per call.
 *
 * ai_analyses and ai_sessions are each unique on call_id, and contact, operator
 * and ticket are plain foreign keys, so this cannot fan out into duplicate rows.
 */
function queryCore(tenantId: TenantId, callId: string) {
	return (
		db
			.select({
				id: calls.id,
				direction: calls.direction,
				callerNumber: calls.callerNumber,
				calleeExtension: calls.calleeExtension,
				contactId: calls.contactId,
				operatorId: calls.operatorId,
				ticketId: calls.ticketId,
				status: calls.status,
				duration: calls.duration,
				recordingPath: calls.recordingPath,
				aiStatus: calls.aiStatus,
				startedAt: calls.startedAt,
				answeredAt: calls.answeredAt,
				endedAt: calls.endedAt,
				createdAt: calls.createdAt,

				contactRowId: contacts.id,
				contactPhone: contacts.phoneNumber,
				contactFirstName: contacts.firstName,
				contactLastName: contacts.lastName,

				operatorProfileId: operatorProfiles.id,
				operatorExtension: operatorProfiles.extension,
				operatorUsername: users.username,
				operatorPhone: users.phone,

				ticketRowId: tickets.id,
				ticketSubject: tickets.subject,
				ticketDescription: tickets.description,
				ticketCategory: tickets.category,
				ticketPriority: tickets.priority,
				ticketStatus: tickets.status,
				ticketExternalRefId: tickets.externalRefId,
				ticketCreatedAt: tickets.createdAt,
				ticketClosedAt: tickets.closedAt,

				analysisId: aiAnalyses.id,
				analysisStatus: aiAnalyses.status,
				analysisSummary: aiAnalyses.summary,
				analysisSentiment: aiAnalyses.sentiment,
				analysisCategories: aiAnalyses.categories,
				analysisConfidence: aiAnalyses.confidence,
				analysisErrorMessage: aiAnalyses.errorMessage,
				analysisRetryCount: aiAnalyses.retryCount,
				analysisTranscript: aiAnalyses.transcript,
				analysisProcessedAt: aiAnalyses.processedAt,
				analysisCreatedAt: aiAnalyses.createdAt,
				analysisPromptTokens: aiAnalyses.promptTokens,
				analysisCachedPromptTokens: aiAnalyses.cachedPromptTokens,
				analysisCompletionTokens: aiAnalyses.completionTokens,
				analysisBilledRuns: aiAnalyses.billedRuns,

				sessionId: aiSessions.id,
				sessionChannelId: aiSessions.channelId,
				sessionProvider: aiSessions.provider,
				sessionModel: aiSessions.model,
				sessionVoice: aiSessions.voice,
				sessionLanguage: aiSessions.language,
				sessionStatus: aiSessions.status,
				sessionInterruptions: aiSessions.interruptions,
				sessionInputAudioMs: aiSessions.inputAudioMs,
				sessionOutputAudioMs: aiSessions.outputAudioMs,
				sessionResponseTurns: aiSessions.responseTurns,
				sessionDurationMs: aiSessions.durationMs,
				sessionPromptTokens: aiSessions.promptTokens,
				sessionCompletionTokens: aiSessions.completionTokens,
				sessionCachedPromptTokens: aiSessions.cachedPromptTokens,
				sessionCachedAudioTokens: aiSessions.cachedAudioTokens,
				sessionCachedTextTokens: aiSessions.cachedTextTokens,
				sessionInputTextTokens: aiSessions.inputTextTokens,
				sessionInputAudioTokens: aiSessions.inputAudioTokens,
				sessionOutputTextTokens: aiSessions.outputTextTokens,
				sessionOutputAudioTokens: aiSessions.outputAudioTokens,
				sessionTranscribeAudioTokens: aiSessions.transcribeAudioTokens,
				sessionTranscribeTextTokens: aiSessions.transcribeTextTokens,
				sessionTranscribeModel: aiSessions.transcribeModel,
				sessionErrorMessage: aiSessions.errorMessage,
				sessionStartedAt: aiSessions.startedAt,
				sessionEndedAt: aiSessions.endedAt,
			})
			.from(calls)
			// Each join names the tenant as well as the key. The keys are consistent, so
			// this changes no row on this page - it is what stops a join from being the way
			// the scope is escaped, which is the one hole tenantWhere() cannot see into.
			.leftJoin(
				contacts,
				and(eq(calls.contactId, contacts.id), eq(contacts.tenantId, calls.tenantId))
			)
			.leftJoin(
				operatorProfiles,
				and(
					eq(calls.operatorId, operatorProfiles.id),
					eq(operatorProfiles.tenantId, calls.tenantId)
				)
			)
			.leftJoin(
				users,
				and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, calls.tenantId))
			)
			// A soft-deleted ticket is gone as far as every other screen is concerned.
			.leftJoin(
				tickets,
				and(
					eq(calls.ticketId, tickets.id),
					eq(tickets.isDeleted, false),
					eq(tickets.tenantId, calls.tenantId)
				)
			)
			.leftJoin(
				aiAnalyses,
				and(eq(aiAnalyses.callId, calls.id), eq(aiAnalyses.tenantId, calls.tenantId))
			)
			.leftJoin(
				aiSessions,
				and(eq(aiSessions.callId, calls.id), eq(aiSessions.tenantId, calls.tenantId))
			)
			.where(tenantWhere(calls, tenantId, eq(calls.id, callId)))
			.limit(1)
	);
}

type CoreRow = Awaited<ReturnType<typeof queryCore>>[number];

async function findMyOperatorProfileId(tenantId: TenantId, userId: string): Promise<string | null> {
	const [row] = await db
		.select({ id: operatorProfiles.id })
		.from(operatorProfiles)
		.where(
			tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.userId, userId),
				eq(operatorProfiles.isDeleted, false)
			)
		)
		.limit(1);

	return row?.id ?? null;
}

/**
 * The transcript, bounded, with the unbounded total in the same round trip.
 *
 * `count(*) over()` is evaluated before LIMIT, so the badge shows how many lines
 * the call really has even when the page is showing the first 2000 of them - and
 * it costs no second query.
 *
 * Ordered by startMs then createdAt, the same as GET /transcripts/call/{callId}.
 * A row with no startMs (one an operator typed in afterwards) sorts last, which
 * is where it belongs: it was not spoken during the call.
 */
async function queryTranscripts(tenantId: TenantId, callId: string, includeInterim: boolean) {
	return await db
		.select({
			id: callTranscripts.id,
			callId: callTranscripts.callId,
			aiSessionId: callTranscripts.aiSessionId,
			role: callTranscripts.role,
			content: callTranscripts.content,
			startMs: callTranscripts.startMs,
			endMs: callTranscripts.endMs,
			isFinal: callTranscripts.isFinal,
			confidence: callTranscripts.confidence,
			createdAt: callTranscripts.createdAt,
			total: sql<string>`count(*) over()`,
		})
		.from(callTranscripts)
		// The tenant leads, then the call. `includeInterim` only ever adds a narrowing
		// term, so no value of that query parameter can reach past the customer.
		.where(
			tenantWhere(
				callTranscripts,
				tenantId,
				eq(callTranscripts.callId, callId),
				includeInterim ? undefined : eq(callTranscripts.isFinal, true)
			)
		)
		.orderBy(asc(callTranscripts.startMs), asc(callTranscripts.createdAt))
		.limit(MAX_TRANSCRIPT_LINES);
}

function queryRecordings(tenantId: TenantId, callId: string) {
	return db
		.select({
			id: callRecordings.id,
			filePath: callRecordings.filePath,
			fileName: callRecordings.fileName,
			format: callRecordings.format,
			sizeBytes: callRecordings.sizeBytes,
			durationSeconds: callRecordings.durationSeconds,
			isAvailable: callRecordings.isAvailable,
			createdAt: callRecordings.createdAt,
		})
		.from(callRecordings)
		.where(tenantWhere(callRecordings, tenantId, eq(callRecordings.callId, callId)))
		.orderBy(asc(callRecordings.createdAt))
		.limit(MAX_ACTION_ROWS);
}

function queryTransfers(tenantId: TenantId, callId: string) {
	return db
		.select({
			id: callTransfers.id,
			toExtension: callTransfers.toExtension,
			toOperatorId: callTransfers.toOperatorId,
			toOperatorExtension: operatorProfiles.extension,
			toOperatorUsername: users.username,
			toOperatorPhone: users.phone,
			reason: callTransfers.reason,
			status: callTransfers.status,
			requestedAt: callTransfers.requestedAt,
			connectedAt: callTransfers.connectedAt,
			endedAt: callTransfers.endedAt,
		})
		.from(callTransfers)
		.leftJoin(
			operatorProfiles,
			and(
				eq(callTransfers.toOperatorId, operatorProfiles.id),
				eq(operatorProfiles.tenantId, callTransfers.tenantId)
			)
		)
		.leftJoin(
			users,
			and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, callTransfers.tenantId))
		)
		.where(tenantWhere(callTransfers, tenantId, eq(callTransfers.callId, callId)))
		.orderBy(asc(callTransfers.requestedAt))
		.limit(MAX_ACTION_ROWS);
}

function queryFollowUps(tenantId: TenantId, callId: string) {
	return db
		.select({
			id: followUpTasks.id,
			title: followUpTasks.title,
			description: followUpTasks.description,
			dueAt: followUpTasks.dueAt,
			status: followUpTasks.status,
			createdBySystem: followUpTasks.createdBySystem,
			ticketId: followUpTasks.ticketId,
			createdAt: followUpTasks.createdAt,
			completedAt: followUpTasks.completedAt,
			assigneeId: operatorProfiles.id,
			assigneeExtension: operatorProfiles.extension,
			assigneeUsername: users.username,
			assigneePhone: users.phone,
		})
		.from(followUpTasks)
		.leftJoin(
			operatorProfiles,
			and(
				eq(followUpTasks.assignedTo, operatorProfiles.id),
				eq(operatorProfiles.tenantId, followUpTasks.tenantId)
			)
		)
		.leftJoin(
			users,
			and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, followUpTasks.tenantId))
		)
		.where(tenantWhere(followUpTasks, tenantId, eq(followUpTasks.callId, callId)))
		.orderBy(asc(followUpTasks.createdAt))
		.limit(MAX_ACTION_ROWS);
}

function queryBookings(tenantId: TenantId, callId: string) {
	return db
		.select({
			id: bookings.id,
			title: bookings.title,
			notes: bookings.notes,
			scheduledAt: bookings.scheduledAt,
			durationMinutes: bookings.durationMinutes,
			location: bookings.location,
			status: bookings.status,
			createdBySystem: bookings.createdBySystem,
			ticketId: bookings.ticketId,
			createdAt: bookings.createdAt,
			assigneeId: operatorProfiles.id,
			assigneeExtension: operatorProfiles.extension,
			assigneeUsername: users.username,
			assigneePhone: users.phone,
		})
		.from(bookings)
		.leftJoin(
			operatorProfiles,
			and(
				eq(bookings.assignedTo, operatorProfiles.id),
				eq(operatorProfiles.tenantId, bookings.tenantId)
			)
		)
		.leftJoin(
			users,
			and(eq(operatorProfiles.userId, users.id), eq(users.tenantId, bookings.tenantId))
		)
		.where(tenantWhere(bookings, tenantId, eq(bookings.callId, callId)))
		.orderBy(asc(bookings.scheduledAt))
		.limit(MAX_ACTION_ROWS);
}

function queryNotes(tenantId: TenantId, callId: string) {
	return db
		.select({
			id: callNotes.id,
			authorType: callNotes.authorType,
			authorUserId: callNotes.authorUserId,
			authorUsername: users.username,
			authorPhone: users.phone,
			content: callNotes.content,
			createdAt: callNotes.createdAt,
			updatedAt: callNotes.updatedAt,
		})
		.from(callNotes)
		.leftJoin(
			users,
			and(eq(callNotes.authorUserId, users.id), eq(users.tenantId, callNotes.tenantId))
		)
		.where(tenantWhere(callNotes, tenantId, eq(callNotes.callId, callId)))
		.orderBy(asc(callNotes.createdAt))
		.limit(MAX_ACTION_ROWS);
}

// ===========================================
// Mapping
// ===========================================

function toCall(row: CoreRow) {
	const contactName =
		row.contactRowId === null
			? null
			: [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ") || null;

	return {
		id: row.id,
		direction: row.direction,
		callerNumber: row.callerNumber,
		calleeExtension: row.calleeExtension,
		contactId: row.contactId,
		contactName,
		operatorId: row.operatorId,
		ticketId: row.ticketId,
		status: row.status,
		duration: row.duration,
		recordingPath: row.recordingPath,
		aiStatus: row.aiStatus,
		startedAt: row.startedAt.toISOString(),
		answeredAt: row.answeredAt?.toISOString() ?? null,
		waitSeconds: secondsBetween(row.startedAt, row.answeredAt),
		endedAt: row.endedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		contact:
			row.contactRowId === null
				? null
				: {
						id: row.contactRowId,
						phoneNumber: row.contactPhone ?? "",
						firstName: row.contactFirstName,
						lastName: row.contactLastName,
					},
		operator:
			row.operatorProfileId === null
				? null
				: {
						id: row.operatorProfileId,
						phone: row.operatorPhone ?? "",
						username: row.operatorUsername,
						extension: row.operatorExtension,
					},
		operatorName:
			row.operatorProfileId === null ? null : displayName(row.operatorUsername, row.operatorPhone),
	};
}

/**
 * The recordings this call produced.
 *
 * `call_recordings` is the real source, but the legacy FreePBX call-end webhook
 * writes `calls.recording_path` and no row at all. Falling back to the column
 * keeps every recording the old page could play playable here - dropping it
 * would silently lose the browser-recorded calls.
 */
export function toRecordings(
	rows: {
		id: string;
		filePath: string;
		fileName: string;
		format: string;
		sizeBytes: number | null;
		durationSeconds: number | null;
		isAvailable: boolean;
		createdAt: Date;
	}[],
	fallbackPath: string | null
): CallFullRecording[] {
	if (rows.length > 0) {
		return rows.map((row) => ({
			id: row.id,
			fileName: row.fileName,
			url: recordingUrl(row.filePath),
			format: row.format,
			sizeBytes: row.sizeBytes,
			durationSeconds: row.durationSeconds,
			isAvailable: row.isAvailable,
			createdAt: row.createdAt.toISOString(),
		}));
	}

	if (!fallbackPath) {
		return [];
	}

	const fileName = recordingFileName(fallbackPath);

	return [
		{
			id: null,
			fileName,
			url: recordingUrl(fallbackPath),
			format: fileName.includes(".") ? (fileName.split(".").pop() ?? "wav") : "wav",
			sizeBytes: null,
			// Nothing measured this file, and reusing the call's duration would be a
			// different number wearing this one's label.
			durationSeconds: null,
			// Nothing ever stat'ed this path, so availability is an assumption either
			// way. Assume present, which is what the recordings page already did: the
			// player reports a genuinely missing file, whereas false would hide a
			// recording that plays fine.
			isAvailable: true,
			createdAt: null,
		},
	];
}

export function toTranscriptLine(row: {
	id: string;
	callId: string;
	aiSessionId: string | null;
	role: "caller" | "agent" | "system";
	content: string;
	startMs: number | null;
	endMs: number | null;
	isFinal: boolean;
	confidence: number | null;
	createdAt: Date;
}): CallFullTranscriptLine {
	return {
		id: row.id,
		callId: row.callId,
		aiSessionId: row.aiSessionId,
		role: row.role,
		content: row.content,
		startMs: row.startMs,
		endMs: row.endMs,
		isFinal: row.isFinal,
		confidence: row.confidence,
		createdAt: row.createdAt.toISOString(),
	};
}

function toAnalysis(row: CoreRow) {
	if (row.analysisId === null) {
		return null;
	}

	const transcript = row.analysisTranscript ?? "";

	return {
		id: row.analysisId,
		status: row.analysisStatus ?? "pending",
		summary: row.analysisSummary,
		sentiment: row.analysisSentiment,
		categories: row.analysisCategories,
		confidence: row.analysisConfidence,
		errorMessage: row.analysisErrorMessage,
		retryCount: row.analysisRetryCount ?? 0,
		hasTranscript: transcript.trim().length > 0,
		transcriptChars: transcript.length,
		processedAt: row.analysisProcessedAt?.toISOString() ?? null,
		createdAt: (row.analysisCreatedAt ?? row.createdAt).toISOString(),
	};
}

function toSession(row: CoreRow) {
	if (row.sessionId === null || row.sessionStartedAt === null) {
		return null;
	}

	return {
		id: row.sessionId,
		channelId: row.sessionChannelId,
		provider: row.sessionProvider ?? "",
		model: row.sessionModel,
		voice: row.sessionVoice,
		language: row.sessionLanguage,
		status: row.sessionStatus ?? "initializing",
		interruptions: row.sessionInterruptions ?? 0,
		inputAudioMs: row.sessionInputAudioMs ?? 0,
		outputAudioMs: row.sessionOutputAudioMs ?? 0,
		responseTurns: row.sessionResponseTurns,
		durationMs: row.sessionDurationMs,
		tokens: {
			promptTokens: row.sessionPromptTokens,
			cachedPromptTokens: row.sessionCachedPromptTokens,
			inputTextTokens: row.sessionInputTextTokens,
			inputAudioTokens: row.sessionInputAudioTokens,
			completionTokens: row.sessionCompletionTokens,
			outputTextTokens: row.sessionOutputTextTokens,
			outputAudioTokens: row.sessionOutputAudioTokens,
			transcribeAudioTokens: row.sessionTranscribeAudioTokens,
			transcribeTextTokens: row.sessionTranscribeTextTokens,
			transcribeModel: row.sessionTranscribeModel,
		},
		errorMessage: row.sessionErrorMessage,
		startedAt: row.sessionStartedAt.toISOString(),
		endedAt: row.sessionEndedAt?.toISOString() ?? null,
	};
}

/**
 * The token columns the pricing needs, named as queryCore aliases them.
 *
 * A structural slice of CoreRow rather than CoreRow itself, so the mapping can be
 * exercised without building a sixty-column join row.
 */
export interface SessionTokenColumns {
	sessionId: string | null;
	sessionPromptTokens: number | null;
	sessionCompletionTokens: number | null;
	sessionCachedPromptTokens: number | null;
	sessionCachedAudioTokens: number | null;
	sessionCachedTextTokens: number | null;
	sessionInputTextTokens: number | null;
	sessionInputAudioTokens: number | null;
	sessionOutputTextTokens: number | null;
	sessionOutputAudioTokens: number | null;
	sessionTranscribeAudioTokens: number | null;
	sessionTranscribeTextTokens: number | null;
}

export interface AnalysisTokenColumns {
	analysisId: string | null;
	analysisPromptTokens: number | null;
	analysisCachedPromptTokens: number | null;
	analysisCompletionTokens: number | null;
	analysisBilledRuns: number | null;
}

export function toSessionTokens(row: SessionTokenColumns): SessionTokens {
	if (row.sessionId === null) {
		return NO_SESSION_TOKENS;
	}

	return {
		promptTokens: row.sessionPromptTokens,
		cachedPromptTokens: row.sessionCachedPromptTokens,
		cachedAudioTokens: row.sessionCachedAudioTokens,
		cachedTextTokens: row.sessionCachedTextTokens,
		inputTextTokens: row.sessionInputTextTokens,
		inputAudioTokens: row.sessionInputAudioTokens,
		completionTokens: row.sessionCompletionTokens,
		outputTextTokens: row.sessionOutputTextTokens,
		outputAudioTokens: row.sessionOutputAudioTokens,
		transcribeAudioTokens: row.sessionTranscribeAudioTokens,
		transcribeTextTokens: row.sessionTranscribeTextTokens,
	};
}

/**
 * The summariser's counters, or null when the call was never analysed.
 *
 * `billedRuns` is NOT NULL with a default of 0, so a row always yields tokens;
 * priceAnalysis is the one that reads 0 runs as "unknown, not free".
 */
export function toAnalysisTokens(row: AnalysisTokenColumns): AnalysisTokens | null {
	if (row.analysisId === null) {
		return null;
	}

	return {
		promptTokens: row.analysisPromptTokens ?? 0,
		cachedPromptTokens: row.analysisCachedPromptTokens ?? 0,
		completionTokens: row.analysisCompletionTokens ?? 0,
		billedRuns: row.analysisBilledRuns ?? 0,
	};
}

function toTicket(row: CoreRow) {
	if (row.ticketRowId === null) {
		return null;
	}

	return {
		id: row.ticketRowId,
		subject: row.ticketSubject ?? "",
		description: row.ticketDescription ?? "",
		category: row.ticketCategory,
		priority: row.ticketPriority ?? "medium",
		status: row.ticketStatus ?? "new",
		externalRefId: row.ticketExternalRefId,
		createdAt: (row.ticketCreatedAt ?? row.createdAt).toISOString(),
		closedAt: row.ticketClosedAt?.toISOString() ?? null,
	};
}

// ===========================================
// Handler
// ===========================================

export const getFullHandler: AppRouteHandler<typeof r.getFull> = async (c) => {
	const user = c.get("user");
	const id = c.req.valid("param").id;
	const query = c.req.valid("query") as FullQuery;
	const includeInterim = query.includeInterim === "true";
	const seesEveryCall = CAN_SEE_ALL_CALLS.includes(user.role);
	const tenantId = currentTenantId(c);

	const [coreRows, myOperatorProfileId] = await Promise.all([
		queryCore(tenantId, id),
		seesEveryCall ? Promise.resolve(null) : findMyOperatorProfileId(tenantId, user.id),
	]);

	const core = coreRows[0];

	// Undefined covers both "no such call" and "another customer's call": queryCore
	// filters on the tenant, so the two are indistinguishable from here on.
	if (core === undefined) {
		throw notFound("Qo'ng'iroq", id);
	}

	// 404 rather than 403 for a call that is not theirs - the same choice
	// calls.handlers.ts makes, so the response does not confirm that some other
	// operator's call exists.
	if (!seesEveryCall && (myOperatorProfileId === null || core.operatorId !== myOperatorProfileId)) {
		throw notFound("Qo'ng'iroq", id);
	}

	const costVisible = CAN_SEE_COST.includes(user.role);

	const [transcriptRows, recordingRows, transferRows, followUpRows, bookingRows, noteRows] =
		await Promise.all([
			queryTranscripts(tenantId, id, includeInterim),
			queryRecordings(tenantId, id),
			queryTransfers(tenantId, id),
			queryFollowUps(tenantId, id),
			queryBookings(tenantId, id),
			queryNotes(tenantId, id),
		]);

	const now = new Date();
	const recordings = toRecordings(recordingRows, core.recordingPath);
	const transcriptTotal = Number(transcriptRows[0]?.total ?? 0);

	const actions: CallFullActions = (() => {
		const base = {
			ticket: toTicket(core),
			transfers: transferRows.map((row) => ({
				id: row.id,
				toExtension: row.toExtension,
				toOperator:
					row.toOperatorId === null
						? null
						: {
								id: row.toOperatorId,
								name: displayName(row.toOperatorUsername, row.toOperatorPhone),
								extension: row.toOperatorExtension,
							},
				reason: row.reason,
				status: row.status,
				requestedAt: row.requestedAt.toISOString(),
				connectedAt: row.connectedAt?.toISOString() ?? null,
				endedAt: row.endedAt?.toISOString() ?? null,
				waitSeconds: secondsBetween(row.requestedAt, row.connectedAt),
				talkSeconds: secondsBetween(row.connectedAt, row.endedAt),
			})),
			followUps: followUpRows.map((row) => ({
				id: row.id,
				title: row.title,
				description: row.description,
				dueAt: row.dueAt?.toISOString() ?? null,
				status: row.status,
				createdBySystem: row.createdBySystem,
				isOverdue: isOverdue(row.dueAt, row.status, now),
				assignee:
					row.assigneeId === null
						? null
						: {
								id: row.assigneeId,
								name: displayName(row.assigneeUsername, row.assigneePhone),
								extension: row.assigneeExtension,
							},
				ticketId: row.ticketId,
				createdAt: row.createdAt.toISOString(),
				completedAt: row.completedAt?.toISOString() ?? null,
			})),
			bookings: bookingRows.map((row) => ({
				id: row.id,
				title: row.title,
				notes: row.notes,
				scheduledAt: row.scheduledAt.toISOString(),
				endsAt: new Date(
					row.scheduledAt.getTime() + row.durationMinutes * 60 * MS_PER_SECOND
				).toISOString(),
				durationMinutes: row.durationMinutes,
				location: row.location,
				status: row.status,
				createdBySystem: row.createdBySystem,
				assignee:
					row.assigneeId === null
						? null
						: {
								id: row.assigneeId,
								name: displayName(row.assigneeUsername, row.assigneePhone),
								extension: row.assigneeExtension,
							},
				ticketId: row.ticketId,
				createdAt: row.createdAt.toISOString(),
			})),
			notes: noteRows.map((row) => ({
				id: row.id,
				authorType: row.authorType,
				author:
					row.authorUserId === null
						? null
						: {
								id: row.authorUserId,
								name: displayName(row.authorUsername, row.authorPhone),
							},
				content: row.content,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			})),
		};
		const counts = countActions(base);

		return {
			...base,
			counts,
			isEmpty: Object.values(counts).every((value) => value === 0),
		};
	})();

	const analysisTokens = toAnalysisTokens(core);
	let cost: SessionCostView | null = null;

	// Nothing to price when the call had neither an AI session nor an analysis, and
	// an object full of nulls would read as "we could not work it out" rather than
	// "no model ever ran on this call".
	if (costVisible && (core.sessionId !== null || analysisTokens !== null)) {
		const { rates } = await loadRates(tenantId);

		cost = buildSessionCostView({
			tokens: toSessionTokens(core),
			provider: core.sessionProvider ?? "",
			analysis: analysisTokens,
			rates,
			durationMs: costDurationMs(core.sessionDurationMs, core.duration),
		});
	}

	return c.json(
		{
			success: true as const,
			data: {
				call: toCall(core),
				recording: recordings[0] ?? null,
				recordings,
				transcripts: {
					items: transcriptRows.map(toTranscriptLine),
					total: transcriptTotal,
					truncated: transcriptTotal > transcriptRows.length,
					includesInterim: includeInterim,
				},
				analysis: toAnalysis(core),
				session: toSession(core),
				cost,
				costVisible,
				actions,
			},
		},
		200
	);
};
