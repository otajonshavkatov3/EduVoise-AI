import type { UserRoleType } from "@shared/types";
import {
	boolean,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

import { tenantIdColumn } from "./tenants";

/**
 * `vendor` is the platform owner's own role and sits ABOVE every tenant: it is
 * the only role whose holder may list customers and enter one. The three roles
 * that existed before it are tenant-local and unchanged - a customer's
 * supervisor is still the most powerful person inside that customer's account,
 * and cannot see that other customers exist.
 */
export const userRoleEnum = pgEnum("user_role", ["supervisor", "admin", "manager", "vendor"]);

export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().defaultRandom(),

		/**
		 * Which customer this person belongs to. Vendor staff belong to the vendor's
		 * own tenant row (tenants.is_vendor), so this is NOT NULL for everybody: a
		 * user with no tenant is a user who belongs to all of them.
		 */
		tenantId: tenantIdColumn(),

		/**
		 * Unique PLATFORM-WIDE, deliberately not per tenant. Login is a phone and a
		 * password with no tenant field in the form, so a phone has to identify
		 * exactly one account - otherwise the login endpoint has to guess which
		 * customer the caller meant, and guessing wrong is a cross-tenant login.
		 * Extensions collide across tenants; login identities do not.
		 */
		phone: varchar("phone", { length: 20 }).notNull().unique(),
		username: varchar("username", { length: 50 }),
		email: varchar("email", { length: 255 }),

		passwordHash: text("password_hash").notNull(),
		role: userRoleEnum("role").notNull().default("manager"),
		isActive: boolean("is_active").notNull().default(true),

		isDeleted: boolean("is_deleted").notNull().default(false),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		index("idx_users_role").on(table.role),
		index("idx_users_is_active").on(table.isActive),
		// Tenant first, because every scoped query starts with it. The two indexes
		// above are kept for the vendor's own cross-tenant views, which are the only
		// queries that ever filter on role or activity without a tenant.
		index("idx_users_tenant_role").on(table.tenantId, table.role),
		index("idx_users_tenant_active").on(table.tenantId, table.isActive),
	]
);

export type UserRecord = typeof users.$inferSelect;
export type NewUserRecord = typeof users.$inferInsert;
export type { UserRoleType };
