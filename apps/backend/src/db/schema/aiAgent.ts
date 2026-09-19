/**
 * Business-configurable AI agent: the product's core.
 *
 * This platform is sold to business owners who plug it into their own phone line
 * and let the AI answer callers instead of (or alongside) human operators. So
 * nothing about WHAT the agent knows or HOW it speaks may be hardcoded — the
 * previous prompt was written for one municipal hotline, with fixed categories
 * (Yo'l/Suv/Gaz/Elektr), which is useless for a clinic, a taxi firm or a shop.
 *
 * Two tables:
 *   ai_agent_profiles      who the agent is for this business, how it speaks,
 *                          what it may promise, which categories it may file.
 *   knowledge_base_entries what it is allowed to tell callers. This is the
 *                          "gives information" half of the product: the agent
 *                          answers from these entries instead of improvising,
 *                          which is what keeps it from inventing prices,
 *                          addresses or opening hours.
 *
 * Multiple profiles are allowed (one active at a time) so a business can edit a
 * draft, or A/B a new persona, without editing the one answering live calls.
 */
import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./tenants";
import { users } from "./users";

/** How the agent should behave when it cannot answer from the knowledge base. */
export const unknownAnswerPolicy = ["transfer", "take_message", "say_unknown"] as const;
export type UnknownAnswerPolicy = (typeof unknownAnswerPolicy)[number];

export const aiAgentProfiles = pgTable(
	"ai_agent_profiles",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),

		// --- Identity of the business the agent answers for ---
		/** Shown in the dashboard, and spoken in the greeting. */
		businessName: varchar("business_name", { length: 150 }).notNull(),
		/** Free text, e.g. "stomatologiya klinikasi", "taksi xizmati". Steers tone and vocabulary. */
		industry: varchar("industry", { length: 100 }),
		/** What the business actually does, in the owner's own words. Goes into the prompt. */
		businessDescription: text("business_description"),

		// --- Voice and language ---
		language: varchar("language", { length: 10 }).notNull().default("uz"),
		/** Extra languages the agent may switch into if the caller does. */
		additionalLanguages: jsonb("additional_languages").$type<string[]>(),
		voice: varchar("voice", { length: 50 }).notNull().default("alloy"),
		/** First line the caller hears. Empty means "generate from businessName". */
		greeting: text("greeting"),
		/** Recording notice, spoken once. Some businesses are legally required to. */
		recordingNotice: text("recording_notice"),

		// --- Behaviour ---
		/** Owner-written rules appended to the system prompt ("never quote prices", ...). */
		customInstructions: text("custom_instructions"),
		/** Ticket categories THIS business uses. Replaces the hardcoded municipal list. */
		ticketCategories: jsonb("ticket_categories").$type<string[]>(),
		/** What to do when the knowledge base has no answer. */
		unknownPolicy: varchar("unknown_policy", { length: 20 }).notNull().default("transfer"),
		/** Extensions a caller may be transferred to, in preference order. */
		transferExtensions: jsonb("transfer_extensions").$type<string[]>(),
		/** null = always open. Shape: { tz, days: { mon: [["09:00","18:00"]], ... } } */
		businessHours: jsonb("business_hours").$type<Record<string, unknown>>(),
		/** Spoken when a call arrives outside business hours. */
		afterHoursMessage: text("after_hours_message"),

		// --- Limits ---
		maxCallSeconds: integer("max_call_seconds").notNull().default(900),
		silenceHangupMs: integer("silence_hangup_ms").notNull().default(20000),

		/**
		 * Exactly one profile answers calls. Enforced by a partial unique index
		 * below rather than in application code, so two concurrent activations
		 * cannot both win.
		 */
		isActive: boolean("is_active").notNull().default(false),

		createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// Partial unique index: any number of drafts, but only ONE active row PER
		// TENANT. Enforced in Postgres rather than in application code so two
		// concurrent "activate this profile" requests cannot both succeed and leave
		// the orchestrator picking an arbitrary one - and scoped to the tenant
		// because the pre-tenancy version of this index would have let exactly one
		// customer on the whole platform have a working agent.
		uniqueIndex("idx_ai_agent_profiles_tenant_active")
			.on(table.tenantId, table.isActive)
			.where(sql`${table.isActive} IS TRUE`),
		index("idx_ai_agent_profiles_tenant").on(table.tenantId),
		index("idx_ai_agent_profiles_name").on(table.businessName),
	]
);

export const knowledgeBaseEntries = pgTable(
	"knowledge_base_entries",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/**
		 * Denormalised from the profile. This is the table that decides what the AI
		 * is allowed to say out loud, so it must be filterable by tenant without a
		 * join: a retrieval that reaches another customer's entries would have the
		 * agent quoting a stranger's prices to a caller.
		 */
		tenantId: tenantIdColumn(),
		agentProfileId: uuid("agent_profile_id")
			.notNull()
			.references(() => aiAgentProfiles.id, { onDelete: "cascade" }),

		/** What a caller might ask, in their words. Used for matching. */
		question: text("question").notNull(),
		/** What the agent should say. This is the ONLY thing it may assert as fact. */
		answer: text("answer").notNull(),
		/** Free tags for grouping in the UI and for narrowing a search. */
		tags: jsonb("tags").$type<string[]>(),
		/** Higher wins when several entries match. Lets an owner pin a promo answer. */
		priority: integer("priority").notNull().default(0),
		isActive: boolean("is_active").notNull().default(true),

		/** Counted on every retrieval so the owner can see what callers actually ask. */
		useCount: integer("use_count").notNull().default(0),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),

		createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_kb_tenant_profile").on(table.tenantId, table.agentProfileId, table.isActive),
		index("idx_kb_profile").on(table.agentProfileId),
		index("idx_kb_active").on(table.isActive),
		index("idx_kb_priority").on(table.priority),
	]
);

export type AiAgentProfileRecord = typeof aiAgentProfiles.$inferSelect;
export type NewAiAgentProfileRecord = typeof aiAgentProfiles.$inferInsert;
export type KnowledgeBaseEntryRecord = typeof knowledgeBaseEntries.$inferSelect;
export type NewKnowledgeBaseEntryRecord = typeof knowledgeBaseEntries.$inferInsert;
