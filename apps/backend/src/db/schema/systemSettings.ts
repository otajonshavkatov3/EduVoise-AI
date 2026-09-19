/**
 * Runtime system settings, stored as typed key/value rows.
 *
 * Everything the Settings page edits has to survive a restart, and the previous
 * Settings page persisted nothing at all - it was a form with no backend. Env
 * vars are the wrong home for operator-editable values (changing one needs a
 * redeploy), so they live here instead.
 *
 * Deliberately key/value rather than a wide table: the setting list grows with
 * every integration, and a migration per setting is friction nobody pays for.
 * `category` groups them for the UI, `isSecret` tells the API to mask the value
 * on read so a token never round-trips to the browser.
 */
import {
	boolean,
	index,
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

export const systemSettings = pgTable(
	"system_settings",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/**
		 * Whose setting this is. The table used to be global, which stopped being
		 * survivable the moment a second customer existed: it holds the AI voice, the
		 * dialect, the timezone, the pricing and the audio chain, and every one of
		 * those is a value a tenant sets for ITSELF. A global row here would have one
		 * customer's supervisor changing the voice that answers another customer's
		 * callers.
		 *
		 * A key with no row for this tenant falls back to the registry default (which
		 * already collapses .env and the built-in default) - deliberately NOT to
		 * another tenant's row, and not to the vendor's, so a missing row can never
		 * resolve to somebody else's choice.
		 */
		tenantId: tenantIdColumn(),
		/** Dotted key, e.g. "notifications.telegram.chatId" or "pricing.usdToUzs". */
		key: varchar("key", { length: 120 }).notNull(),
		/**
		 * Grouping for the Settings UI. The authoritative list is
		 * SETTING_CATEGORIES in lib/settings/registry.ts ("general" | "pricing" |
		 * "notifications"); this column is not constrained to it, so a row left
		 * behind by a removed key keeps its old category harmlessly.
		 */
		category: varchar("category", { length: 40 }).notNull().default("general"),
		/** JSON so a setting can be a string, number, boolean or object without extra columns. */
		value: jsonb("value").$type<unknown>(),
		description: text("description"),
		/**
		 * Masked as "***" when read through the API. The value is still stored in
		 * plain text - this is not encryption, it only keeps tokens out of browser
		 * payloads and audit logs.
		 */
		isSecret: boolean("is_secret").notNull().default(false),
		updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// (tenant, key) is both the uniqueness rule and the index every read uses:
		// the store loads one tenant's whole table in a single query keyed on the
		// tenant prefix.
		uniqueIndex("idx_system_settings_tenant_key").on(table.tenantId, table.key),
		index("idx_system_settings_tenant_category").on(table.tenantId, table.category),
	]
);

export type SystemSettingRecord = typeof systemSettings.$inferSelect;
export type NewSystemSettingRecord = typeof systemSettings.$inferInsert;
