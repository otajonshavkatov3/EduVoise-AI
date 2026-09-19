/**
 * Outbound campaigns: a list of people, a reason for the call, and the AI doing
 * the calling.
 *
 * STRICTLY ADDITIVE, for the same reason aiVoice.ts is: not one existing table or
 * column is altered here, so the migration cannot touch the inbound call path
 * that is already answering real callers. New enums are declared in this file
 * rather than in enums.ts because that file is referenced by every earlier
 * migration and is left alone.
 *
 * FOUR TABLES, AND WHY EACH ONE EXISTS
 *
 *   call_campaigns          the job: who to call about what, when calling is
 *                           allowed, how hard to retry, how many at once.
 *   campaign_leads          one row per person per campaign. Carries the dial
 *                           state the dialer's tick reads and the outcome a
 *                           business acts on.
 *   campaign_call_attempts  one row per dial. A lead can be rung several times
 *                           and each ring is a separate `calls` row with its own
 *                           transcript, recording and AI spend; a single
 *                           `campaign_leads.call_id` would remember only the
 *                           last one, so the campaign's total spend would
 *                           understate itself by every retry. This table is what
 *                           makes "what happened on every row" answerable.
 *   do_not_call_list        numbers that must never be dialled again. Unique on
 *                           the number so adding one twice is a no-op.
 *
 * PHONE NUMBER STORED FORM
 *
 * Digits only, no "+", country code included: "998905706507". Internal PJSIP
 * extensions keep their three digits: "201". That is not a new invention - it is
 * the form `contacts.phone_number` already holds for every seeded row, and the
 * form Asterisk reports on `calls.caller_number`, so a lead, a contact and a call
 * can be matched with `=` instead of a normalising expression that would defeat
 * the index. lib/campaigns/phone.ts is the one place that produces it.
 */
import { sql } from "drizzle-orm";
import {
	check,
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

import { aiAgentProfiles } from "./aiAgent";
import { calls } from "./callTicketAi";
import { contacts } from "./contacts";
import { tenantIdColumn } from "./tenants";
import { users } from "./users";

// ===========================================
// Enums
// ===========================================

/**
 * The campaign lifecycle. `finished` and `cancelled` are both terminal, and they
 * are kept apart on purpose: "we called everyone" and "a human stopped it" are
 * different answers to "why did this stop", and only the second one needs
 * explaining to whoever asked for the campaign.
 */
export const campaignStatusEnum = pgEnum("campaign_status", [
	"draft",
	"running",
	"paused",
	"finished",
	"cancelled",
]);

/**
 * What kind of call this is. Steers the opening sentence and lets the UI group
 * campaigns; it is deliberately coarse, because the specific reason belongs in
 * `purpose`, which is free text the owner writes.
 */
export const campaignKindEnum = pgEnum("campaign_kind", [
	"reminder",
	"sales",
	"promo",
	"survey",
	"other",
]);

/**
 * Where a lead is in the dial queue - NOT what the conversation produced. That is
 * `outcome`, and the two are separate because a lead can be `done` with any of
 * eight business outcomes, and a lead can be `skipped` with none at all.
 *
 * `calling` is a claim: the dialer moves a row into it before originating, which
 * is what the per-campaign concurrency limit counts and what stops a second tick
 * from dialling the same person twice.
 */
export const campaignLeadStatusEnum = pgEnum("campaign_lead_status", [
	"pending",
	"calling",
	"done",
	"failed",
	"skipped",
]);

/**
 * What the call produced, in terms a business can act on.
 *
 * `no_answer` and `busy` are retryable; `refused`, `agreed`, `wrong_person` and
 * `do_not_call` are final answers from a human; `invalid_number` is a fact about
 * the number itself. `failed` is ours, not theirs: the dial never reached anyone.
 */
export const campaignOutcomeEnum = pgEnum("campaign_outcome", [
	"answered",
	"no_answer",
	"busy",
	"invalid_number",
	"refused",
	"agreed",
	"callback_requested",
	"wrong_person",
	"do_not_call",
	"failed",
]);

/**
 * How a number reached the do-not-call list.
 *
 * `asked_on_call` is the one that matters most and the one that may never be
 * removed: the person said so out loud, on a recorded line. `manual` and
 * `import` are typo-able by a human, so those two are removable by an admin.
 */
export const dncSourceEnum = pgEnum("dnc_source", ["asked_on_call", "manual", "import"]);

// ===========================================
// call_campaigns
// ===========================================

export const callCampaigns = pgTable(
	"call_campaigns",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		name: varchar("name", { length: 150 }).notNull(),
		kind: campaignKindEnum("kind").notNull().default("other"),
		/**
		 * The reason for the call, in one sentence, in the owner's own words.
		 *
		 * On an outbound call the person did not choose to be rung, so this is the
		 * first thing they hear after the agent says it is an assistant calling on
		 * behalf of the business. It is NOT NULL because a campaign without a stated
		 * purpose is exactly the cold call nobody should be making.
		 */
		purpose: text("purpose").notNull(),
		/** Extra instructions for this campaign only, appended to the agent's own prompt. */
		script: text("script"),
		/**
		 * Which agent persona speaks. NULL means "whichever profile is active", which
		 * is the same default the inbound path uses, so a campaign does not silently
		 * pin itself to a profile the owner later edited into something else.
		 */
		agentProfileId: uuid("agent_profile_id").references(() => aiAgentProfiles.id, {
			onDelete: "set null",
		}),
		status: campaignStatusEnum("status").notNull().default("draft"),
		/**
		 * The calling window, as zero-padded wall-clock HH:MM in the tenant's zone
		 * (`general.timezone`). Nobody may be rung at 03:00, so this is NOT NULL with
		 * a working-hours default and a CHECK that keeps it inside 07:00-22:00.
		 *
		 * Stored as text rather than `time` because it is compared against a wall
		 * clock, never against an instant: zero-padded HH:MM sorts lexicographically,
		 * so `start <= now < end` is a plain string comparison with no zone left in
		 * it. See lib/campaigns/window.ts.
		 */
		callWindowStart: varchar("call_window_start", { length: 5 }).notNull().default("09:00"),
		callWindowEnd: varchar("call_window_end", { length: 5 }).notNull().default("18:00"),
		/** How many times one no-answer may be retried before the lead is given up on. */
		maxAttempts: integer("max_attempts").notNull().default(2),
		/** The wait between attempts on the same lead. Minutes, so an hour is 60. */
		retryDelayMinutes: integer("retry_delay_minutes").notNull().default(60),
		/**
		 * How many calls this campaign may have in flight at once. Default 1: a
		 * campaign that saturates the trunk also blocks the inbound line the business
		 * actually earns money on, and one AI voice session per concurrent call is
		 * also one provider quota slot.
		 */
		concurrency: integer("concurrency").notNull().default(1),
		/** Audit trail: who built it. `set null` keeps the campaign when the user is deleted. */
		createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
		/** Audit trail: who authorised the spending and the ringing, and when. */
		startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		pausedAt: timestamp("paused_at", { withTimezone: true }),
		/** Set when the campaign reached either terminal state; `status` says which. */
		endedAt: timestamp("ended_at", { withTimezone: true }),
		endedBy: uuid("ended_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The dialer's tick asks "which campaigns are running"; the list page filters
		// on status and sorts by recency.
		index("idx_campaigns_tenant_status").on(table.tenantId, table.status),
		index("idx_campaigns_tenant_created").on(table.tenantId, table.createdAt),
		index("idx_campaigns_status").on(table.status),
		index("idx_campaigns_created_at").on(table.createdAt),
		index("idx_campaigns_created_by").on(table.createdBy),
		index("idx_campaigns_profile").on(table.agentProfileId),
		// The API validates all of this too. The constraints are here because the
		// dialer, a future import script and a hand-run UPDATE all write these rows,
		// and "03:00" reaching this column would mean ringing somebody at 03:00.
		check(
			"call_campaigns_window_format_chk",
			sql`${table.callWindowStart} ~ '^[0-2][0-9]:[0-5][0-9]$' AND ${table.callWindowEnd} ~ '^[0-2][0-9]:[0-5][0-9]$'`
		),
		check(
			"call_campaigns_window_order_chk",
			sql`${table.callWindowStart} < ${table.callWindowEnd}`
		),
		// No overnight window and no dawn calls: the window has to sit inside the
		// hours a stranger may reasonably be phoned.
		check(
			"call_campaigns_window_bounds_chk",
			sql`${table.callWindowStart} >= '07:00' AND ${table.callWindowEnd} <= '22:00'`
		),
		check(
			"call_campaigns_limits_chk",
			sql`${table.maxAttempts} BETWEEN 1 AND 10 AND ${table.retryDelayMinutes} BETWEEN 5 AND 1440 AND ${table.concurrency} BETWEEN 1 AND 20`
		),
	]
);

// ===========================================
// campaign_leads
// ===========================================

export const campaignLeads = pgTable(
	"campaign_leads",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		campaignId: uuid("campaign_id")
			.notNull()
			.references(() => callCampaigns.id, { onDelete: "cascade" }),
		/** Normalised stored form - see the file header. varchar(20) matches `contacts`. */
		phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
		fullName: varchar("full_name", { length: 150 }),
		/**
		 * The CRM contact this number already belongs to, when one exists. Linked on
		 * import and never created there: a lead is somebody we intend to phone, and
		 * turning every imported row into a contact would fill the CRM with people
		 * nobody has spoken to yet.
		 */
		contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
		/**
		 * Per-lead merge values the purpose and script may reference - an amount owed,
		 * a product, a date. Without these every call says the identical sentence,
		 * which is the difference between a follow-up and a robocall.
		 */
		variables: jsonb("variables").$type<Record<string, string>>(),
		status: campaignLeadStatusEnum("status").notNull().default("pending"),
		outcome: campaignOutcomeEnum("outcome"),
		attempts: integer("attempts").notNull().default(0),
		lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
		/**
		 * When this lead becomes dialable again. NULL means "as soon as possible".
		 * Written from `retry_delay_minutes` after a no-answer, which is what bounds
		 * a retry to a delay instead of an immediate second ring.
		 */
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		/**
		 * The most recent call, so the UI can jump straight to /calls/:id where the
		 * transcript, the recording and the cost already live. Every attempt is in
		 * campaign_call_attempts; this is the shortcut, not the history.
		 */
		callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
		note: text("note"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One row per number per campaign. This is both the "already in this campaign"
		// import skip reason and the guarantee that a number cannot be dialled twice
		// by one campaign because it appeared twice in a spreadsheet.
		uniqueIndex("idx_campaign_leads_campaign_phone").on(table.campaignId, table.phoneNumber),
		// THE index the dialer's tick uses, in its column order:
		//   WHERE campaign_id = $1 AND status = 'pending'
		//     AND (next_attempt_at IS NULL OR next_attempt_at <= now())
		//   ORDER BY next_attempt_at NULLS FIRST
		// Its (campaign_id, status) prefix also serves the progress counts and the
		// concurrency check, so no separate two-column index is defined.
		index("idx_campaign_leads_due").on(table.campaignId, table.status, table.nextAttemptAt),
		index("idx_campaign_leads_outcome").on(table.campaignId, table.outcome),
		// Number-first, campaign-second: asked when a number lands on the do-not-call
		// list and every campaign still holding it has to be taken out of the queue.
		// Number-first WITHIN the tenant: asked when a number lands on that tenant's
		// do-not-call list and every campaign of theirs still holding it has to be
		// taken out of the queue. The unscoped index below is kept because the dialer
		// also asks the question per campaign, where the campaign already fixes the
		// tenant.
		index("idx_campaign_leads_tenant_phone").on(table.tenantId, table.phoneNumber),
		index("idx_campaign_leads_phone").on(table.phoneNumber),
		index("idx_campaign_leads_call").on(table.callId),
		index("idx_campaign_leads_contact").on(table.contactId),
		check("campaign_leads_attempts_chk", sql`${table.attempts} >= 0`),
	]
);

// ===========================================
// campaign_call_attempts
// ===========================================

export const campaignCallAttempts = pgTable(
	"campaign_call_attempts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		campaignId: uuid("campaign_id")
			.notNull()
			.references(() => callCampaigns.id, { onDelete: "cascade" }),
		leadId: uuid("lead_id")
			.notNull()
			.references(() => campaignLeads.id, { onDelete: "cascade" }),
		/** 1-based, matching `campaign_leads.attempts` after this attempt was counted. */
		attemptNo: integer("attempt_no").notNull(),
		/**
		 * NULL when the dial failed before a call row existed at all (no trunk, ARI
		 * refused the originate). Non-null rows are what the campaign's spend is
		 * priced from, together with the lead's own `call_id`.
		 */
		callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
		outcome: campaignOutcomeEnum("outcome"),
		/** Why it ended the way it did - an ARI error, a hangup cause, the AI's own words. */
		detail: text("detail"),
		dialedAt: timestamp("dialed_at", { withTimezone: true }).defaultNow().notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
	},
	(table) => [
		// Deliberately NOT unique on (lead_id, attempt_no). A duplicate attempt number
		// is a cosmetic defect in the history; a unique violation raised inside the
		// dialer would leave a lead stuck in `calling` with a live channel, which is a
		// real one.
		index("idx_campaign_attempts_tenant_dialed").on(table.tenantId, table.dialedAt),
		index("idx_campaign_attempts_lead").on(table.leadId, table.attemptNo),
		index("idx_campaign_attempts_campaign").on(table.campaignId, table.dialedAt),
		index("idx_campaign_attempts_call").on(table.callId),
	]
);

// ===========================================
// do_not_call_list
// ===========================================

export const doNotCallList = pgTable(
	"do_not_call_list",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		/** Normalised the same way a lead is, or the check before a dial would miss. */
		phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
		reason: text("reason"),
		source: dncSourceEnum("source").notNull().default("manual"),
		/** The call the person asked on, when that is how they got here. */
		callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
		/** The person who added it by hand. NULL for `asked_on_call`, which the AI writes. */
		createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// Unique on the number: this is what makes adding a number idempotent, so the
		// AI writing it three times in one conversation stays one row, and the first
		// reason - the one the person actually gave - is the one that is kept.
		// Per tenant: one customer asking not to be called by call centre A says
		// nothing about call centre B, and a global list would leak the fact that
		// another tenant has that number at all.
		uniqueIndex("idx_dnc_tenant_phone").on(table.tenantId, table.phoneNumber),
		index("idx_dnc_source").on(table.source),
		index("idx_dnc_created_at").on(table.createdAt),
	]
);

// ===========================================
// Inferred types
// ===========================================

export type CallCampaignRecord = typeof callCampaigns.$inferSelect;
export type NewCallCampaignRecord = typeof callCampaigns.$inferInsert;
export type CampaignLeadRecord = typeof campaignLeads.$inferSelect;
export type NewCampaignLeadRecord = typeof campaignLeads.$inferInsert;
export type CampaignCallAttemptRecord = typeof campaignCallAttempts.$inferSelect;
export type NewCampaignCallAttemptRecord = typeof campaignCallAttempts.$inferInsert;
export type DoNotCallRecord = typeof doNotCallList.$inferSelect;
export type NewDoNotCallRecord = typeof doNotCallList.$inferInsert;

export type CampaignStatus = (typeof campaignStatusEnum.enumValues)[number];
export type CampaignKind = (typeof campaignKindEnum.enumValues)[number];
export type CampaignLeadStatus = (typeof campaignLeadStatusEnum.enumValues)[number];
export type CampaignOutcome = (typeof campaignOutcomeEnum.enumValues)[number];
export type DncSource = (typeof dncSourceEnum.enumValues)[number];
