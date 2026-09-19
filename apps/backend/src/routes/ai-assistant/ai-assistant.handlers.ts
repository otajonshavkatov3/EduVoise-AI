import type { UserRoleType } from "@shared/types";
import type { SQL } from "drizzle-orm";
import { and, asc, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
	aiAnalyses,
	aiSessions,
	calls,
	callTranscripts,
	callTransfers,
	contacts,
	operatorProfiles,
} from "@/db/schema";
import {
	KNOWN_GEMINI_VOICES,
	probeProviderHealth,
	synthesizeVoiceSample,
	VoiceSampleError,
} from "@/lib/ai";
import { getActiveAgentProfile } from "@/lib/ai-agent";
import { buildSessionCostView, loadRates } from "@/lib/ai-cost";
import { audit } from "@/lib/audit";
import { requireRoles } from "@/lib/auth";
import { businessError, invalidInput, notFound, rateLimitExceeded } from "@/lib/errors";
import { getCallOrchestrator } from "@/lib/telephony";
import { currentTenantId, type TenantId, tenantWhere } from "@/lib/tenancy";
import type { AppRouteHandler, AuthUser } from "@/lib/types";
import type * as r from "./ai-assistant.routes";
import {
	applyAiConfigPatch,
	type EffectiveAiConfig,
	getEffectiveAiConfig,
} from "./ai-assistant.runtime";
import type { AiSessionCost, AiSessionItem, AiSessionTranscriptLine } from "./ai-assistant.schemas";

/** Only a supervisor may change how the agent behaves. */
const ALLOWED_CONFIG_ROLES: UserRoleType[] = ["supervisor"];
/** Admin and supervisor see every session; a manager sees their own calls. */
const CAN_SEE_ALL_SESSIONS: UserRoleType[] = ["admin", "supervisor"];
/** A single call's transcript is bounded so one request cannot read a novel. */
const MAX_TRANSCRIPT_LINES = 2000;

const sessionColumns = {
	id: aiSessions.id,
	callId: aiSessions.callId,
	channelId: aiSessions.channelId,
	provider: aiSessions.provider,
	model: aiSessions.model,
	voice: aiSessions.voice,
	language: aiSessions.language,
	status: aiSessions.status,
	interruptions: aiSessions.interruptions,
	inputAudioMs: aiSessions.inputAudioMs,
	outputAudioMs: aiSessions.outputAudioMs,
	promptTokens: aiSessions.promptTokens,
	completionTokens: aiSessions.completionTokens,
	cachedPromptTokens: aiSessions.cachedPromptTokens,
	cachedAudioTokens: aiSessions.cachedAudioTokens,
	cachedTextTokens: aiSessions.cachedTextTokens,
	inputTextTokens: aiSessions.inputTextTokens,
	inputAudioTokens: aiSessions.inputAudioTokens,
	outputTextTokens: aiSessions.outputTextTokens,
	outputAudioTokens: aiSessions.outputAudioTokens,
	responseTurns: aiSessions.responseTurns,
	transcribeAudioTokens: aiSessions.transcribeAudioTokens,
	transcribeTextTokens: aiSessions.transcribeTextTokens,
	transcribeModel: aiSessions.transcribeModel,
	errorMessage: aiSessions.errorMessage,
	metadata: aiSessions.metadata,
	startedAt: aiSessions.startedAt,
	endedAt: aiSessions.endedAt,
	durationMs: aiSessions.durationMs,
	createdAt: aiSessions.createdAt,
	callDirection: calls.direction,
	callerNumber: calls.callerNumber,
	calleeExtension: calls.calleeExtension,
	callStatus: calls.status,
	callAiStatus: calls.aiStatus,
	callDuration: calls.duration,
	callTicketId: calls.ticketId,
	callOperatorId: calls.operatorId,
	callStartedAt: calls.startedAt,
	callEndedAt: calls.endedAt,
	contactId: contacts.id,
	contactPhoneNumber: contacts.phoneNumber,
	contactFirstName: contacts.firstName,
	contactLastName: contacts.lastName,
};

/**
 * ai_sessions joined to its call and (optionally) the matched contact.
 *
 * calls is an inner join because ai_sessions.call_id is NOT NULL, which is what
 * lets the response type the call as always present.
 *
 * THE TENANT IS ON ALL THREE TABLES, not just the driving one. This row carries a
 * caller's number, a contact's first and last name and the call's own history -
 * everything a leak here would be about - and the joins are where a one-sided
 * filter hides: `contacts` in particular is reached through calls.contact_id, and
 * an FK enforces nothing about tenants. Naming the tenant on every leg means a
 * mismatched child row yields no row (or a null contact) rather than a stranger's
 * name.
 */
function querySessions(tenantId: TenantId, where: SQL | undefined, limit: number, offset: number) {
	return db
		.select(sessionColumns)
		.from(aiSessions)
		.innerJoin(calls, and(eq(aiSessions.callId, calls.id), eq(calls.tenantId, tenantId)))
		.leftJoin(contacts, and(eq(calls.contactId, contacts.id), eq(contacts.tenantId, tenantId)))
		.where(tenantWhere(aiSessions, tenantId, where))
		.orderBy(desc(aiSessions.startedAt))
		.limit(limit)
		.offset(offset);
}

type SessionJoinRow = Awaited<ReturnType<typeof querySessions>>[number];

function toItem(row: SessionJoinRow, transcriptCount: number): AiSessionItem {
	return {
		id: row.id,
		callId: row.callId,
		channelId: row.channelId,
		provider: row.provider,
		model: row.model,
		voice: row.voice,
		language: row.language,
		status: row.status,
		interruptions: row.interruptions,
		inputAudioMs: row.inputAudioMs,
		outputAudioMs: row.outputAudioMs,
		promptTokens: row.promptTokens,
		completionTokens: row.completionTokens,
		cachedPromptTokens: row.cachedPromptTokens,
		inputTextTokens: row.inputTextTokens,
		inputAudioTokens: row.inputAudioTokens,
		outputTextTokens: row.outputTextTokens,
		outputAudioTokens: row.outputAudioTokens,
		responseTurns: row.responseTurns,
		transcribeAudioTokens: row.transcribeAudioTokens,
		transcribeTextTokens: row.transcribeTextTokens,
		transcribeModel: row.transcribeModel,
		errorMessage: row.errorMessage,
		startedAt: row.startedAt.toISOString(),
		endedAt: row.endedAt?.toISOString() ?? null,
		durationMs: row.durationMs,
		createdAt: row.createdAt.toISOString(),
		transcriptCount,
		call: {
			id: row.callId,
			direction: row.callDirection,
			callerNumber: row.callerNumber,
			calleeExtension: row.calleeExtension,
			status: row.callStatus,
			aiStatus: row.callAiStatus,
			duration: row.callDuration,
			ticketId: row.callTicketId,
			operatorId: row.callOperatorId,
			startedAt: row.callStartedAt.toISOString(),
			endedAt: row.callEndedAt?.toISOString() ?? null,
		},
		contact:
			row.contactId === null || row.contactPhoneNumber === null
				? null
				: {
						id: row.contactId,
						phoneNumber: row.contactPhoneNumber,
						firstName: row.contactFirstName,
						lastName: row.contactLastName,
					},
	};
}

/**
 * A manager may only see sessions for calls that are theirs: either the call
 * records them as the operator, or it was transferred to them.
 *
 * Returns undefined for the roles that see everything.
 */
async function buildScopeCondition(tenantId: TenantId, user: AuthUser): Promise<SQL | undefined> {
	if (CAN_SEE_ALL_SESSIONS.includes(user.role)) {
		// Undefined means "no ROLE narrowing". It never means "no tenant filter": the
		// tenant lives in querySessions() and in the count, so this returning undefined
		// cannot widen the result past the caller's own customer.
		return undefined;
	}

	const profile = await db.query.operatorProfiles.findFirst({
		where: tenantWhere(
			operatorProfiles,
			tenantId,
			eq(operatorProfiles.userId, user.id),
			eq(operatorProfiles.isDeleted, false)
		),
		columns: { id: true },
	});

	if (!profile) {
		// No operator profile means no call can belong to this user.
		return sql`false`;
	}

	// Both sub-queries are scoped as well. They produce the id list an IN runs
	// against, so an unscoped one would hand another tenant's call ids to the outer
	// filter - and because the outer query joins on call_id, those ids are exactly
	// what would select somebody else's session rows.
	const ownCalls = db
		.select({ id: calls.id })
		.from(calls)
		.where(tenantWhere(calls, tenantId, eq(calls.operatorId, profile.id)));
	const transferredCalls = db
		.select({ id: callTransfers.callId })
		.from(callTransfers)
		.where(tenantWhere(callTransfers, tenantId, eq(callTransfers.toOperatorId, profile.id)));

	return or(inArray(aiSessions.callId, ownCalls), inArray(aiSessions.callId, transferredCalls));
}

/** Stored transcript lines per call. ai_sessions is unique per call, so this is per session too. */
async function loadTranscriptCounts(
	tenantId: TenantId,
	callIds: string[]
): Promise<Map<string, number>> {
	if (callIds.length === 0) {
		return new Map();
	}

	const rows = await db
		.select({ callId: callTranscripts.callId, total: count() })
		.from(callTranscripts)
		.where(tenantWhere(callTranscripts, tenantId, inArray(callTranscripts.callId, callIds)))
		.groupBy(callTranscripts.callId);

	return new Map(rows.map((row) => [row.callId, Number(row.total)]));
}

// ===========================================
// GET /status
// ===========================================

export const statusHandler: AppRouteHandler<typeof r.status> = async (c) => {
	// The config first: it refreshes the process.env mirror the probe reads, so a
	// provider switched a second ago is probed as the new provider and not the old.
	const config = await getEffectiveAiConfig(currentTenantId(c));
	const health = await probeProviderHealth();
	const orchestrator = getCallOrchestrator();

	return c.json(
		{
			success: true as const,
			data: {
				provider: health.provider,
				available: health.available,
				detail: health.detail,
				enabled: config.enabled,
				model: config.model,
				voice: config.voice,
				language: config.language,
				apiKeyConfigured: config.apiKeyConfigured,
				agentExtension: config.agentExtension,
				orchestrator: {
					running: orchestrator.isRunning,
					activeCalls: orchestrator.activeCallCount,
				},
				checkedAt: new Date().toISOString(),
			},
		},
		200
	);
};

// ===========================================
// GET /config
// ===========================================

export const getConfigHandler: AppRouteHandler<typeof r.getConfig> = async (c) => {
	return c.json(
		{ success: true as const, data: await getEffectiveAiConfig(currentTenantId(c)) },
		200
	);
};

// ===========================================
// PATCH /config
// ===========================================

export const updateConfigHandler: AppRouteHandler<typeof r.updateConfig> = async (c) => {
	requireRoles(c, ALLOWED_CONFIG_ROLES);

	const body = c.req.valid("json");

	// An empty patch is a client bug, not a no-op to be reported as success. A
	// nested object counts as absent when it carries no field of its own, so
	// `{ "audio": {} }` is refused the same way `{}` is.
	const nested: (keyof typeof body)[] = ["gemini", "audio"];
	const hasNestedField = nested.some((key) => {
		const group = body[key];

		return group !== undefined && Object.keys(group).length > 0;
	});
	const hasField = Object.entries(body).some(
		([key, value]) => !nested.includes(key as keyof typeof body) && value !== undefined
	);

	if (!(hasField || hasNestedField)) {
		throw invalidInput("body", "o'zgartirish uchun kamida bitta maydon yuborilishi kerak");
	}

	const change = await applyAiConfigPatch(currentTenantId(c), body, c.get("user").id);

	await audit(c, {
		action: "ai-assistant.config.update",
		entityType: "ai_config",
		details: {
			changed: change.changed,
			requested: body,
			// The whole effective set, not three fields of it: this record is the only
			// place a later "who made the agent sound like that" question can be
			// answered from.
			before: pickAudited(change.before),
			after: pickAudited(change.after),
		},
	});

	c.var.logger.info(
		{ changed: change.changed, enabled: change.after.enabled, provider: change.after.provider },
		"AI configuration changed"
	);

	return c.json(
		{
			success: true as const,
			data: { config: change.after, changed: change.changed },
		},
		200
	);
};

/** The audited slice of a config: every value, no secrets (there are none here). */
function pickAudited(config: EffectiveAiConfig) {
	return {
		enabled: config.enabled,
		provider: config.providerKind,
		language: config.language,
		dialect: config.dialect,
		voice: config.voice,
		model: config.model,
		analysisModel: config.analysisModel,
		transcribeModel: config.transcribeModel,
		maxCallSeconds: config.maxCallSeconds,
		silenceHangupMs: config.silenceHangupMs,
		greetingDelayMs: config.greetingDelayMs,
		agentExtension: config.agentExtension,
		transferExtensions: config.transferExtensions,
		gemini: config.gemini,
		audio: config.audio,
	};
}

// ===========================================
// POST /voice-preview
// ===========================================

/** Spoken when the business profile has no greeting of its own yet. */
const DEFAULT_PREVIEW_TEXT = "Assalomu alaykum! Qo'ng'irog'ingiz uchun rahmat, sizni tinglayapman.";

/**
 * Render one line in one voice.
 *
 * Supervisor-only for two reasons: it is part of the settings screen, and every
 * uncached call spends one of the ten requests a minute Google allows this
 * project on the TTS model.
 */
export const voicePreviewHandler: AppRouteHandler<typeof r.voicePreview> = async (c) => {
	requireRoles(c, ALLOWED_CONFIG_ROLES);

	const body = c.req.valid("json");
	const config = await getEffectiveAiConfig(currentTenantId(c));

	if (config.providerKind !== "gemini") {
		throw businessError(
			"Ovoz namunasi faqat Gemini ovozlari uchun ishlaydi — hozirgi provayder OpenAI. " +
				"Namuna eshitish uchun provayderni Gemini ga o'tkazing."
		);
	}

	// The catalog decides, and it decides case-insensitively: "sulafat" typed by a
	// person is the voice they meant, but the API only answers to "Sulafat".
	const wanted = body.voice.trim().toLowerCase();
	const voice = KNOWN_GEMINI_VOICES.find((name) => name.toLowerCase() === wanted);

	if (voice === undefined) {
		throw invalidInput("voice", `«${body.voice}» — Gemini ovozlari ro'yxatida bunday ovoz yo'q`);
	}

	const profile = await getActiveAgentProfile(currentTenantId(c));
	const greeting = (profile.greeting ?? "").trim();
	const text = body.text ?? (greeting.length > 0 ? greeting : DEFAULT_PREVIEW_TEXT);

	try {
		const sample = await synthesizeVoiceSample(voice, text);

		return c.json({ success: true as const, data: sample }, 200);
	} catch (error) {
		throw translateSampleError(error);
	}
};

/** Every Google failure the owner can act on, said in Uzbek. */
function translateSampleError(error: unknown): Error {
	if (!(error instanceof VoiceSampleError)) {
		return error instanceof Error ? error : new Error(String(error));
	}

	if (error.kind === "no-key") {
		return businessError(
			"GOOGLE_AI_API_KEY .env da yo'q, shuning uchun ovoz namunasini tayyorlab bo'lmaydi."
		);
	}

	if (error.kind === "quota") {
		const wait =
			error.retryAfterSeconds === null
				? "Bir daqiqadan so'ng qayta urinib ko'ring."
				: `${error.retryAfterSeconds} soniyadan so'ng qayta urinib ko'ring.`;

		return rateLimitExceeded(
			`Google TTS chekloviga yetildi — bu model uchun daqiqasiga 10 ta so'rov. ${wait} ` +
				"Avval eshitilgan ovozlar keshdan darhol ijro etiladi."
		);
	}

	if (error.kind === "empty") {
		return businessError(
			"Model bu matn uchun audio qaytarmadi. Matnni qisqartirib yoki o'zgartirib ko'ring."
		);
	}

	return businessError(`Google TTS javob bermadi: ${error.message}`);
}

// ===========================================
// GET /sessions
// ===========================================

export const listSessionsHandler: AppRouteHandler<typeof r.listSessions> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const query = c.req.valid("query");
	const { page, limit } = query;
	const offset = (page - 1) * limit;

	// None of these is the tenant, deliberately: the tenant is applied by
	// querySessions() and by the count below, so no filter, sort or page offset here
	// can escape it - including `callId`, which is a client-supplied id and would
	// otherwise be the easy way to read one specific foreign session.
	const conditions: SQL[] = [];

	if (query.status) {
		conditions.push(eq(aiSessions.status, query.status));
	}
	if (query.provider) {
		conditions.push(eq(aiSessions.provider, query.provider));
	}
	if (query.callId) {
		conditions.push(eq(aiSessions.callId, query.callId));
	}
	if (query.from) {
		conditions.push(gte(aiSessions.startedAt, new Date(query.from)));
	}
	if (query.to) {
		conditions.push(lte(aiSessions.startedAt, new Date(query.to)));
	}

	const scope = await buildScopeCondition(tenantId, user);

	if (scope !== undefined) {
		conditions.push(scope);
	}

	const filters = conditions.length > 0 ? and(...conditions) : undefined;

	// The count is scoped the same way the page is, and the tenant is named at this
	// statement rather than shared in a variable: a count taken through a wider filter
	// than the rows would report a total the caller can never page to, and the number
	// itself would be a fact about other customers' traffic.
	const [rows, countRows] = await Promise.all([
		querySessions(tenantId, filters, limit, offset),
		db
			.select({ total: count() })
			.from(aiSessions)
			.where(tenantWhere(aiSessions, tenantId, filters)),
	]);

	const transcriptCounts = await loadTranscriptCounts(
		tenantId,
		rows.map((row) => row.callId)
	);
	const total = Number(countRows[0]?.total ?? 0);

	return c.json(
		{
			success: true as const,
			data: {
				items: rows.map((row) => toItem(row, transcriptCounts.get(row.callId) ?? 0)),
				meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
			},
		},
		200
	);
};

// ===========================================
// GET /sessions/{id}
// ===========================================

export const getSessionHandler: AppRouteHandler<typeof r.getSession> = async (c) => {
	const user = c.get("user");
	const tenantId = currentTenantId(c);
	const id = c.req.valid("param").id;

	const scope = await buildScopeCondition(tenantId, user);
	const where = scope === undefined ? eq(aiSessions.id, id) : and(eq(aiSessions.id, id), scope);
	// querySessions applies the tenant, so another tenant's session id yields no row
	// and this answers 404 - never 403, which would confirm the id exists elsewhere.
	const [row] = await querySessions(tenantId, where, 1, 0);

	if (row === undefined) {
		throw notFound("AI sessiya", id);
	}

	const [lines, countRows] = await Promise.all([
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
			.where(tenantWhere(callTranscripts, tenantId, eq(callTranscripts.callId, row.callId)))
			.orderBy(asc(callTranscripts.createdAt), asc(callTranscripts.startMs))
			.limit(MAX_TRANSCRIPT_LINES),
		db
			.select({ total: count() })
			.from(callTranscripts)
			.where(tenantWhere(callTranscripts, tenantId, eq(callTranscripts.callId, row.callId))),
	]);

	const transcriptCount = Number(countRows[0]?.total ?? 0);
	const transcript: AiSessionTranscriptLine[] = lines.map((line) => ({
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
				...toItem(row, transcriptCount),
				metadata: row.metadata,
				transcript,
				transcriptTruncated: transcriptCount > transcript.length,
				cost: await priceOneSession(tenantId, row),
			},
		},
		200
	);
};

/**
 * Price this session with the same arithmetic the cost page uses.
 *
 * Read-time pricing, exactly like /ai-costs: nothing is stored, so correcting a
 * rate re-prices this card too. Any role that can open the session may see its
 * cost - unlike the /ai-costs group, which is finance and is supervisor-only -
 * because this is one call the viewer already has access to, not the company's
 * spend.
 *
 * The flattening itself lives in lib/ai-cost so that this card and the call
 * detail page cannot drift into quoting different numbers for the same call.
 */
async function priceOneSession(tenantId: TenantId, row: SessionJoinRow): Promise<AiSessionCost> {
	const { rates } = await loadRates(tenantId);
	const [analysis] = await db
		.select({
			promptTokens: aiAnalyses.promptTokens,
			cachedPromptTokens: aiAnalyses.cachedPromptTokens,
			completionTokens: aiAnalyses.completionTokens,
			billedRuns: aiAnalyses.billedRuns,
		})
		.from(aiAnalyses)
		.where(tenantWhere(aiAnalyses, tenantId, eq(aiAnalyses.callId, row.callId)))
		.limit(1);

	return buildSessionCostView({
		tokens: {
			promptTokens: row.promptTokens,
			cachedPromptTokens: row.cachedPromptTokens,
			cachedAudioTokens: row.cachedAudioTokens,
			cachedTextTokens: row.cachedTextTokens,
			inputTextTokens: row.inputTextTokens,
			inputAudioTokens: row.inputAudioTokens,
			completionTokens: row.completionTokens,
			outputTextTokens: row.outputTextTokens,
			outputAudioTokens: row.outputAudioTokens,
			transcribeAudioTokens: row.transcribeAudioTokens,
			transcribeTextTokens: row.transcribeTextTokens,
		},
		provider: row.provider,
		analysis: analysis ?? null,
		rates,
		durationMs: row.durationMs,
	});
}
