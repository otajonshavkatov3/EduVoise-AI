/**
 * The audit trail, and - since tenancy - the ONLY record that the vendor entered
 * a customer's account.
 *
 * Two tenant columns, not one, because "whose data was touched" and "who touched
 * it" stop being the same question the moment a super-admin exists:
 *
 *   tenant_id        the tenant the action AFFECTED. A customer reading their own
 *                    audit log filters on this and sees everything that happened
 *                    to them, including what the vendor did.
 *   actor_tenant_id  the tenant the person who acted belongs to. Equal to
 *                    tenant_id for every ordinary action; the vendor's tenant
 *                    when the vendor is acting inside a customer's account.
 *
 * `is_vendor_access` is derivable (actor_tenant_id <> tenant_id today) and is
 * stored anyway: it is the column the "who from the vendor looked at my calls"
 * view filters on, it stays correct if a second vendor-side tenant ever exists,
 * and a boolean index is what makes that view cheap on a table with millions of
 * ordinary rows.
 */
import type { TenantId } from "@shared/types";
import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

import { tenantIdColumn, tenants } from "./tenants";
import { users } from "./users";

export const auditLogs = pgTable(
	"audit_logs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** The tenant whose data this action affected. */
		tenantId: tenantIdColumn(),
		/**
		 * The tenant the actor belongs to. Same FK rules as tenantIdColumn(), spelled
		 * out because the column name differs.
		 */
		actorTenantId: uuid("actor_tenant_id")
			.$type<TenantId>()
			.notNull()
			.references(() => tenants.id, { onDelete: "restrict" }),
		/** True when a vendor acted inside a customer's account. */
		isVendorAccess: boolean("is_vendor_access").notNull().default(false),
		userId: uuid("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		action: varchar("action", { length: 100 }).notNull(),
		entityType: varchar("entity_type", { length: 50 }),
		entityId: uuid("entity_id"),
		details: jsonb("details"),
		ipAddress: varchar("ip_address", { length: 45 }),
		userAgent: text("user_agent"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_audit_user").on(table.userId),
		index("idx_audit_created").on(table.createdAt),
		index("idx_audit_action").on(table.action),
		index("idx_audit_entity_type").on(table.entityType),
		index("idx_audit_tenant_created").on(table.tenantId, table.createdAt),
		index("idx_audit_tenant_action").on(table.tenantId, table.action),
		// "Every time the vendor was inside this account, newest first." Partial, so
		// it stays small however large the ordinary trail grows.
		index("idx_audit_vendor_access")
			.on(table.tenantId, table.createdAt)
			.where(sql`${table.isVendorAccess} IS TRUE`),
	]
);
