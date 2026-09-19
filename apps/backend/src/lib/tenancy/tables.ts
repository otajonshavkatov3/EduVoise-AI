/**
 * WHICH TABLES ARE TENANT-OWNED, written down once so it can be checked.
 *
 * 25 tables existed before tenancy and every single one of them turned out to
 * hold customer data. That is not an accident: this platform's schema is nothing
 * but a call centre's own working data. "Global" is where the leaks hide, so the
 * only table that is not tenant-scoped is the tenant registry itself, plus
 * drizzle's own migration bookkeeping, which is not in this schema at all.
 *
 * TABLE-BY-TABLE, and why:
 *
 *   users, refresh_tokens, user_sessions       the customer's own staff and their
 *                                             sessions. Vendor staff are users of
 *                                             the vendor's tenant row.
 *   operator_profiles, operator_status_logs    their operators and shift history.
 *   contacts                                   their customer list.
 *   calls, tickets, ai_analyses                the record of their business.
 *   ai_sessions, call_transcripts,             what was said, recorded and paid
 *   call_recordings, call_transfers,           for on their calls.
 *   call_notes
 *   follow_up_tasks, bookings                  work their operators must do.
 *   ai_agent_profiles,                         who their agent is and what it may
 *   knowledge_base_entries                     say. Leaking this makes the AI
 *                                              quote a stranger's prices.
 *   sip_extensions                             the mirror of their PJSIP endpoints.
 *   call_campaigns, campaign_leads,            their outbound calling.
 *   campaign_call_attempts, do_not_call_list
 *   audit_logs                                 who did what to whose data,
 *                                              including the vendor.
 *   system_settings                            their voice, dialect, timezone,
 *                                              pricing and audio chain.
 *
 * AND THE ONE THAT IS NOT:
 *
 *   tenants   the registry of customers. It cannot carry a tenant_id without
 *             being its own parent, and it is readable only by the vendor
 *             (routes/vendor) or, for a single row, by its own tenant. This is
 *             the ONLY table where a query without a tenant filter is correct.
 *
 * The list is not documentation - tables.test.ts walks the real schema and fails
 * if any pgTable is missing from both lists, so a table added in a later phase
 * cannot quietly arrive without a tenant column.
 */
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/db/schema";

/**
 * A table that can be scoped: it has a `tenantId` column. Used as a constraint so
 * a helper cannot be handed a table that has nothing to filter on.
 */
export type TenantScopedTable = PgTable & { tenantId: PgColumn };

/** Table names that are deliberately NOT tenant-scoped. Keep it justified above. */
export const GLOBAL_TABLE_NAMES: readonly string[] = ["tenants"];

/** True when this table carries a tenant_id column. */
export function isTenantScopedTable(table: PgTable): table is TenantScopedTable {
	return "tenantId" in table && Boolean((table as Record<string, unknown>).tenantId);
}

/**
 * Every pgTable exported by the schema, by export name.
 *
 * Reads the module rather than a hand-written list: a table nobody remembered to
 * add to a list is exactly the table that leaks.
 */
export function allSchemaTables(): { name: string; table: PgTable }[] {
	const found: { name: string; table: PgTable }[] = [];

	for (const [name, exported] of Object.entries(schema as Record<string, unknown>)) {
		// A pgTable is an object carrying drizzle's own table symbols. Checking for
		// the Name symbol is enough, and needs no import of drizzle internals - which
		// matters, because this walk has to keep working when drizzle's types change.
		if (
			exported !== null &&
			typeof exported === "object" &&
			Symbol.for("drizzle:Name") in (exported as Record<symbol, unknown>) &&
			Symbol.for("drizzle:Columns") in (exported as Record<symbol, unknown>)
		) {
			found.push({ name, table: exported as PgTable });
		}
	}

	return found;
}

/** The SQL name of a drizzle table, for messages and for the global-table check. */
export function tableName(table: PgTable): string {
	return (table as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "";
}
