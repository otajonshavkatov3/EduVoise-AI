import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./tenants";
import { users } from "./users";

export const userSessions = pgTable(
	"user_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** Denormalised from the user, for the same reason as refresh_tokens. */
		tenantId: tenantIdColumn(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sessionId: varchar("session_id", { length: 100 }).notNull().unique(),
		deviceId: varchar("device_id", { length: 100 }),
		ipAddress: varchar("ip_address", { length: 45 }),
		userAgent: text("user_agent"),
		isActive: boolean("is_active").notNull().default(true),
		lastActivityAt: timestamp("last_activity_at", {
			withTimezone: true,
		}).defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_sessions_tenant_user").on(table.tenantId, table.userId),
		index("idx_sessions_user").on(table.userId),
		uniqueIndex("idx_sessions_id").on(table.sessionId),
		index("idx_sessions_active").on(table.isActive),
	]
);
