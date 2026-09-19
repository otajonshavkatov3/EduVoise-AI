/**
 * AI voice layer tables (Asterisk + OpenAI Realtime).
 *
 * STRICTLY ADDITIVE. Nothing here alters an existing table or column, so the
 * migration cannot break the 28 routes already in production. The existing
 * `calls`, `tickets`, `contacts` and `ai_analyses` tables stay the source of
 * truth; these tables hang off them.
 *
 * New enums live here rather than in enums.ts for the same reason: that file
 * is referenced by the existing migrations and is left untouched.
 */
import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { calls, tickets } from "./callTicketAi";
import { contacts } from "./contacts";
import { operatorProfiles } from "./operatorProfiles";
import { tenantIdColumn } from "./tenants";
import { users } from "./users";

// ===========================================
// Enums
// ===========================================

export const aiSessionStatusEnum = pgEnum("ai_session_status", [
	"initializing",
	"active",
	"transferring",
	"completed",
	"failed",
]);

export const transcriptRoleEnum = pgEnum("transcript_role", ["caller", "agent", "system"]);

export const followUpStatusEnum = pgEnum("follow_up_status", [
	"open",
	"in_progress",
	"done",
	"cancelled",
]);

export const bookingStatusEnum = pgEnum("booking_status", [
	"scheduled",
	"confirmed",
	"cancelled",
	"completed",
]);

export const transferStatusEnum = pgEnum("transfer_status", [
	"requested",
	"ringing",
	"connected",
	"failed",
	"abandoned",
]);

export const noteAuthorTypeEnum = pgEnum("note_author_type", ["ai", "operator", "system"]);

export const sipExtensionKindEnum = pgEnum("sip_extension_kind", ["sip", "webrtc", "ai"]);

// ===========================================
// ai_sessions - one row per AI-handled call
// ===========================================
// The AudioSocket UUID is deliberately `calls.id`, so an inbound TCP
// connection from Asterisk resolves to a CRM record with no extra lookup.
// `channelId` is the Asterisk channel, kept so ARI operations (answer,
// bridge, redirect, hangup) can be issued after the fact.

export const aiSessions = pgTable(
	"ai_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		callId: uuid("call_id")
			.notNull()
			.references(() => calls.id, { onDelete: "cascade" }),
		channelId: varchar("channel_id", { length: 150 }),
		provider: varchar("provider", { length: 50 }).notNull().default("openai-realtime"),
		model: varchar("model", { length: 100 }),
		voice: varchar("voice", { length: 50 }),
		language: varchar("language", { length: 10 }).default("uz"),
		status: aiSessionStatusEnum("status").notNull().default("initializing"),
		// Counted from OpenAI `input_audio_buffer.speech_started` arriving while
		// the agent is still speaking - the useful signal for "was the bot
		// talking over the caller", which drives prompt tuning.
		interruptions: integer("interruptions").notNull().default(0),
		inputAudioMs: integer("input_audio_ms").notNull().default(0),
		outputAudioMs: integer("output_audio_ms").notNull().default(0),
		promptTokens: integer("prompt_tokens"),
		completionTokens: integer("completion_tokens"),
		// The breakdown a cost figure needs. Nullable with NO default, like the two
		// totals above: a session that never reported usage must stay
		// distinguishable from one that genuinely spent nothing, because pricing a
		// missing breakdown as zero would quietly understate a month.
		//
		// Two axes cross on the input side - cache (fresh vs cached) and modality
		// (text vs audio). Both marginals are stored so the apportionment error
		// stays bounded and visible; see lib/ai-cost/price.ts.
		cachedPromptTokens: integer("cached_prompt_tokens"),
		inputTextTokens: integer("input_text_tokens"),
		inputAudioTokens: integer("input_audio_tokens"),
		outputTextTokens: integer("output_text_tokens"),
		outputAudioTokens: integer("output_audio_tokens"),
		// How the cached prefix itself split across modalities, which removes the
		// apportionment entirely on the paths that report it. OpenAI Realtime does
		// (input_token_details.cached_tokens_details); Gemini Live does not, and
		// NULL there means "apportion it" rather than "no cached audio".
		cachedAudioTokens: integer("cached_audio_tokens"),
		cachedTextTokens: integer("cached_text_tokens"),
		/** Billed turns: responses that produced output. A barge-in cancellation is not one. */
		responseTurns: integer("response_turns"),
		// Input transcription is billed separately from the Realtime session, and
		// only on the OpenAI path - Gemini transcribes inside the session with no
		// separate line. NULL here therefore means "not applicable", not "zero".
		transcribeAudioTokens: integer("transcribe_audio_tokens"),
		transcribeTextTokens: integer("transcribe_text_tokens"),
		transcribeModel: varchar("transcribe_model", { length: 100 }),
		errorMessage: text("error_message"),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		durationMs: integer("duration_ms"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One AI session per call: a retry replaces the row rather than racing
		// two Realtime sessions onto the same audio path.
		uniqueIndex("idx_ai_sessions_call").on(table.callId),
		// Tenant + time: the shape of both the per-tenant session list and the
		// vendor's monthly token-cost rollup, which is the SECOND meter - the
		// vendor's own cost of goods, never deducted from the customer's minutes.
		index("idx_ai_sessions_tenant_started").on(table.tenantId, table.startedAt),
		index("idx_ai_sessions_channel").on(table.channelId),
		index("idx_ai_sessions_status").on(table.status),
		index("idx_ai_sessions_started_at").on(table.startedAt),
	]
);

// ===========================================
// call_transcripts - utterance level
// ===========================================
// Rows arrive during the call, not after it: the caller side comes from
// `conversation.item.input_audio_transcription.completed` and the agent side
// from `response.output_audio_transcript.done`. Storing utterances rather
// than one blob is what makes the live transcript view and per-turn timing
// possible.

export const callTranscripts = pgTable(
	"call_transcripts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		callId: uuid("call_id")
			.notNull()
			.references(() => calls.id, { onDelete: "cascade" }),
		aiSessionId: uuid("ai_session_id").references(() => aiSessions.id, {
			onDelete: "set null",
		}),
		role: transcriptRoleEnum("role").notNull(),
		content: text("content").notNull(),
		// Milliseconds from call start, so the dashboard can line an utterance
		// up with a position in the recording.
		startMs: integer("start_ms"),
		endMs: integer("end_ms"),
		// Interim deltas are stored too so the live view can render partials;
		// they are replaced by the final row when it lands.
		isFinal: boolean("is_final").notNull().default(true),
		confidence: integer("confidence"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_transcripts_tenant_call").on(table.tenantId, table.callId),
		index("idx_transcripts_call").on(table.callId),
		index("idx_transcripts_call_start").on(table.callId, table.startMs),
		index("idx_transcripts_session").on(table.aiSessionId),
		index("idx_transcripts_role").on(table.role),
	]
);

// ===========================================
// call_recordings
// ===========================================
// MixMonitor writes into the bind-mounted recordings directory. A call can
// legitimately produce more than one file (for example after a transfer), so
// this is intentionally not a unique index on call_id.

export const callRecordings = pgTable(
	"call_recordings",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		callId: uuid("call_id")
			.notNull()
			.references(() => calls.id, { onDelete: "cascade" }),
		filePath: text("file_path").notNull(),
		fileName: varchar("file_name", { length: 255 }).notNull(),
		format: varchar("format", { length: 10 }).notNull().default("wav"),
		sizeBytes: integer("size_bytes"),
		durationSeconds: integer("duration_seconds"),
		// Marks a row whose file is gone while keeping the row itself, so call
		// history still shows that a recording once existed. Nothing flips it
		// today: this platform has no retention job, and the settings key that
		// implied one was removed rather than left lying.
		isAvailable: boolean("is_available").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_recordings_tenant_created").on(table.tenantId, table.createdAt),
		index("idx_recordings_call").on(table.callId),
		index("idx_recordings_available").on(table.isAvailable),
		index("idx_recordings_created_at").on(table.createdAt),
	]
);

// ===========================================
// call_transfers - AI to human handover
// ===========================================

export const callTransfers = pgTable(
	"call_transfers",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		callId: uuid("call_id")
			.notNull()
			.references(() => calls.id, { onDelete: "cascade" }),
		aiSessionId: uuid("ai_session_id").references(() => aiSessions.id, {
			onDelete: "set null",
		}),
		fromChannelId: varchar("from_channel_id", { length: 150 }),
		toChannelId: varchar("to_channel_id", { length: 150 }),
		toExtension: varchar("to_extension", { length: 10 }).notNull(),
		toOperatorId: uuid("to_operator_id").references(() => operatorProfiles.id, {
			onDelete: "set null",
		}),
		// Why the AI handed over - written from the tool call arguments, and
		// the single most useful field when reviewing whether the agent should
		// have handled it itself.
		reason: text("reason"),
		status: transferStatusEnum("status").notNull().default("requested"),
		requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
		connectedAt: timestamp("connected_at", { withTimezone: true }),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_transfers_tenant_status").on(table.tenantId, table.status),
		index("idx_transfers_call").on(table.callId),
		index("idx_transfers_operator").on(table.toOperatorId),
		index("idx_transfers_status").on(table.status),
	]
);

// ===========================================
// call_notes - AI notes and operator notes
// ===========================================

export const callNotes = pgTable(
	"call_notes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }),
		ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
		authorType: noteAuthorTypeEnum("author_type").notNull().default("ai"),
		// Null for AI/system notes; set for operator-written ones.
		authorUserId: uuid("author_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		content: text("content").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_call_notes_tenant_call").on(table.tenantId, table.callId),
		index("idx_call_notes_call").on(table.callId),
		index("idx_call_notes_ticket").on(table.ticketId),
		index("idx_call_notes_author_type").on(table.authorType),
	]
);

// ===========================================
// follow_up_tasks
// ===========================================
// Created either by the AI's create_follow_up tool or by an operator.

export const followUpTasks = pgTable(
	"follow_up_tasks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
		ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
		contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
		assignedTo: uuid("assigned_to").references(() => operatorProfiles.id, {
			onDelete: "set null",
		}),
		title: varchar("title", { length: 255 }).notNull(),
		description: text("description"),
		dueAt: timestamp("due_at", { withTimezone: true }),
		status: followUpStatusEnum("status").notNull().default("open"),
		// Distinguishes AI-generated work from operator-entered work in
		// reporting, without a join.
		createdBySystem: boolean("created_by_system").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		index("idx_followups_tenant_status_due").on(table.tenantId, table.status, table.dueAt),
		index("idx_followups_status").on(table.status),
		index("idx_followups_due_at").on(table.dueAt),
		index("idx_followups_assigned").on(table.assignedTo),
		index("idx_followups_contact").on(table.contactId),
		index("idx_followups_call").on(table.callId),
	]
);

// ===========================================
// bookings - calendar appointments
// ===========================================

export const bookings = pgTable(
	"bookings",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		contactId: uuid("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
		ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
		assignedTo: uuid("assigned_to").references(() => operatorProfiles.id, {
			onDelete: "set null",
		}),
		title: varchar("title", { length: 255 }).notNull(),
		notes: text("notes"),
		scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
		durationMinutes: integer("duration_minutes").notNull().default(30),
		location: text("location"),
		status: bookingStatusEnum("status").notNull().default("scheduled"),
		createdBySystem: boolean("created_by_system").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_bookings_tenant_scheduled").on(table.tenantId, table.scheduledAt),
		index("idx_bookings_scheduled_at").on(table.scheduledAt),
		index("idx_bookings_contact").on(table.contactId),
		index("idx_bookings_status").on(table.status),
		index("idx_bookings_assigned").on(table.assignedTo),
	]
);

// ===========================================
// sip_extensions - mirror of the PJSIP endpoints
// ===========================================
// Asterisk owns the real configuration; this table exists so the dashboard
// can list extensions, show live registration state, and tie an extension to
// an operator without querying AMI on every page load.

export const sipExtensions = pgTable(
	"sip_extensions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		extension: varchar("extension", { length: 10 }).notNull(),
		displayName: varchar("display_name", { length: 100 }),
		operatorProfileId: uuid("operator_profile_id").references(() => operatorProfiles.id, {
			onDelete: "set null",
		}),
		kind: sipExtensionKindEnum("kind").notNull().default("sip"),
		isEnabled: boolean("is_enabled").notNull().default(true),
		lastRegisteredAt: timestamp("last_registered_at", { withTimezone: true }),
		lastKnownStatus: varchar("last_known_status", { length: 30 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// Per tenant: this mirrors PJSIP endpoints, and endpoint 101 exists once per
		// customer. The endpoint NAME Asterisk sees is tenant-prefixed
		// (lib/tenancy/asterisk-naming.ts); the digits stored here are not.
		uniqueIndex("idx_sip_extensions_tenant_ext").on(table.tenantId, table.extension),
		index("idx_sip_extensions_operator").on(table.operatorProfileId),
	]
);

// ===========================================
// Inferred types
// ===========================================

export type AiSessionRecord = typeof aiSessions.$inferSelect;
export type NewAiSessionRecord = typeof aiSessions.$inferInsert;
export type CallTranscriptRecord = typeof callTranscripts.$inferSelect;
export type NewCallTranscriptRecord = typeof callTranscripts.$inferInsert;
export type CallRecordingRecord = typeof callRecordings.$inferSelect;
export type CallTransferRecord = typeof callTransfers.$inferSelect;
export type CallNoteRecord = typeof callNotes.$inferSelect;
export type FollowUpTaskRecord = typeof followUpTasks.$inferSelect;
export type BookingRecord = typeof bookings.$inferSelect;
export type SipExtensionRecord = typeof sipExtensions.$inferSelect;
