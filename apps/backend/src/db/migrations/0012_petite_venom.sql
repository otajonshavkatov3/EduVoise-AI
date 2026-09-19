-- ===========================================================================
-- TENANT ISOLATION. Phase one of four.
--
-- Adds the tenants table and a NOT NULL tenant_id to all 25 existing tables,
-- and moves every existing row onto the demo tenant IN THIS MIGRATION - there is
-- no manual step, and no window in which a row has no owner.
--
-- ORDER MATTERS, and drizzle's generated order would have failed on the first
-- statement: `ADD COLUMN tenant_id uuid NOT NULL` cannot be applied to a table
-- that already holds 132 calls. So the generated statements are reordered here:
--
--   1. the tenant_status enum and the `vendor` user role
--   2. the tenants table, its indexes and its CHECK
--   3. the two seed rows: the vendor's own tenant, and the demo customer
--   4. tenant_id added NULLABLE everywhere
--   5. THE BACKFILL: every existing row -> the demo tenant
--   6. NOT NULL set, now that every row has a value
--   7. old global uniqueness dropped, foreign keys and (tenant_id, ...) indexes
--      created
--
-- Steps 4-6 are the whole reason this is hand-ordered. Everything else is
-- drizzle's own output, unchanged.
-- ===========================================================================

CREATE TYPE "public"."tenant_status" AS ENUM('trial', 'active', 'suspended', 'closed');--> statement-breakpoint
-- Postgres 12+ allows ADD VALUE inside a transaction as long as the new value is
-- not USED in the same transaction. Nothing below writes a 'vendor' user; the
-- vendor account is created by scripts/seed-vendor (bun run db:seed:vendor).
ALTER TYPE "public"."user_role" ADD VALUE 'vendor';--> statement-breakpoint

CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"slug" varchar(40) NOT NULL,
	"status" "tenant_status" DEFAULT 'trial' NOT NULL,
	"is_vendor" boolean DEFAULT false NOT NULL,
	"contact_person" varchar(150),
	"contact_phone" varchar(20),
	"contact_email" varchar(255),
	"timezone" varchar(64) DEFAULT 'Asia/Tashkent' NOT NULL,
	"ai_api_key_provider" varchar(20),
	"ai_api_key" text,
	"sip_trunk_host" varchar(255),
	"sip_trunk_port" integer,
	"sip_trunk_username" varchar(100),
	"sip_trunk_password" text,
	"sip_trunk_from_domain" varchar(255),
	"sip_trunk_register" boolean DEFAULT true NOT NULL,
	"sip_outbound_caller_id" varchar(32),
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_format_chk" CHECK ("tenants"."slug" ~ '^[a-z][a-z0-9-]{1,39}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_slug" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_tenants_status" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_vendor_singleton" ON "tenants" USING btree ("is_vendor") WHERE "tenants"."is_vendor" IS TRUE;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The two seed rows.
--
--   vendor  the platform owner's own tenant. Vendor staff are users of it, which
--           is what lets users.tenant_id be NOT NULL for everybody.
--   avilab  the demo customer - the account this platform was built against, and
--           the owner of every row that existed before tenancy.
--
-- Ids are generated, not hardcoded: nothing in the code keys off a tenant's id
-- value (the vendor row is found by is_vendor, the demo row by slug), so a magic
-- uuid would be a constant with nothing to justify it. The slug is the stable
-- identifier, which is why it is unique and CHECK-constrained.
--
-- ON CONFLICT DO NOTHING on the slug keeps the migration replayable.
-- ---------------------------------------------------------------------------
INSERT INTO "tenants" ("name", "slug", "status", "is_vendor", "timezone")
VALUES ('Platforma egasi', 'vendor', 'active', true, 'Asia/Tashkent')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "tenants" ("name", "slug", "status", "is_vendor", "timezone")
VALUES ('AviLab', 'avilab', 'active', false, 'Asia/Tashkent')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. tenant_id, nullable for exactly as long as the backfill below takes.
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_agent_profiles" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_base_entries" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "call_notes" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "call_recordings" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "call_transfers" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "sip_extensions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "is_vendor_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "call_campaigns" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_call_attempts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "do_not_call_list" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "operator_profiles" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "operator_status_logs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. THE BACKFILL. Every row that existed before tenancy belongs to the demo
--    customer: its users, its 5 operators, its 130+ calls, its recordings,
--    transcripts, tickets, campaigns, settings and audit trail. On a fresh
--    install these update nothing, which is correct.
--
--    Written as a plain UPDATE per table rather than derived through joins on
--    purpose: with one customer the answer is the same either way, and a join
--    would fail on precisely the rows a join cannot reach (a call_note whose
--    call was deleted, an audit row whose user is gone).
--
--    Each one reads the demo tenant's id by slug, which is why the inserts above
--    do not need to know it either.
-- ---------------------------------------------------------------------------
UPDATE "ai_agent_profiles" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "knowledge_base_entries" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "ai_sessions" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "bookings" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "call_notes" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "call_recordings" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "call_transcripts" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "call_transfers" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "follow_up_tasks" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "sip_extensions" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "audit_logs" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "audit_logs" SET "actor_tenant_id" = "tenant_id" WHERE "actor_tenant_id" IS NULL;--> statement-breakpoint
UPDATE "ai_analyses" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "calls" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "tickets" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "call_campaigns" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "campaign_call_attempts" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "campaign_leads" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "do_not_call_list" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "contacts" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "operator_profiles" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "operator_status_logs" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "refresh_tokens" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "system_settings" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "user_sessions" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "users" SET "tenant_id" = (SELECT "id" FROM "tenants" WHERE "slug" = 'avilab') WHERE "tenant_id" IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. NOT NULL. From here on a row with no owner is impossible, which is the
--    property every scoped query depends on.
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_agent_profiles" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_entries" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "call_notes" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "call_recordings" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "call_transcripts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "call_transfers" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sip_extensions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ALTER COLUMN "actor_tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_analyses" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "call_campaigns" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_call_attempts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_leads" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "do_not_call_list" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_profiles" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_status_logs" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "system_settings" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Uniqueness that was platform-wide and must not be.
--
--    Extensions, contact phone numbers, do-not-call entries, external ticket
--    references, setting keys and the "one active agent profile" rule were all
--    global. Every one of them becomes per tenant below - a global rule here
--    would either leak the existence of another customer's row or refuse a
--    customer's own perfectly valid data.
-- ---------------------------------------------------------------------------
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_external_ref_id_unique";--> statement-breakpoint
ALTER TABLE "operator_profiles" DROP CONSTRAINT "operator_profiles_extension_unique";--> statement-breakpoint
DROP INDEX "idx_ai_agent_profiles_active";--> statement-breakpoint
DROP INDEX "idx_sip_extensions_ext";--> statement-breakpoint
DROP INDEX "idx_tickets_external_ref";--> statement-breakpoint
DROP INDEX "idx_dnc_phone";--> statement-breakpoint
DROP INDEX "idx_contacts_phone";--> statement-breakpoint
DROP INDEX "idx_system_settings_key";--> statement-breakpoint
DROP INDEX "idx_system_settings_category";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Foreign keys. ON DELETE restrict everywhere, deliberately: `DELETE FROM
-- tenants` must not be able to destroy a customer's calls, recordings and
-- transcripts as a side effect. Offboarding is status = 'closed'.
-- ---------------------------------------------------------------------------
ALTER TABLE "ai_agent_profiles" ADD CONSTRAINT "ai_agent_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_entries" ADD CONSTRAINT "knowledge_base_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transfers" ADD CONSTRAINT "call_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_tasks" ADD CONSTRAINT "follow_up_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sip_extensions" ADD CONSTRAINT "sip_extensions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_tenant_id_tenants_id_fk" FOREIGN KEY ("actor_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_campaigns" ADD CONSTRAINT "call_campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_call_attempts" ADD CONSTRAINT "campaign_call_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "do_not_call_list" ADD CONSTRAINT "do_not_call_list_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_profiles" ADD CONSTRAINT "operator_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_status_logs" ADD CONSTRAINT "operator_status_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The indexes the scoped queries need. tenant_id is the LEADING column in every
-- one of them: an index that starts with anything else is a full scan per
-- request once there is more than one customer in the table.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "idx_ai_agent_profiles_tenant_active" ON "ai_agent_profiles" USING btree ("tenant_id","is_active") WHERE "ai_agent_profiles"."is_active" IS TRUE;--> statement-breakpoint
CREATE INDEX "idx_ai_agent_profiles_tenant" ON "ai_agent_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_kb_tenant_profile" ON "knowledge_base_entries" USING btree ("tenant_id","agent_profile_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_ai_sessions_tenant_started" ON "ai_sessions" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_bookings_tenant_scheduled" ON "bookings" USING btree ("tenant_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_call_notes_tenant_call" ON "call_notes" USING btree ("tenant_id","call_id");--> statement-breakpoint
CREATE INDEX "idx_recordings_tenant_created" ON "call_recordings" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_transcripts_tenant_call" ON "call_transcripts" USING btree ("tenant_id","call_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_tenant_status" ON "call_transfers" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_followups_tenant_status_due" ON "follow_up_tasks" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sip_extensions_tenant_ext" ON "sip_extensions" USING btree ("tenant_id","extension");--> statement-breakpoint
CREATE INDEX "idx_audit_tenant_created" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_tenant_action" ON "audit_logs" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "idx_audit_vendor_access" ON "audit_logs" USING btree ("tenant_id","created_at") WHERE "audit_logs"."is_vendor_access" IS TRUE;--> statement-breakpoint
CREATE INDEX "idx_ai_tenant_created" ON "ai_analyses" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_tenant_status" ON "ai_analyses" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_calls_tenant_created" ON "calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_calls_tenant_status" ON "calls" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_calls_tenant_caller" ON "calls" USING btree ("tenant_id","caller_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tickets_tenant_external_ref" ON "tickets" USING btree ("tenant_id","external_ref_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_tenant_status" ON "tickets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_tickets_tenant_created" ON "tickets" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_campaigns_tenant_status" ON "call_campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_campaigns_tenant_created" ON "call_campaigns" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_campaign_attempts_tenant_dialed" ON "campaign_call_attempts" USING btree ("tenant_id","dialed_at");--> statement-breakpoint
CREATE INDEX "idx_campaign_leads_tenant_phone" ON "campaign_leads" USING btree ("tenant_id","phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_dnc_tenant_phone" ON "do_not_call_list" USING btree ("tenant_id","phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contacts_tenant_phone" ON "contacts" USING btree ("tenant_id","phone_number");--> statement-breakpoint
CREATE INDEX "idx_contacts_tenant_created" ON "contacts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_operator_tenant_extension" ON "operator_profiles" USING btree ("tenant_id","extension");--> statement-breakpoint
CREATE INDEX "idx_operator_tenant_status" ON "operator_profiles" USING btree ("tenant_id","current_status");--> statement-breakpoint
CREATE INDEX "idx_status_logs_tenant_started" ON "operator_status_logs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_refresh_tenant_user" ON "refresh_tokens" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_system_settings_tenant_key" ON "system_settings" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "idx_system_settings_tenant_category" ON "system_settings" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "idx_sessions_tenant_user" ON "user_sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_users_tenant_role" ON "users" USING btree ("tenant_id","role");--> statement-breakpoint
CREATE INDEX "idx_users_tenant_active" ON "users" USING btree ("tenant_id","is_active");
