/**
 * Every CRM write the AI voice layer can cause, in one module.
 *
 * The point of collecting them here is that an AI agent is an unreliable
 * narrator: it can call the same tool twice, hang up mid-write, or be torn down
 * by a timer while a write is in flight. So each function below is idempotent
 * wherever the data model allows it - "mark ended" only fires while `ended_at`
 * is null, "create a ticket for this call" returns the ticket the call already
 * has, the AI session row is upserted on its unique `call_id`. Teardown paths in
 * the orchestrator can therefore run twice without producing duplicates.
 *
 * Nothing here touches the legacy FreePBX webhook path; it keeps writing the
 * same `calls` rows through its own handlers.
 *
 * WHOSE CALL IS THIS. Every function here takes the tenant FIRST, and it is not
 * optional. That is the whole point of the change: these functions are called from
 * an ARI event rather than from an HTTP request, so there is no logged-in user to
 * take a tenant from, and "look it up from the id I was given" is exactly the read
 * that lets a bad id write into somebody else's account. The tenant is decided ONCE
 * per call - createInboundCall resolves it from the dialplan context the channel
 * arrived in (see inbound-tenant.ts) or from the campaign that asked for the dial -
 * carried on the ActiveCall for the length of the call, and passed down here.
 *
 * TWO FACTS THAT MUST AGREE. A child row (a transcript line, a recording, a note)
 * still takes its tenant from the parent row, in the same statement that writes it -
 * but the subquery now also requires the parent to belong to the tenant the caller
 * named (parentTenant* below). So a callId from the wrong tenant does not write a
 * row into the wrong tenant: the subquery is NULL and NOT NULL rejects the insert.
 * Neither half is trusted alone.
 */
import { isAbsolute, resolve } from "node:path";
import { getServerEnv } from "@shared/env";
import { asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import pino from "pino";
import pretty from "pino-pretty";
import { db } from "@/db";
import {
	aiAnalyses,
	aiSessions,
	bookings,
	callNotes,
	callRecordings,
	calls,
	callTranscripts,
	contacts,
	followUpTasks,
	operatorProfiles,
	tickets,
	users,
} from "@/db/schema";
import { databaseError, invalidInput, notFound } from "@/lib/errors";
import { type TenantId, tenantWhere } from "@/lib/tenancy";
import type { ContactAddress, ContactMatch } from "./contact-matcher";
import { findOrCreateContact } from "./contact-matcher";
import type { TranscriptRole, VoiceProviderStats } from "./contracts";

const isProduction = process.env.NODE_ENV === "production";

const logger = pino(
	{
		level: isProduction ? "info" : "debug",
		name: "telephony:crm-writer",
	},
	isProduction ? undefined : pretty({ colorize: true })
);

/** calls.caller_number and contacts.phone_number are both varchar(20). */
const PHONE_COLUMN_LIMIT = 20;
/**
 * calls.callee_extension is varchar(10). An inbound trunk call arrives on the
 * `_.` pattern in [from-external], so the dialled "extension" can be a full DID
 * that is longer than the column - which Postgres rejects outright rather than
 * truncating. Cutting it here keeps a long DID from failing the whole insert.
 */
const EXTENSION_COLUMN_LIMIT = 10;
/** tickets.subject, follow_up_tasks.title and bookings.title are varchar(255). */
const TITLE_COLUMN_LIMIT = 255;
/** What we store as the caller id when the trunk gives us no digits at all. */
const ANONYMOUS_CALLER = "anonymous";
const DEFAULT_BOOKING_MINUTES = 30;

// ===========================================
// Shared types
// ===========================================

export type CallStatus = "ringing" | "answered" | "missed" | "abandoned" | "completed";
export type CallDirection = "inbound" | "outbound";
export type TicketPriority = "low" | "medium" | "high";
export type AiStatus = "pending" | "processing" | "completed" | "failed";
export type Sentiment = "positive" | "neutral" | "negative";
export type AiSessionStatus = "initializing" | "active" | "transferring" | "completed" | "failed";
export type NoteAuthorType = "ai" | "operator" | "system";

// ===========================================
// Helpers
// ===========================================

/**
 * One place where a failed write is logged before it propagates.
 *
 * Failures are never swallowed: the orchestrator needs to know that a ticket was
 * not created so it can tell the caller, and the log line is what makes an
 * AI-caused write failure findable after the fact.
 */
async function run<T>(
	operation: string,
	context: Record<string, unknown>,
	work: () => Promise<T>
): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		logger.error({ err: cause, ...context }, `crm-writer: ${operation} failed`);
		throw cause;
	}
}

/**
 * `(select tenant_id from calls where id = $callId and tenant_id = $tenantId)`
 *
 * The tenant of the parent call, ONLY IF that call belongs to the tenant the caller
 * named. Same idea as lib/tenancy/derive.ts and the same atomicity - the value is
 * read by Postgres inside the statement that writes the child - with the ownership
 * check folded into the subquery, so it costs no extra round trip on the hot
 * transcript path. A mismatch yields NULL, and tenant_id NOT NULL turns that into a
 * rejected insert rather than a row filed under the wrong customer.
 */
function parentTenantOfCall(tenantId: TenantId, callId: string): SQL<TenantId> {
	return sql<TenantId>`(select ${calls.tenantId} from ${calls} where ${calls.id} = ${callId} and ${calls.tenantId} = ${tenantId})`;
}

/** The same rule for a ticket parent. */
function parentTenantOfTicket(tenantId: TenantId, ticketId: string): SQL<TenantId> {
	return sql<TenantId>`(select ${tickets.tenantId} from ${tickets} where ${tickets.id} = ${ticketId} and ${tickets.tenantId} = ${tenantId})`;
}

/** The same rule for a contact parent. */
function parentTenantOfContact(tenantId: TenantId, contactId: string): SQL<TenantId> {
	return sql<TenantId>`(select ${contacts.tenantId} from ${contacts} where ${contacts.id} = ${contactId} and ${contacts.tenantId} = ${tenantId})`;
}

/**
 * The tenant of whichever parent this row actually has, ownership-checked.
 *
 * Preference order is call, then ticket, then contact - the call is the most
 * specific parent and the one that carries the tenant the work was done for. The
 * caller's own validation guarantees at least one is present.
 */
function parentTenant(
	tenantId: TenantId,
	parents: { callId?: string | null; ticketId?: string | null; contactId?: string | null }
): SQL<TenantId> {
	if (parents.callId) {
		return parentTenantOfCall(tenantId, parents.callId);
	}

	if (parents.ticketId) {
		return parentTenantOfTicket(tenantId, parents.ticketId);
	}

	if (parents.contactId) {
		return parentTenantOfContact(tenantId, parents.contactId);
	}

	// Not reachable from a validated caller. Throwing beats inserting a row whose
	// tenant would have to be invented.
	throw new Error("Cannot derive a tenant: the row has no call, ticket or contact");
}

/** Trimmed text, or null for "the model gave us nothing usable". */
function cleanText(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function truncate(value: string, limit: number): string {
	return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * ai_analyses.confidence and tickets.ai_confidence are integers, but a model
 * reports confidence either as 0..1 or as 0..100. A value at or below 1 is read
 * as a fraction and scaled; everything else is clamped into 0..100.
 */
function normaliseConfidence(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}

	const percent = value > 0 && value <= 1 ? value * 100 : value;
	return Math.max(0, Math.min(100, Math.round(percent)));
}

function toWholeSeconds(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}

	return Math.max(0, Math.round(value));
}

/**
 * operator_profiles.id for a dialled extension, or null.
 *
 * Same lookup the legacy webhook does (extension + isDeleted = false), so an
 * AI-transferred call and a FreePBX-reported call attach to the same operator.
 *
 * SCOPED TO THE TENANT, and this is one of the two places where an unscoped lookup
 * would have been visible to a customer rather than merely wrong: "101" exists once
 * per customer, so the pre-tenancy query could attach ANOTHER customer's operator to
 * this call - putting a stranger's name on it and the call on that stranger's list.
 */
export async function resolveOperatorProfileIdByExtension(
	tenantId: TenantId,
	extension: string | null | undefined
): Promise<string | null> {
	const wanted = cleanText(extension);

	if (!wanted) {
		return null;
	}

	const [row] = await db
		.select({ id: operatorProfiles.id })
		.from(operatorProfiles)
		.where(
			tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.extension, wanted),
				eq(operatorProfiles.isDeleted, false)
			)
		)
		.limit(1);

	return row?.id ?? null;
}

/**
 * The operator behind an extension, as both ids the platform needs: the
 * operator_profiles row (what `calls.operator_id` stores) and the users row
 * (what the WebSocket registry fans events out by).
 *
 * The other half of the same danger: the userId returned here is who the live-call
 * WebSocket events are sent to. Unscoped, a transfer would have pushed a caller's
 * number and name to a different company's operator.
 */
export async function resolveOperatorByExtension(
	tenantId: TenantId,
	extension: string | null | undefined
): Promise<{ operatorProfileId: string; userId: string } | null> {
	const wanted = cleanText(extension);

	if (!wanted) {
		return null;
	}

	const [row] = await db
		.select({ id: operatorProfiles.id, userId: operatorProfiles.userId })
		.from(operatorProfiles)
		.where(
			tenantWhere(
				operatorProfiles,
				tenantId,
				eq(operatorProfiles.extension, wanted),
				eq(operatorProfiles.isDeleted, false)
			)
		)
		.limit(1);

	if (!row) {
		return null;
	}

	return { operatorProfileId: row.id, userId: row.userId };
}

/**
 * The user an AI-created record is attributed to.
 *
 * `tickets.created_by` is NOT NULL and references `users.id`. The AI is not a
 * user, and inserting a synthetic "AI" user row would change what every
 * existing screen sees - the user list, the operator picker, the
 * manager-sees-only-own-tickets rule in tickets.handlers.ts all read that table.
 * So an AI-created ticket is attributed to the accountable human instead: the
 * longest-standing active supervisor, then an admin, then any active user. The
 * fact that the AI wrote it is recorded on the AI-side rows (ai_sessions,
 * call_notes.author_type = "ai"), not by faking an author.
 *
 * That human must work for the SAME customer: `tickets.created_by` is rendered on
 * the ticket page, and the vendor's own staff (who are users of the vendor tenant)
 * would otherwise be picked for whoever seeded first.
 */
export async function resolveSystemActorUserId(tenantId: TenantId): Promise<string> {
	const [row] = await db
		.select({ id: users.id, role: users.role })
		.from(users)
		.where(tenantWhere(users, tenantId, eq(users.isActive, true), eq(users.isDeleted, false)))
		.orderBy(
			sql`case ${users.role} when 'supervisor' then 0 when 'admin' then 1 else 2 end`,
			asc(users.createdAt)
		)
		.limit(1);

	if (!row) {
		throw databaseError(
			"No active user exists to own an AI-created record (tickets.created_by is required)"
		);
	}

	return row.id;
}

// ===========================================
// calls
// ===========================================

export interface CreateInboundCallInput {
	callerNumber: string;
	/** Asterisk channel id. Kept for logging and for the ai_sessions row. */
	channelId: string;
	direction?: CallDirection;
	calleeExtension?: string | null;
	/**
	 * Which customer this call is for. REQUIRED, and the answer to the hardest
	 * question in the tenancy work: there is no request and no logged-in user here.
	 *
	 * Inbound, the caller is resolveInboundTenant() (inbound-tenant.ts), which reads
	 * it off the channel - the dialplan context it arrived in, else the PJSIP endpoint
	 * it came from, else, while there is exactly one customer, that customer.
	 * Outbound, it is the tenant that owns the campaign asking for the dial.
	 *
	 * It used to be optional and default to "the only customer there is". Optional is
	 * what makes a forgotten call site silently write into the wrong account, so it is
	 * now the compiler's job to notice.
	 */
	tenantId: TenantId;
}

export interface CreateInboundCallResult {
	callId: string;
	/**
	 * The tenant the call was created for. Returned rather than looked up again by
	 * the caller: the orchestrator carries it on the ActiveCall for the length of
	 * the call, and re-deriving it would be a second chance to derive it wrongly.
	 */
	tenantId: TenantId;
	/** Null only for a caller with no digits in their caller id at all. */
	contact: ContactMatch | null;
	created: boolean;
	startedAt: Date;
	operatorProfileId: string | null;
}

/**
 * The `calls` row for a call that has just entered Stasis, plus the contact it
 * belongs to (created on the spot if this number is new to us).
 *
 * `calls` has no channel column - the Asterisk channel lives on `ai_sessions`
 * where it is actually needed for ARI operations - so `channelId` is used here
 * only for correlating log lines.
 */
export async function createInboundCall(
	input: CreateInboundCallInput
): Promise<CreateInboundCallResult> {
	return await run("createInboundCall", { channelId: input.channelId }, async () => {
		const digits = input.callerNumber.replace(/\D/g, "");
		let contact: ContactMatch | null = null;
		let created = false;

		// The tenant of the call. THE decision every other row inherits: the contact,
		// the AI session, every transcript line, the recording, the analysis and the
		// ticket all take it from here. Resolved by the caller (inbound-tenant.ts for an
		// inbound channel, the campaign for an outbound dial) - never guessed here.
		const tenantId = input.tenantId;

		if (digits.length > 0) {
			const resolved = await findOrCreateContact(tenantId, input.callerNumber);
			contact = resolved.contact;
			created = resolved.created;
		} else {
			// Withheld / anonymous caller id. There is nothing to match on and
			// creating a contact keyed on an empty string would collide with the
			// next anonymous caller on idx_contacts_tenant_phone.
			logger.warn(
				{ channelId: input.channelId, callerNumber: input.callerNumber },
				"call has no dialable number, continuing without a contact"
			);
		}

		const operatorProfileId = await resolveOperatorProfileIdByExtension(
			tenantId,
			input.calleeExtension
		);
		const startedAt = new Date();
		const dialledExtension = cleanText(input.calleeExtension);

		const [row] = await db
			.insert(calls)
			.values({
				tenantId,
				direction: input.direction ?? "inbound",
				callerNumber: truncate(digits.length > 0 ? digits : ANONYMOUS_CALLER, PHONE_COLUMN_LIMIT),
				calleeExtension:
					dialledExtension === null ? null : truncate(dialledExtension, EXTENSION_COLUMN_LIMIT),
				contactId: contact?.id ?? null,
				operatorId: operatorProfileId,
				status: "ringing",
				startedAt,
			})
			.returning({ id: calls.id, startedAt: calls.startedAt });

		if (!row) {
			throw databaseError("Inserting the call row returned nothing");
		}

		logger.info(
			{
				callId: row.id,
				channelId: input.channelId,
				// Logged rather than baked into the message: this writer serves both
				// directions now, and a line that always said "inbound" made an outbound
				// campaign dial unsearchable in the logs.
				direction: input.direction ?? "inbound",
				contactId: contact?.id ?? null,
				contactCreated: created,
			},
			"created the CRM call row"
		);

		return {
			callId: row.id,
			tenantId,
			contact,
			created,
			startedAt: row.startedAt,
			operatorProfileId,
		};
	});
}

/**
 * ringing -> answered. Scoped to `status = 'ringing'` so a second call (or a
 * late ARI event) cannot drag a completed call back to "answered".
 */
export async function markCallAnswered(
	tenantId: TenantId,
	callId: string
): Promise<{ updated: boolean }> {
	return await run("markCallAnswered", { callId }, async () => {
		// answered_at is the only real source for the TZ's "average waiting time"
		// metric (answered_at - started_at). Guarded by status = 'ringing', so a
		// repeated answer event cannot move the timestamp later.
		const rows = await db
			.update(calls)
			.set({ status: "answered", answeredAt: new Date() })
			.where(tenantWhere(calls, tenantId, eq(calls.id, callId), eq(calls.status, "ringing")))
			.returning({ id: calls.id });

		return { updated: rows.length > 0 };
	});
}

export interface MarkCallEndedInput {
	status: CallStatus;
	durationSeconds?: number;
}

export interface MarkCallEndedResult {
	updated: boolean;
	endedAt: Date | null;
	durationSeconds: number;
}

/**
 * Finalise a call. Guarded by `ended_at IS NULL`, which is what makes every
 * teardown path in the orchestrator safe to run twice - the first writer wins
 * and later ones report `updated: false`.
 */
export async function markCallEnded(
	tenantId: TenantId,
	callId: string,
	input: MarkCallEndedInput
): Promise<MarkCallEndedResult> {
	return await run("markCallEnded", { callId, status: input.status }, async () => {
		const endedAt = new Date();
		const durationSeconds = toWholeSeconds(input.durationSeconds);

		// `calls.duration` is what the minute ledger will be reconstructed from, so a
		// finalise that could land on another tenant's row is a billing error as well
		// as a data one.
		const rows = await db
			.update(calls)
			.set({ status: input.status, duration: durationSeconds, endedAt })
			.where(tenantWhere(calls, tenantId, eq(calls.id, callId), isNull(calls.endedAt)))
			.returning({ id: calls.id });

		if (rows.length === 0) {
			logger.debug({ callId }, "call was already finalised, leaving it alone");
			return { updated: false, endedAt: null, durationSeconds };
		}

		return { updated: true, endedAt, durationSeconds };
	});
}

/**
 * Attach a call to a contact after the fact.
 *
 * Needed for the withheld-caller-id case: `createInboundCall` cannot match or
 * create a contact when there are no digits to key on, but the caller can still
 * dictate a callback number to the agent. Only fills a null `contact_id` so a
 * hallucinated second number cannot re-point a call at somebody else's record.
 */
export async function setCallContact(
	tenantId: TenantId,
	callId: string,
	contactId: string
): Promise<{ updated: boolean }> {
	return await run("setCallContact", { callId, contactId }, async () => {
		// Both sides are checked: the call must be this tenant's, and so must the
		// contact - `contact_id` is a plain FK, so nothing else stops a call being
		// pointed at another customer's contact record.
		const [contact] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(tenantWhere(contacts, tenantId, eq(contacts.id, contactId)))
			.limit(1);

		if (!contact) {
			throw notFound("Kontakt", contactId);
		}

		const rows = await db
			.update(calls)
			.set({ contactId })
			.where(tenantWhere(calls, tenantId, eq(calls.id, callId), isNull(calls.contactId)))
			.returning({ id: calls.id });

		return { updated: rows.length > 0 };
	});
}

/** Attach a call to an operator - used when an AI transfer connects. */
export async function setCallOperator(
	tenantId: TenantId,
	callId: string,
	operatorProfileId: string
): Promise<{ updated: boolean }> {
	return await run("setCallOperator", { callId, operatorProfileId }, async () => {
		// The operator profile has to be this tenant's too. transfer.ts only ever
		// selects from a tenant-scoped pool, but this is the write that would file a
		// call against a stranger if a caller ever supplied the id.
		const [operator] = await db
			.select({ id: operatorProfiles.id })
			.from(operatorProfiles)
			.where(tenantWhere(operatorProfiles, tenantId, eq(operatorProfiles.id, operatorProfileId)))
			.limit(1);

		if (!operator) {
			throw notFound("Operator", operatorProfileId);
		}

		const rows = await db
			.update(calls)
			.set({ operatorId: operatorProfileId })
			.where(tenantWhere(calls, tenantId, eq(calls.id, callId)))
			.returning({ id: calls.id });

		return { updated: rows.length > 0 };
	});
}

// ===========================================
// ai_sessions
// ===========================================

export interface CreateAiSessionInput {
	callId: string;
	channelId?: string | null;
	provider?: string;
	model?: string | null;
	voice?: string | null;
	language?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface CreateAiSessionResult {
	id: string;
	created: boolean;
}

/**
 * The ai_sessions row for a call. Upserted on the unique `call_id` index: a
 * retried session replaces the previous attempt rather than racing a second
 * Realtime socket onto the same audio path, which is exactly what the schema
 * comment on idx_ai_sessions_call asks for.
 */
export async function createAiSession(
	tenantId: TenantId,
	input: CreateAiSessionInput
): Promise<CreateAiSessionResult> {
	return await run("createAiSession", { callId: input.callId }, async () => {
		const existing = await db
			.select({ id: aiSessions.id })
			.from(aiSessions)
			.where(tenantWhere(aiSessions, tenantId, eq(aiSessions.callId, input.callId)))
			.limit(1);

		const values = {
			// The tenant the orchestrator resolved for this call, cross-checked against
			// the call row inside the same statement: the two have to agree or the insert
			// is rejected. This row is also where the vendor's AI cost per tenant is
			// aggregated from, so a wrong tenant here is a wrong margin report.
			tenantId: parentTenantOfCall(tenantId, input.callId),
			callId: input.callId,
			channelId: input.channelId ?? null,
			provider: input.provider ?? "openai-realtime",
			model: input.model ?? null,
			voice: input.voice ?? null,
			language: input.language ?? null,
			metadata: input.metadata ?? null,
		};

		const [row] = await db
			.insert(aiSessions)
			.values(values)
			.onConflictDoUpdate({
				target: aiSessions.callId,
				// A conflicting row is this call's previous session, so it is already this
				// tenant's - but the ON CONFLICT branch is the one place an upsert can WRITE a
				// row it did not build, so it says whose row it may write. Without it the only
				// thing standing between a wrong callId and an overwritten session is the NOT
				// NULL constraint above.
				setWhere: eq(aiSessions.tenantId, tenantId),
				set: {
					channelId: values.channelId,
					provider: values.provider,
					model: values.model,
					voice: values.voice,
					language: values.language,
					metadata: values.metadata,
					status: "initializing",
					errorMessage: null,
					startedAt: new Date(),
					endedAt: null,
					durationMs: null,
				},
			})
			.returning({ id: aiSessions.id });

		if (!row) {
			throw databaseError("Upserting the ai_sessions row returned nothing");
		}

		return { id: row.id, created: existing.length === 0 };
	});
}

export interface AiSessionPatch {
	status?: AiSessionStatus;
	channelId?: string | null;
	model?: string | null;
	voice?: string | null;
	language?: string | null;
	errorMessage?: string | null;
	metadata?: Record<string, unknown> | null;
	interruptions?: number;
	inputAudioMs?: number;
	outputAudioMs?: number;
	promptTokens?: number | null;
	completionTokens?: number | null;
	// The rest of what a call costs. Nullable rather than defaulted so a session
	// that never reported usage stays distinguishable from one that spent nothing;
	// see the column comments on ai_sessions.
	cachedPromptTokens?: number | null;
	cachedAudioTokens?: number | null;
	cachedTextTokens?: number | null;
	inputTextTokens?: number | null;
	inputAudioTokens?: number | null;
	outputTextTokens?: number | null;
	outputAudioTokens?: number | null;
	responseTurns?: number | null;
	transcribeAudioTokens?: number | null;
	transcribeTextTokens?: number | null;
	transcribeModel?: string | null;
}

export async function updateAiSession(
	tenantId: TenantId,
	id: string,
	patch: AiSessionPatch
): Promise<{ updated: boolean }> {
	return await run("updateAiSession", { aiSessionId: id }, async () => {
		const set: AiSessionPatch = {};

		for (const [key, value] of Object.entries(patch)) {
			if (value !== undefined) {
				Object.assign(set, { [key]: value });
			}
		}

		if (Object.keys(set).length === 0) {
			return { updated: false };
		}

		const rows = await db
			.update(aiSessions)
			.set(set)
			.where(tenantWhere(aiSessions, tenantId, eq(aiSessions.id, id)))
			.returning({ id: aiSessions.id });

		return { updated: rows.length > 0 };
	});
}

export interface FinishAiSessionInput {
	status: Extract<AiSessionStatus, "completed" | "failed">;
	errorMessage?: string | null;
	stats?: VoiceProviderStats | null;
}

export interface FinishAiSessionResult {
	updated: boolean;
	durationMs: number | null;
}

/**
 * Close an ai_sessions row. `ended_at IS NULL` makes it idempotent, and the
 * duration is computed by Postgres from the stored `started_at` so a teardown
 * that runs long after the fact still records the real length.
 */
export async function finishAiSession(
	tenantId: TenantId,
	id: string,
	input: FinishAiSessionInput
): Promise<FinishAiSessionResult> {
	return await run("finishAiSession", { aiSessionId: id, status: input.status }, async () => {
		// Counters are only written when the provider actually reported them -
		// otherwise a teardown with no stats would zero what the live session
		// already recorded through updateAiSession.
		const counters = input.stats
			? {
					interruptions: Math.max(0, Math.round(input.stats.interruptions)),
					inputAudioMs: Math.max(0, Math.round(input.stats.inputAudioMs)),
					outputAudioMs: Math.max(0, Math.round(input.stats.outputAudioMs)),
				}
			: {};

		const [row] = await db
			.update(aiSessions)
			.set({
				status: input.status,
				errorMessage: cleanText(input.errorMessage),
				endedAt: new Date(),
				durationMs: sql`((extract(epoch from (now() - ${aiSessions.startedAt})) * 1000)::int)`,
				...counters,
			})
			.where(tenantWhere(aiSessions, tenantId, eq(aiSessions.id, id), isNull(aiSessions.endedAt)))
			.returning({ durationMs: aiSessions.durationMs });

		if (!row) {
			logger.debug({ aiSessionId: id }, "ai session was already finished, leaving it alone");
			return { updated: false, durationMs: null };
		}

		return { updated: true, durationMs: row.durationMs ?? null };
	});
}

// ===========================================
// call_transcripts
// ===========================================

export interface AppendTranscriptInput {
	callId: string;
	aiSessionId?: string | null;
	role: TranscriptRole;
	content: string;
	isFinal?: boolean;
	startMs?: number | null;
	endMs?: number | null;
	confidence?: number | null;
}

/**
 * One utterance. Returns null for empty content rather than writing a blank row:
 * a Realtime stream regularly emits empty deltas at the end of a turn.
 */
export async function appendTranscript(
	tenantId: TenantId,
	input: AppendTranscriptInput
): Promise<{ id: string } | null> {
	const content = cleanText(input.content);

	if (!content) {
		return null;
	}

	return await run("appendTranscript", { callId: input.callId, role: input.role }, async () => {
		const [row] = await db
			.insert(callTranscripts)
			.values({
				tenantId: parentTenantOfCall(tenantId, input.callId),
				callId: input.callId,
				aiSessionId: input.aiSessionId ?? null,
				role: input.role,
				content,
				isFinal: input.isFinal ?? true,
				startMs: input.startMs ?? null,
				endMs: input.endMs ?? null,
				confidence: normaliseConfidence(input.confidence),
			})
			.returning({ id: callTranscripts.id });

		if (!row) {
			throw databaseError("Inserting the transcript row returned nothing");
		}

		return { id: row.id };
	});
}

export interface TranscriptTextResult {
	text: string;
	turnCount: number;
	callerTurnCount: number;
}

/**
 * The stored transcript as one "role: line" block, for the post-call analysis.
 *
 * A read rather than a write, but it lives here because it has to agree exactly
 * with how appendTranscript stores rows: only final utterances, ordered by
 * position in the call, with the interim rows the live view used left out.
 */
export async function buildTranscriptText(
	tenantId: TenantId,
	callId: string
): Promise<TranscriptTextResult> {
	// This text is fed to the summariser and then stored on ai_analyses.transcript.
	// Unscoped, a wrong callId would have sent one customer's conversation to the
	// model and filed it under another's call.
	const rows = await db
		.select({
			role: callTranscripts.role,
			content: callTranscripts.content,
		})
		.from(callTranscripts)
		.where(
			tenantWhere(
				callTranscripts,
				tenantId,
				eq(callTranscripts.callId, callId),
				eq(callTranscripts.isFinal, true)
			)
		)
		.orderBy(asc(callTranscripts.startMs), asc(callTranscripts.createdAt));

	return {
		text: rows.map((row) => `${row.role}: ${row.content}`).join("\n"),
		turnCount: rows.length,
		callerTurnCount: rows.filter((row) => row.role === "caller").length,
	};
}

// ===========================================
// call_recordings
// ===========================================

export interface SaveRecordingInput {
	callId: string;
	/** Path as Asterisk knows it, i.e. inside the container. */
	filePath: string;
	durationSeconds?: number | null;
}

export interface SaveRecordingResult {
	id: string;
	created: boolean;
	filePath: string;
	/** Where the backend can actually read the same file from. */
	localPath: string;
	sizeBytes: number | null;
	isAvailable: boolean;
}

/**
 * MixMonitor writes into the Asterisk container's recordings directory, which is
 * bind-mounted to a different path on the host - hence the two env vars. The
 * container path is stored (that is the canonical name for the file, and what
 * `calls.recording_path` has always held), while the host path is what gets
 * stat-ed.
 */
/**
 * The monorepo root, derived from this file's own location:
 *   <root>/apps/backend/src/lib/telephony/crm-writer.ts
 *
 * RECORDINGS_DIR is written relative to the repo root in .env, because
 * docker-compose's bind mount needs it in that form. The backend process,
 * however, runs with its working directory at apps/backend. Resolving a
 * relative RECORDINGS_DIR against process.cwd() therefore looked for
 * apps/backend/apps/backend/uploads/... and every recording came back
 * "not readable" even though the file was sitting on disk.
 */
const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

function resolveLocalRecordingPath(filePath: string): string {
	const env = getServerEnv();
	const containerDir = env.ASTERISK_RECORDINGS_DIR.replace(/\/+$/, "");

	if (containerDir.length > 0 && filePath.startsWith(`${containerDir}/`)) {
		const relative = filePath.slice(containerDir.length + 1);
		const hostDir = env.RECORDINGS_DIR.replace(/\/+$/, "");
		const baseDir = isAbsolute(hostDir) ? hostDir : resolve(REPO_ROOT, hostDir);
		return resolve(baseDir, relative);
	}

	return filePath;
}

/**
 * Record that a call has a recording. Tolerates the file not being there:
 * MixMonitor may still be flushing, an operator may have removed it by hand, or
 * recording may have failed entirely - none of which should fail a teardown.
 * Idempotent on (call_id, file_path), so a doubled teardown updates instead of
 * inserting a second row.
 */
export async function saveRecording(
	tenantId: TenantId,
	input: SaveRecordingInput
): Promise<SaveRecordingResult> {
	return await run(
		"saveRecording",
		{ callId: input.callId, filePath: input.filePath },
		async () => {
			const localPath = resolveLocalRecordingPath(input.filePath);
			let sizeBytes: number | null = null;
			let isAvailable = false;

			try {
				const file = Bun.file(localPath);
				isAvailable = await file.exists();
				sizeBytes = isAvailable ? file.size : null;
			} catch (cause) {
				logger.warn(
					{ err: cause, callId: input.callId, localPath },
					"could not stat the recording file, storing the row as unavailable"
				);
			}

			if (!isAvailable) {
				logger.warn(
					{ callId: input.callId, filePath: input.filePath, localPath },
					"recording file is not readable from the backend"
				);
			}

			const fileName = input.filePath.split("/").pop() ?? input.filePath;
			const extension = fileName.includes(".") ? (fileName.split(".").pop() ?? "wav") : "wav";
			const durationSeconds =
				typeof input.durationSeconds === "number" ? toWholeSeconds(input.durationSeconds) : null;

			const [existing] = await db
				.select({ id: callRecordings.id })
				.from(callRecordings)
				.where(
					tenantWhere(
						callRecordings,
						tenantId,
						eq(callRecordings.callId, input.callId),
						eq(callRecordings.filePath, input.filePath)
					)
				)
				.limit(1);

			if (existing) {
				await db
					.update(callRecordings)
					.set({ sizeBytes, durationSeconds, isAvailable })
					.where(tenantWhere(callRecordings, tenantId, eq(callRecordings.id, existing.id)));

				return {
					id: existing.id,
					created: false,
					filePath: input.filePath,
					localPath,
					sizeBytes,
					isAvailable,
				};
			}

			const [row] = await db
				.insert(callRecordings)
				.values({
					tenantId: parentTenantOfCall(tenantId, input.callId),
					callId: input.callId,
					filePath: input.filePath,
					fileName: truncate(fileName, TITLE_COLUMN_LIMIT),
					format: extension.toLowerCase().slice(0, 10),
					sizeBytes,
					durationSeconds,
					isAvailable,
				})
				.returning({ id: callRecordings.id });

			if (!row) {
				throw databaseError("Inserting the recording row returned nothing");
			}

			// The existing call history screen reads calls.recording_path, so mirror the
			// first recording onto it. Guarded so a second file (after a transfer) does
			// not overwrite the pointer the UI already shows.
			await db
				.update(calls)
				.set({ recordingPath: input.filePath })
				.where(
					tenantWhere(calls, tenantId, eq(calls.id, input.callId), isNull(calls.recordingPath))
				);

			return {
				id: row.id,
				created: true,
				filePath: input.filePath,
				localPath,
				sizeBytes,
				isAvailable,
			};
		}
	);
}

// ===========================================
// contacts
// ===========================================

export interface ContactDetailsPatch {
	firstName?: string | null;
	lastName?: string | null;
	tuman?: string | null;
	kocha?: string | null;
	uy?: string | null;
}

export interface UpsertContactDetailsResult {
	updated: boolean;
	address: ContactAddress | null;
}

/**
 * Fill in what the caller told the agent about themselves.
 *
 * The address is MERGED into the existing jsonb, not replaced: the AI usually
 * learns one field at a time ("men Chilonzordan"), and a whole-object write
 * would drop the street the operator typed in last week. Unknown extra keys
 * someone else put in the jsonb survive too, because the existing object is
 * spread first. Blank strings are ignored rather than stored, so a hallucinated
 * empty value cannot erase real data.
 */
export async function upsertContactDetails(
	tenantId: TenantId,
	contactId: string,
	patch: ContactDetailsPatch
): Promise<UpsertContactDetailsResult> {
	return await run("upsertContactDetails", { contactId }, async () => {
		const [existing] = await db
			.select({
				firstName: contacts.firstName,
				lastName: contacts.lastName,
				address: contacts.address,
			})
			.from(contacts)
			.where(tenantWhere(contacts, tenantId, eq(contacts.id, contactId)))
			.limit(1);

		if (!existing) {
			throw notFound("Kontakt", contactId);
		}

		const set: {
			firstName?: string;
			lastName?: string;
			address?: ContactAddress;
			updatedAt: Date;
		} = { updatedAt: new Date() };

		const firstName = cleanText(patch.firstName);
		const lastName = cleanText(patch.lastName);

		if (firstName) {
			set.firstName = truncate(firstName, 100);
		}
		if (lastName) {
			set.lastName = truncate(lastName, 100);
		}

		const merged: Record<string, unknown> = { ...(existing.address ?? {}) };
		let addressTouched = false;

		for (const key of ["tuman", "kocha", "uy"] as const) {
			const value = cleanText(patch[key]);
			if (value) {
				merged[key] = value;
				addressTouched = true;
			}
		}

		if (addressTouched) {
			// The column's declared shape requires all three keys, so the ones we
			// still do not know are written as "" instead of being left off. The cast
			// is only about that declared shape - the spread above is what preserves
			// any other keys already in the jsonb.
			merged.tuman ??= "";
			merged.kocha ??= "";
			merged.uy ??= "";
			set.address = merged as unknown as ContactAddress;
		}

		if (!(set.firstName || set.lastName || set.address)) {
			return { updated: false, address: existing.address ?? null };
		}

		await db
			.update(contacts)
			.set(set)
			.where(tenantWhere(contacts, tenantId, eq(contacts.id, contactId)));

		return { updated: true, address: set.address ?? existing.address ?? null };
	});
}

// ===========================================
// tickets
// ===========================================

export interface CreateTicketFromCallInput {
	callId: string;
	contactId: string;
	subject: string;
	description: string;
	category?: string | null;
	priority?: TicketPriority;
	/** Optional: an operator id when a human asked for the ticket. */
	createdBy?: string | null;
}

export interface CreateTicketFromCallResult {
	ticketId: string;
	created: boolean;
	createdBy: string;
}

/**
 * A ticket for what this call was about, linked both ways: the ticket points at
 * the contact, and `calls.ticket_id` points at the ticket so the existing call
 * history screen shows it.
 *
 * Idempotent by design - if the AI calls create_ticket twice (it does), the call
 * already has a ticket and that one is returned instead of a duplicate.
 */
export async function createTicketFromCall(
	tenantId: TenantId,
	input: CreateTicketFromCallInput
): Promise<CreateTicketFromCallResult> {
	return await run("createTicketFromCall", { callId: input.callId }, async () => {
		const [call] = await db
			.select({ id: calls.id, ticketId: calls.ticketId })
			.from(calls)
			.where(tenantWhere(calls, tenantId, eq(calls.id, input.callId)))
			.limit(1);

		if (!call) {
			throw notFound("Qo'ng'iroq", input.callId);
		}

		if (call.ticketId) {
			const [linked] = await db
				.select({ id: tickets.id, createdBy: tickets.createdBy })
				.from(tickets)
				.where(
					tenantWhere(
						tickets,
						tenantId,
						eq(tickets.id, call.ticketId),
						eq(tickets.isDeleted, false)
					)
				)
				.limit(1);

			if (linked) {
				logger.info(
					{ callId: input.callId, ticketId: linked.id },
					"call already has a ticket, not creating another one"
				);
				return { ticketId: linked.id, created: false, createdBy: linked.createdBy };
			}
		}

		const subject = cleanText(input.subject);
		const description = cleanText(input.description);

		if (!subject) {
			throw invalidInput("subject", "Ticket subject is required");
		}
		if (!description) {
			throw invalidInput("description", "Ticket description is required");
		}

		const createdBy = input.createdBy ?? (await resolveSystemActorUserId(tenantId));

		const [row] = await db
			.insert(tickets)
			.values({
				// From the contact the ticket is being filed for, and only if that contact
				// is this tenant's: a ticket cannot belong to a different customer than the
				// person it is about, and an AI that produced a stale contactId must not be
				// able to file into another account.
				tenantId: parentTenantOfContact(tenantId, input.contactId),
				contactId: input.contactId,
				createdBy,
				subject: truncate(subject, TITLE_COLUMN_LIMIT),
				description,
				category: cleanText(input.category),
				priority: input.priority ?? "medium",
			})
			.returning({ id: tickets.id });

		if (!row) {
			throw databaseError("Inserting the ticket row returned nothing");
		}

		await db
			.update(calls)
			.set({ ticketId: row.id })
			.where(tenantWhere(calls, tenantId, eq(calls.id, input.callId)));

		logger.info(
			{ callId: input.callId, ticketId: row.id, createdBy },
			"created a ticket from an AI-handled call"
		);

		return { ticketId: row.id, created: true, createdBy };
	});
}

// ===========================================
// call_notes
// ===========================================

export interface AddNoteInput {
	callId?: string | null;
	ticketId?: string | null;
	authorType?: NoteAuthorType;
	authorUserId?: string | null;
	content: string;
}

export async function addNote(tenantId: TenantId, input: AddNoteInput): Promise<{ id: string }> {
	return await run("addNote", { callId: input.callId, ticketId: input.ticketId }, async () => {
		const content = cleanText(input.content);

		if (!content) {
			throw invalidInput("content", "Note content is required");
		}

		if (!(input.callId || input.ticketId)) {
			// A note attached to neither is unreachable from every existing screen.
			throw invalidInput("callId", "A note needs either a callId or a ticketId");
		}

		const [row] = await db
			.insert(callNotes)
			.values({
				// A note is attached to a call or to a ticket (validated just above), so
				// the tenant comes from whichever one it actually has - and that parent has
				// to be this tenant's.
				tenantId: parentTenant(tenantId, input),
				callId: input.callId ?? null,
				ticketId: input.ticketId ?? null,
				authorType: input.authorType ?? "ai",
				authorUserId: input.authorUserId ?? null,
				content,
			})
			.returning({ id: callNotes.id });

		if (!row) {
			throw databaseError("Inserting the note row returned nothing");
		}

		return { id: row.id };
	});
}

// ===========================================
// follow_up_tasks
// ===========================================

export interface CreateFollowUpInput {
	callId?: string | null;
	ticketId?: string | null;
	contactId?: string | null;
	/** operator_profiles.id, not users.id. */
	assignedTo?: string | null;
	title: string;
	description?: string | null;
	dueAt?: Date | null;
	createdBySystem?: boolean;
}

export interface CreateFollowUpResult {
	id: string;
	dueAt: Date | null;
}

export async function createFollowUp(
	tenantId: TenantId,
	input: CreateFollowUpInput
): Promise<CreateFollowUpResult> {
	return await run("createFollowUp", { callId: input.callId }, async () => {
		const title = cleanText(input.title);

		if (!title) {
			throw invalidInput("title", "Follow-up title is required");
		}

		const [row] = await db
			.insert(followUpTasks)
			.values({
				tenantId: parentTenant(tenantId, input),
				callId: input.callId ?? null,
				ticketId: input.ticketId ?? null,
				contactId: input.contactId ?? null,
				assignedTo: input.assignedTo ?? null,
				title: truncate(title, TITLE_COLUMN_LIMIT),
				description: cleanText(input.description),
				dueAt: input.dueAt ?? null,
				createdBySystem: input.createdBySystem ?? true,
			})
			.returning({ id: followUpTasks.id, dueAt: followUpTasks.dueAt });

		if (!row) {
			throw databaseError("Inserting the follow-up row returned nothing");
		}

		return { id: row.id, dueAt: row.dueAt ?? null };
	});
}

// ===========================================
// bookings
// ===========================================

export interface CreateBookingInput {
	contactId: string;
	callId?: string | null;
	ticketId?: string | null;
	assignedTo?: string | null;
	title: string;
	notes?: string | null;
	scheduledAt: Date;
	durationMinutes?: number;
	location?: string | null;
	createdBySystem?: boolean;
}

export interface CreateBookingResult {
	id: string;
	scheduledAt: Date;
}

export async function createBooking(
	tenantId: TenantId,
	input: CreateBookingInput
): Promise<CreateBookingResult> {
	return await run("createBooking", { contactId: input.contactId }, async () => {
		const title = cleanText(input.title);

		if (!title) {
			throw invalidInput("title", "Booking title is required");
		}

		if (Number.isNaN(input.scheduledAt.getTime())) {
			throw invalidInput("scheduledAt", "Booking time is not a valid date");
		}

		const [row] = await db
			.insert(bookings)
			.values({
				tenantId: parentTenant(tenantId, input),
				contactId: input.contactId,
				callId: input.callId ?? null,
				ticketId: input.ticketId ?? null,
				assignedTo: input.assignedTo ?? null,
				title: truncate(title, TITLE_COLUMN_LIMIT),
				notes: cleanText(input.notes),
				scheduledAt: input.scheduledAt,
				durationMinutes: Math.max(1, Math.round(input.durationMinutes ?? DEFAULT_BOOKING_MINUTES)),
				location: cleanText(input.location),
				createdBySystem: input.createdBySystem ?? true,
			})
			.returning({ id: bookings.id, scheduledAt: bookings.scheduledAt });

		if (!row) {
			throw databaseError("Inserting the booking row returned nothing");
		}

		return { id: row.id, scheduledAt: row.scheduledAt };
	});
}

// ===========================================
// ai_analyses
// ===========================================

/**
 * What one summariser run cost.
 *
 * Declared here rather than imported from the orchestrator because the
 * dependency runs the other way: the orchestrator calls this module.
 * `CallSummaryUsage` is structurally identical, so a summary's `usage` can be
 * passed straight through.
 */
export interface AiAnalysisUsage {
	model: string;
	promptTokens: number;
	cachedPromptTokens: number;
	completionTokens: number;
}

export interface WriteAiAnalysisInput {
	callId: string;
	transcript?: string | null;
	summary?: string | null;
	sentiment?: Sentiment | null;
	categories?: string[] | null;
	confidence?: number | null;
	/** Defaults to "completed". Pass "failed" with an errorMessage when there is nothing to analyse. */
	status?: AiStatus;
	errorMessage?: string | null;
	/**
	 * Omitted when the run made no API call - the "nothing to analyse" path, or a
	 * summariser that does not report usage. Omitting leaves the counters alone,
	 * which is why they are not simply derived from retryCount.
	 */
	usage?: AiAnalysisUsage;
}

export interface WriteAiAnalysisResult {
	analysisId: string;
	ticketId: string | null;
	mirroredToTicket: boolean;
	aiStatus: AiStatus;
}

/**
 * The post-call analysis, written to the table the platform already has.
 *
 * Three writes, because three different screens read three different places:
 *   - ai_analyses      : the AI pipeline's own record, keyed uniquely on call_id
 *   - calls.ai_status  : what the call list shows as the analysis state
 *   - tickets.ai_*     : what the ticket detail and dashboard already render
 *
 * The ticket mirror only ever writes fields we actually have, so a "failed"
 * analysis cannot blank a summary a previous successful run produced.
 */
export async function writeAiAnalysis(
	tenantId: TenantId,
	input: WriteAiAnalysisInput
): Promise<WriteAiAnalysisResult> {
	return await run("writeAiAnalysis", { callId: input.callId }, async () => {
		const status: AiStatus = input.status ?? "completed";
		const transcript = cleanText(input.transcript);
		const summary = cleanText(input.summary);
		const errorMessage = cleanText(input.errorMessage);
		const confidence = normaliseConfidence(input.confidence);
		const categories = input.categories?.length ? input.categories : null;
		const processedAt = new Date();
		const usage = input.usage;

		const [analysis] = await db
			.insert(aiAnalyses)
			.values({
				tenantId: parentTenantOfCall(tenantId, input.callId),
				callId: input.callId,
				status,
				transcript,
				summary,
				sentiment: input.sentiment ?? null,
				categories,
				confidence,
				errorMessage,
				processedAt,
				analysisModel: usage?.model ?? null,
				promptTokens: usage?.promptTokens ?? 0,
				cachedPromptTokens: usage?.cachedPromptTokens ?? 0,
				completionTokens: usage?.completionTokens ?? 0,
				billedRuns: usage === undefined ? 0 : 1,
			})
			.onConflictDoUpdate({
				target: aiAnalyses.callId,
				// Same rule as the ai_sessions upsert: the update half of an upsert names the
				// tenant whose row it is allowed to replace.
				setWhere: eq(aiAnalyses.tenantId, tenantId),
				set: {
					status,
					transcript,
					summary,
					sentiment: input.sentiment ?? null,
					categories,
					confidence,
					errorMessage,
					processedAt,
					// A replaced analysis is a retry; the counter is what makes a
					// permanently failing call visible in the existing AI queue view.
					retryCount: sql`${aiAnalyses.retryCount} + 1`,
					// The spend ADDS UP: a call analysed three times was paid for three
					// times, and the month's total has to reflect that. A run with no
					// usage leaves every counter exactly where it was.
					...(usage === undefined
						? {}
						: {
								analysisModel: usage.model,
								promptTokens: sql`${aiAnalyses.promptTokens} + ${usage.promptTokens}`,
								cachedPromptTokens: sql`${aiAnalyses.cachedPromptTokens} + ${usage.cachedPromptTokens}`,
								completionTokens: sql`${aiAnalyses.completionTokens} + ${usage.completionTokens}`,
								billedRuns: sql`${aiAnalyses.billedRuns} + 1`,
							}),
				},
			})
			.returning({ id: aiAnalyses.id });

		if (!analysis) {
			throw databaseError("Upserting the ai_analyses row returned nothing");
		}

		const [call] = await db
			.update(calls)
			.set({ aiStatus: status })
			.where(tenantWhere(calls, tenantId, eq(calls.id, input.callId)))
			.returning({ ticketId: calls.ticketId });

		const ticketId = call?.ticketId ?? null;

		if (!ticketId) {
			return { analysisId: analysis.id, ticketId: null, mirroredToTicket: false, aiStatus: status };
		}

		const ticketSet: {
			aiSummary?: string;
			aiSentiment?: Sentiment;
			aiCategories?: string[];
			aiConfidence?: number;
			aiAnalysisId: string;
			updatedAt: Date;
		} = { aiAnalysisId: analysis.id, updatedAt: new Date() };

		if (summary) {
			ticketSet.aiSummary = summary;
		}
		if (input.sentiment) {
			ticketSet.aiSentiment = input.sentiment;
		}
		if (categories) {
			ticketSet.aiCategories = categories;
		}
		if (confidence !== null) {
			ticketSet.aiConfidence = confidence;
		}

		// The ticket id came off the call row that was just checked, so it is already
		// this tenant's; scoped anyway, because a mirror write is exactly the kind of
		// statement that gets copied into a handler where the id came from a client.
		await db
			.update(tickets)
			.set(ticketSet)
			.where(tenantWhere(tickets, tenantId, eq(tickets.id, ticketId)));

		return { analysisId: analysis.id, ticketId, mirroredToTicket: true, aiStatus: status };
	});
}
