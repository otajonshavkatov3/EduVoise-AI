/**
 * calls, tickets, aiAnalyses — tsikl (calls→tickets→aiAnalyses→calls) tufayli
 * bitta faylda; barcha FK relationlar to'liq ishlaydi.
 */
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
import { contacts } from "./contacts";
import {
	aiStatusEnum,
	callDirectionEnum,
	callStatusEnum,
	sentimentEnum,
	ticketPriorityEnum,
	ticketStatusEnum,
} from "./enums";
import { operatorProfiles } from "./operatorProfiles";
import { tenantIdColumn } from "./tenants";
import { users } from "./users";

// 4. QO'NG'IROQLAR TARIXI (CALL LOGS) - TZ 3.7
//
// CYCLE: calls -> tickets -> aiAnalyses -> calls. It used to be silenced with a
// ts-expect-error directive on each of the three tables, which made their types
// `any`: every insert, select and where clause on the CRM's three most important
// tables went completely unchecked. That was survivable when the only risk was a
// typo. It is not survivable now - a tenant filter nobody type-checks on the
// `calls` table is precisely the defect that lets customer A read customer B's
// calls - so the cycle is broken the way drizzle documents instead: annotate the
// lazy reference callback with AnyPgColumn, which stops the inference recursion
// without weakening anything. The FK and the runtime behaviour are unchanged.
export const calls = pgTable(
	"calls",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/**
		 * Which customer this call belongs to. Written when the call row is created,
		 * from the tenant the inbound context or the outbound campaign identified -
		 * never inferred later, because a call whose tenant is guessed after the fact
		 * is a call that can be guessed into the wrong customer's history.
		 *
		 * This column plus `duration` is also the source phase two's minute ledger
		 * will be built from, which is why it is on the call itself rather than only
		 * on the operator or the campaign.
		 */
		tenantId: tenantIdColumn(),
		direction: callDirectionEnum("direction").notNull(),
		callerNumber: varchar("caller_number", { length: 20 }).notNull(),
		calleeExtension: varchar("callee_extension", { length: 10 }),
		contactId: uuid("contact_id").references(() => contacts.id, {
			onDelete: "set null",
		}),
		// NOTE: operatorId stores operator_profiles.id (NOT users.id)
		operatorId: uuid("operator_id").references(() => operatorProfiles.id, {
			onDelete: "set null",
		}),
		ticketId: uuid("ticket_id").references((): AnyPgColumn => tickets.id, {
			onDelete: "set null",
		}),
		status: callStatusEnum("status").notNull(),
		duration: integer("duration").default(0),
		recordingPath: text("recording_path"),
		aiStatus: aiStatusEnum("ai_status").default("pending"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		// When the call was actually picked up. Additive column: without it the
		// TZ's "average waiting time" metric has no real source, and the dashboard
		// was showing a hardcoded 2.3 minutes instead. Waiting time is
		// answered_at - started_at; NULL means never answered.
		answeredAt: timestamp("answered_at", { withTimezone: true }),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// The three shapes every scoped call query takes: the history page (tenant +
		// recency), the live/status filters, and "what did this number do".
		index("idx_calls_tenant_created").on(table.tenantId, table.createdAt),
		index("idx_calls_tenant_status").on(table.tenantId, table.status),
		index("idx_calls_tenant_caller").on(table.tenantId, table.callerNumber),
		index("idx_calls_caller").on(table.callerNumber),
		index("idx_calls_operator").on(table.operatorId),
		index("idx_calls_created_at").on(table.createdAt),
		index("idx_calls_contact").on(table.contactId),
		index("idx_calls_ticket").on(table.ticketId),
		index("idx_calls_status").on(table.status),
		index("idx_calls_direction").on(table.direction),
	]
);

// 5. TICKETLAR (Murojaatlar) - TZ 3.6, 8.1
export const tickets = pgTable(
	"tickets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		contactId: uuid("contact_id")
			.notNull()
			.references(() => contacts.id),
		createdBy: uuid("created_by")
			.notNull()
			.references(() => users.id),
		subject: varchar("subject", { length: 255 }).notNull(),
		description: text("description").notNull(),
		category: varchar("category", { length: 100 }),
		priority: ticketPriorityEnum("priority").notNull().default("medium"),
		status: ticketStatusEnum("status").notNull().default("new"),
		/**
		 * Reference id returned by whatever external system a business forwards
		 * tickets to (their own CRM, helpdesk, ERP...).
		 *
		 * Replaced a column named after one specific government portal (migrations
		 * 0007 add + 0008 drop, the old column verified empty first). This platform
		 * is a configurable AI call centre sold to many business owners, so the
		 * capability is worth keeping but the name was not.
		 */
		// Unique per tenant rather than globally: it is a reference id in SOMEBODY
		// ELSE's system, and two customers using the same helpdesk product will
		// eventually both hold "TCK-1". Globally unique here would make one
		// customer's import fail because of a row they cannot see.
		externalRefId: varchar("external_ref_id", { length: 100 }),
		aiSummary: text("ai_summary"),
		aiSentiment: sentimentEnum("ai_sentiment"),
		aiCategories: jsonb("ai_categories").$type<string[]>(),
		aiConfidence: integer("ai_confidence"),
		aiAnalysisId: uuid("ai_analysis_id").references((): AnyPgColumn => aiAnalyses.id),
		isDeleted: boolean("is_deleted").notNull().default(false),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
		closedAt: timestamp("closed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("idx_tickets_tenant_external_ref").on(table.tenantId, table.externalRefId),
		index("idx_tickets_tenant_status").on(table.tenantId, table.status),
		index("idx_tickets_tenant_created").on(table.tenantId, table.createdAt),
		index("idx_tickets_status").on(table.status),
		index("idx_tickets_contact").on(table.contactId),
		index("idx_tickets_created_by").on(table.createdBy),
		index("idx_tickets_created_at").on(table.createdAt),
		index("idx_tickets_priority").on(table.priority),
	]
);

// 6. AI TAHLIL JARAYONLARI (Queue Tracking) - TZ 3.8
export const aiAnalyses = pgTable(
	"ai_analyses",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/**
		 * Denormalised from the call. Also one of the two token-cost sources the
		 * vendor's per-tenant margin report reads, so it must be scopable without a
		 * join to calls.
		 */
		tenantId: tenantIdColumn(),
		callId: uuid("call_id")
			.notNull()
			.references((): AnyPgColumn => calls.id, { onDelete: "cascade" }),
		status: aiStatusEnum("status").notNull().default("pending"),
		transcript: text("transcript"),
		summary: text("summary"),
		sentiment: sentimentEnum("sentiment"),
		categories: jsonb("categories").$type<string[]>(),
		confidence: integer("confidence"),
		errorMessage: text("error_message"),
		retryCount: integer("retry_count").default(0),
		// What the post-call summariser (a separate chat-completions call) cost.
		// Lives here rather than on ai_sessions because an analysis can exist for a
		// call that never had an AI session - a supervisor retrying an old call.
		//
		// The counters ACCUMULATE across retries: a call analysed three times cost
		// three times. NOT NULL with default 0 because the accumulate-on-conflict
		// SQL would otherwise propagate NULL. billedRuns is deliberately not
		// retryCount: retryCount also counts the "nothing to analyse" path, which
		// makes no API call and costs nothing.
		analysisModel: varchar("analysis_model", { length: 100 }),
		promptTokens: integer("prompt_tokens").notNull().default(0),
		cachedPromptTokens: integer("cached_prompt_tokens").notNull().default(0),
		completionTokens: integer("completion_tokens").notNull().default(0),
		billedRuns: integer("billed_runs").notNull().default(0),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("idx_ai_call_id").on(table.callId),
		index("idx_ai_tenant_created").on(table.tenantId, table.createdAt),
		index("idx_ai_tenant_status").on(table.tenantId, table.status),
		index("idx_ai_status").on(table.status),
		index("idx_ai_created_at").on(table.createdAt),
	]
);
