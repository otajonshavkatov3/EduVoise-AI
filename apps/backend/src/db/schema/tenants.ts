/**
 * A tenant is ONE CUSTOMER of this platform: a call centre that logged in,
 * created its own operators and bought time.
 *
 * Everything else in this schema hangs off this table. Every row of customer
 * data carries `tenant_id`, and the only rows that do not are the tenants
 * themselves - see lib/tenancy/tables.ts, where that claim is enforced by a test
 * rather than by memory.
 *
 * WHY A SLUG. The slug is not decoration. Extension numbers collide across
 * customers on purpose - "101" is an operator code, and two customers will both
 * have one - so isolation cannot live in the digits the customer dials. It lives
 * in the PJSIP endpoint name and the dialplan context, both derived from this
 * slug (lib/tenancy/asterisk-naming.ts). A customer types 101 and reaches their
 * own 101 because the endpoint is `avilab-101` in context `from-internal-avilab`.
 *
 * WHY THE AI KEY LIVES HERE. The key is OURS, never theirs: customers never type
 * a Google key. The vendor may assign a distinct key per customer so one
 * customer's quota cannot starve another, so the column has to exist from the
 * start. NULL means "use the platform key from the environment", which is what
 * every tenant does until the vendor assigns one. It is a secret: it is listed in
 * TENANT_SECRET_COLUMNS and stripped by toPublicTenant(), so no HTTP response can
 * carry it even by accident.
 *
 * WHERE THE MINUTE BALANCE WILL GO - decided here so phase two does not have to
 * rewrite history. NOT a column on this table. It becomes a sibling append-only
 * ledger (`tenant_minute_transactions`: purchase +50 000, call -3, refund +12,
 * each with the call or invoice it came from) plus, if the read cost ever
 * justifies it, a derived cache column added later. Reasons, in order:
 *   1. A single `minutes_remaining` integer cannot answer "why is my balance
 *      412"; a customer who paid 70 000 000 so'm will ask, and an append-only
 *      ledger is the only answer that survives the question.
 *   2. A ledger is written, never rewritten, so adding it later does not touch a
 *      single existing row. A balance column added later is equally additive.
 *      Both directions stay open; going the other way (column first, ledger
 *      later) means reconstructing months of history from call rows.
 *   3. The history it would be reconstructed from already exists and is already
 *      tenant-scoped: `calls.tenant_id` plus `calls.duration`. That is the seam,
 *      and it is complete as of this migration.
 *
 * AND THE SECOND METER, kept strictly apart. The minutes above are what the
 * customer bought. The AI token cost is NOT deducted from them - it is the
 * vendor's own cost of goods, aggregated per tenant from `ai_sessions` and
 * `ai_analyses` token counters (now tenant-scoped) by lib/ai-cost. Two meters,
 * two sources, never netted against each other: one is revenue the customer
 * consumes, the other is expense the vendor pays. Nothing in this file mixes
 * them, and nothing later should.
 */
import type { TenantId } from "@shared/types";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

/**
 * trial     - evaluating, may call, no time bought yet
 * active    - paying customer
 * suspended - out of time or unpaid; login works, calling does not (phase two)
 * closed    - offboarded; nothing works, data retained
 *
 * The auth middleware already refuses `suspended` and `closed` (lib/auth), so
 * the day the balance logic lands it only has to flip this column.
 */
export const tenantStatusEnum = pgEnum("tenant_status", ["trial", "active", "suspended", "closed"]);

export type TenantStatus = (typeof tenantStatusEnum.enumValues)[number];

export const tenants = pgTable(
	"tenants",
	{
		// Branded here as well as on every tenant_id, so a tenant row read from this
		// table hands its own id straight to a scoped query with no cast.
		id: uuid("id").primaryKey().defaultRandom().$type<TenantId>(),

		/** Shown to the vendor and to the customer's own users. */
		name: varchar("name", { length: 150 }).notNull(),
		/**
		 * Lowercase identifier, unique platform-wide. Used in PJSIP endpoint names
		 * and dialplan context names, so the character set is deliberately narrow:
		 * anything Asterisk would treat as a separator is rejected by the CHECK.
		 */
		slug: varchar("slug", { length: 40 }).notNull(),
		status: tenantStatusEnum("status").notNull().default("trial"),

		/**
		 * The vendor's own tenant - exactly one row, enforced by a partial unique
		 * index. Vendor staff are users of this row, which is what keeps
		 * `users.tenant_id` NOT NULL: a user with no tenant would be a user valid
		 * inside every tenant, and that is the shape of the leak this whole
		 * migration exists to prevent.
		 */
		isVendor: boolean("is_vendor").notNull().default(false),

		// --- Who to call when something is wrong ---
		contactPerson: varchar("contact_person", { length: 150 }),
		contactPhone: varchar("contact_phone", { length: 20 }),
		contactEmail: varchar("contact_email", { length: 255 }),

		/**
		 * IANA zone. Every wall-clock decision this tenant makes is taken in it:
		 * campaign call windows, business hours, report day boundaries. NOT NULL
		 * with an Uzbekistan default because "no timezone" silently means UTC, and
		 * a campaign window of 09:00-18:00 UTC rings people at 14:00-23:00 local.
		 */
		timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Tashkent"),

		// --- The AI key. Ours, not theirs. See the file header. ---
		/** Which provider the key belongs to; NULL when no per-tenant key is set. */
		aiApiKeyProvider: varchar("ai_api_key_provider", { length: 20 }),
		/** SECRET. NULL = use the platform key from the environment. */
		aiApiKey: text("ai_api_key"),

		// --- Their SIP trunk. Their numbers are their own. ---
		sipTrunkHost: varchar("sip_trunk_host", { length: 255 }),
		sipTrunkPort: integer("sip_trunk_port"),
		sipTrunkUsername: varchar("sip_trunk_username", { length: 100 }),
		/** SECRET. */
		sipTrunkPassword: text("sip_trunk_password"),
		/** Some carriers authenticate on a domain that is not the host. */
		sipTrunkFromDomain: varchar("sip_trunk_from_domain", { length: 255 }),
		/** False for an IP-authenticated trunk, which must not send a REGISTER. */
		sipTrunkRegister: boolean("sip_trunk_register").notNull().default(true),
		/** Caller id presented on this tenant's outbound calls. */
		sipOutboundCallerId: varchar("sip_outbound_caller_id", { length: 32 }),

		/**
		 * The secret in this tenant's own webhook URL.
		 *
		 * The legacy FreePBX webhooks are unauthenticated - a PBX cannot send a bearer
		 * token - and their payload carries no tenant, so with two customers on the
		 * platform there was nothing to tell whose call was being reported and the
		 * endpoint could only refuse. A per-tenant path segment fixes both halves at
		 * once: it identifies the tenant AND authenticates the caller, and a PBX only
		 * ever needs a URL. Same pattern as a Slack or Stripe webhook URL.
		 *
		 * Long and random because it is a bearer credential in disguise. Rotatable:
		 * changing it invalidates the old URL immediately.
		 */
		webhookToken: varchar("webhook_token", { length: 64 })
			.notNull()
			.default(
				sql`replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')`
			),

		notes: text("notes"),

		/**
		 * The vendor user who onboarded them. NULL for the rows the migration seeded.
		 *
		 * Deliberately NOT a foreign key to `users`. Every user belongs to a tenant,
		 * so a FK here would close the loop users -> tenants -> users; Postgres would
		 * accept that, but drizzle's type inference cannot resolve either table's type
		 * and every column on both becomes `any` - which silently removes the type
		 * checking this entire phase depends on. The value is written by the vendor
		 * console from the authenticated user's id and is only ever displayed.
		 */
		createdBy: uuid("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("idx_tenants_slug").on(table.slug),
		// Unique because it is a credential: two tenants sharing one would make the
		// webhook ambiguous again, which is the bug it exists to remove.
		uniqueIndex("idx_tenants_webhook_token").on(table.webhookToken),
		index("idx_tenants_status").on(table.status),
		// One vendor tenant, enforced in Postgres: two rows claiming to be the
		// vendor would make "is this request from the vendor" ambiguous.
		uniqueIndex("idx_tenants_vendor_singleton")
			.on(table.isVendor)
			.where(sql`${table.isVendor} IS TRUE`),
		// The slug reaches Asterisk configuration as an endpoint name and a context
		// name. A slug with a space, a dot or a slash in it would either break the
		// generated pjsip.conf or, worse, merge two tenants into one context.
		check("tenants_slug_format_chk", sql`${table.slug} ~ '^[a-z][a-z0-9-]{1,39}$'`),
	]
);

export type TenantRecord = typeof tenants.$inferSelect;
export type NewTenantRecord = typeof tenants.$inferInsert;

/**
 * The `tenant_id` column, written once and used by every tenant-owned table.
 *
 * One helper rather than 25 hand-written columns, because the three properties
 * that matter have to be identical everywhere and a hand-written column is where
 * one of them goes missing:
 *
 *   NOT NULL   - a NULL tenant_id is a row visible to nobody or, once somebody
 *                writes `OR tenant_id IS NULL`, to everybody.
 *   FK         - a tenant_id pointing at no tenant is data that outlives its
 *                owner and eventually gets counted in somebody else's report.
 *   RESTRICT   - deliberately not CASCADE. `DELETE FROM tenants` must not be able
 *                to destroy a customer's calls, recordings and transcripts as a
 *                side effect. Offboarding is `status = 'closed'`, which keeps the
 *                data and stops the access; an actual purge is a separate,
 *                explicit operation that deletes the child rows first and is
 *                therefore impossible to do by accident.
 *
 * It lives in this file rather than its own so the import cycle stays two modules
 * long (a table file imports tenants, tenants lazily references users), matching
 * how calls/tickets already reference each other.
 */
export function tenantIdColumn() {
	return (
		uuid("tenant_id")
			// The brand is what makes eq(calls.tenantId, someOtherUuid) a compile
			// error rather than a silent cross-tenant read. See shared/types/tenant.ts.
			.$type<TenantId>()
			.notNull()
			.references(() => tenants.id, { onDelete: "restrict" })
	);
}
