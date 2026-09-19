import { boolean, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./tenants";
import { users } from "./users";

export const refreshTokens = pgTable(
	"refresh_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/**
		 * Denormalised from the owning user on purpose. A token is looked up before
		 * the user row is loaded, so without this column the lookup cannot be scoped
		 * and a token would be a tenant-free credential for the length of one query.
		 */
		tenantId: tenantIdColumn(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		revoked: boolean("revoked").default(false),
		deviceId: varchar("device_id", { length: 100 }),
		ipAddress: varchar("ip_address", { length: 45 }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_refresh_tenant_user").on(table.tenantId, table.userId),
		index("idx_refresh_user").on(table.userId),
		index("idx_refresh_token_hash").on(table.tokenHash),
		index("idx_refresh_expires").on(table.expiresAt),
	]
);
