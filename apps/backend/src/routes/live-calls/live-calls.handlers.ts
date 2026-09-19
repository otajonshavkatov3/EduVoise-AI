import type { UserRoleType } from "@shared/types";
import { count, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { aiSessions, calls, callTranscripts, operatorProfiles } from "@/db/schema";
import { notFound } from "@/lib/errors";
import type { LiveCallSnapshot } from "@/lib/telephony";
import { getCallOrchestrator } from "@/lib/telephony";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler, AuthUser } from "@/lib/types";

import type * as r from "./live-calls.routes";
import type { LiveCallItem, LiveTranscriptLine } from "./live-calls.schemas";

/** Admin and supervisor see the whole board; a manager sees their own calls. */
const CAN_SEE_ALL_CALLS: UserRoleType[] = ["admin", "supervisor"];

type CallRow = {
	id: string;
	status: "ringing" | "answered" | "missed" | "abandoned" | "completed";
	operatorId: string | null;
	ticketId: string | null;
};

type SessionRow = {
	id: string;
	callId: string;
	status: "initializing" | "active" | "transferring" | "completed" | "failed";
	provider: string;
	model: string | null;
	voice: string | null;
	language: string | null;
	interruptions: number;
	inputAudioMs: number;
	outputAudioMs: number;
	errorMessage: string | null;
	startedAt: Date;
	endedAt: Date | null;
};

/** Null means "no filtering", i.e. the user may see every live call. */
interface OperatorScope {
	profileId: string | null;
	extension: string | null;
}

async function resolveScope(user: AuthUser): Promise<OperatorScope | null> {
	if (CAN_SEE_ALL_CALLS.includes(user.role)) {
		return null;
	}

	const profile = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			user.tenantId,
			eq(operatorProfiles.userId, user.id),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: { id: true, extension: true },
	});

	return {
		profileId: profile?.id ?? null,
		extension: profile?.extension ?? null,
	};
}

/**
 * An AI-handled call has no operator until it is transferred, so ownership is
 * either the recorded operator_id or the extension the caller was handed to.
 */
function isVisible(
	scope: OperatorScope | null,
	operatorId: string | null,
	transferExtension: string | null
): boolean {
	if (scope === null) {
		return true;
	}

	if (scope.profileId !== null && operatorId === scope.profileId) {
		return true;
	}

	return scope.extension !== null && transferExtension === scope.extension;
}

function toAiSession(row: SessionRow | undefined) {
	if (row === undefined) {
		return null;
	}

	return {
		id: row.id,
		status: row.status,
		provider: row.provider,
		model: row.model,
		voice: row.voice,
		language: row.language,
		interruptions: row.interruptions,
		inputAudioMs: row.inputAudioMs,
		outputAudioMs: row.outputAudioMs,
		errorMessage: row.errorMessage,
		startedAt: row.startedAt.toISOString(),
		endedAt: row.endedAt?.toISOString() ?? null,
	};
}

function toItem(
	snapshot: LiveCallSnapshot,
	call: CallRow | undefined,
	session: SessionRow | undefined
): LiveCallItem {
	return {
		callId: snapshot.callId,
		channelId: snapshot.channelId,
		callerNumber: snapshot.callerNumber,
		direction: snapshot.direction,
		status: snapshot.status,
		callStatus: call?.status ?? null,
		provider: snapshot.provider,
		aiSessionId: snapshot.aiSessionId,
		aiSession: toAiSession(session),
		contact: snapshot.contact,
		isReturningCaller: snapshot.isReturningCaller,
		previousCallCount: snapshot.previousCallCount,
		ticketId: snapshot.ticketId ?? call?.ticketId ?? null,
		operatorId: call?.operatorId ?? null,
		transferExtension: snapshot.transferExtension,
		transferStatus: snapshot.transferStatus,
		startedAt: snapshot.startedAt,
		durationSeconds: snapshot.durationSeconds,
	};
}

async function loadCallRows(tenantId: TenantId, callIds: string[]): Promise<Map<string, CallRow>> {
	if (callIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			id: calls.id,
			status: calls.status,
			operatorId: calls.operatorId,
			ticketId: calls.ticketId,
		})
		.from(calls)
		.where(tenantWhere(calls, tenantId, inArray(calls.id, callIds)));

	return new Map(rows.map((row) => [row.id, row]));
}

async function loadSessionRows(
	tenantId: TenantId,
	callIds: string[]
): Promise<Map<string, SessionRow>> {
	if (callIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({
			id: aiSessions.id,
			callId: aiSessions.callId,
			status: aiSessions.status,
			provider: aiSessions.provider,
			model: aiSessions.model,
			voice: aiSessions.voice,
			language: aiSessions.language,
			interruptions: aiSessions.interruptions,
			inputAudioMs: aiSessions.inputAudioMs,
			outputAudioMs: aiSessions.outputAudioMs,
			errorMessage: aiSessions.errorMessage,
			startedAt: aiSessions.startedAt,
			endedAt: aiSessions.endedAt,
		})
		.from(aiSessions)
		.where(tenantWhere(aiSessions, tenantId, inArray(aiSessions.callId, callIds)));

	return new Map(rows.map((row) => [row.callId, row]));
}

export const listHandler: AppRouteHandler<typeof r.list> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const orchestrator = getCallOrchestrator();
	// The board is read from the orchestrator's in-memory map, which holds every
	// customer's live calls in one process - so the tenant filter is a parameter here
	// rather than a WHERE clause. Unscoped, this endpoint showed every supervisor on
	// the platform every other customer's callers in real time.
	const snapshots = orchestrator.listActiveCalls(tenantId);

	const [scope, callRows, sessionRows] = await Promise.all([
		resolveScope(user),
		loadCallRows(
			tenantId,
			snapshots.map((snapshot) => snapshot.callId)
		),
		loadSessionRows(
			tenantId,
			snapshots.map((snapshot) => snapshot.callId)
		),
	]);

	const items = snapshots
		.filter((snapshot) =>
			isVisible(
				scope,
				callRows.get(snapshot.callId)?.operatorId ?? null,
				snapshot.transferExtension
			)
		)
		.map((snapshot) =>
			toItem(snapshot, callRows.get(snapshot.callId), sessionRows.get(snapshot.callId))
		)
		.sort((left, right) => right.startedAt.localeCompare(left.startedAt));

	return c.json(
		{
			success: true as const,
			data: {
				items,
				total: items.length,
				orchestratorRunning: orchestrator.isRunning,
				scopedToOperator: scope !== null,
			},
		},
		200
	);
};

export const getHandler: AppRouteHandler<typeof r.get> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;
	const { transcriptLimit } = c.req.valid("query");

	// Another customer's live call answers 404, the same as one that is not live at
	// all: the orchestrator returns null for both, so existence is not disclosed.
	const snapshot = getCallOrchestrator().getActiveCall(tenantId, id);

	if (snapshot === null) {
		throw notFound("Jonli qo'ng'iroq", id);
	}

	const [scope, callRows, sessionRows, lines, transcriptCount] = await Promise.all([
		resolveScope(user),
		loadCallRows(tenantId, [id]),
		loadSessionRows(tenantId, [id]),
		db
			.select({
				id: callTranscripts.id,
				role: callTranscripts.role,
				content: callTranscripts.content,
				startMs: callTranscripts.startMs,
				endMs: callTranscripts.endMs,
				isFinal: callTranscripts.isFinal,
				confidence: callTranscripts.confidence,
				createdAt: callTranscripts.createdAt,
			})
			.from(callTranscripts)
			.where(tenantWhere(callTranscripts, tenantId, eq(callTranscripts.callId, id)))
			.orderBy(desc(callTranscripts.createdAt), desc(callTranscripts.startMs))
			.limit(transcriptLimit),
		db
			.select({ count: count() })
			.from(callTranscripts)
			.where(tenantWhere(callTranscripts, tenantId, eq(callTranscripts.callId, id))),
	]);

	const call = callRows.get(id);

	if (!isVisible(scope, call?.operatorId ?? null, snapshot.transferExtension)) {
		// Same shape as the calls endpoint: an invisible call is indistinguishable
		// from one that does not exist.
		throw notFound("Jonli qo'ng'iroq", id);
	}

	// Newest first from the database, so the window is the latest N lines; the
	// client wants them in speaking order.
	const transcript: LiveTranscriptLine[] = [...lines].reverse().map((line) => ({
		id: line.id,
		role: line.role,
		content: line.content,
		startMs: line.startMs,
		endMs: line.endMs,
		isFinal: line.isFinal,
		confidence: line.confidence,
		createdAt: line.createdAt.toISOString(),
	}));

	return c.json(
		{
			success: true as const,
			data: {
				...toItem(snapshot, call, sessionRows.get(id)),
				transcript,
				transcriptCount: Number(transcriptCount[0]?.count ?? 0),
			},
		},
		200
	);
};
