import {
	boolean,
	index,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { operatorStatusEnum } from "./enums";
import { tenantIdColumn } from "./tenants";
import { users } from "./users";

export const operatorProfiles = pgTable(
	"operator_profiles",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		tenantId: tenantIdColumn(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/**
		 * Unique PER TENANT, not platform-wide - this is the decision the whole
		 * telephony design rests on. "101" is an operator code, so two customers
		 * will both have one, and renaming a customer's extensions to make them
		 * globally unique would mean the customer no longer dials the number they
		 * were given. They are separated instead: the PJSIP endpoint carries the
		 * tenant slug and the dialplan context is the tenant's own, so 101 reaches
		 * that tenant's 101 and cannot reach anybody else's.
		 */
		extension: varchar("extension", { length: 10 }).notNull(),
		currentStatus: operatorStatusEnum("current_status").notNull().default("offline"),
		lastStatusChange: timestamp("last_status_change", {
			withTimezone: true,
		}).defaultNow(),
		isDeleted: boolean("is_deleted").notNull().default(false),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("idx_operator_user_id").on(table.userId),
		uniqueIndex("idx_operator_tenant_extension").on(table.tenantId, table.extension),
		index("idx_operator_tenant_status").on(table.tenantId, table.currentStatus),
	]
);
