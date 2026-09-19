-- Each tenant gets the secret that lives in its own FreePBX webhook URL.
--
-- The legacy webhooks are unauthenticated and their payload carries no tenant, so
-- with two customers there was nothing to say whose call was being reported and
-- the endpoint could only refuse. A per-tenant path segment identifies AND
-- authenticates in one step, and a PBX only ever needs a URL.
--
-- Added nullable, backfilled, then made NOT NULL, so an existing row is never
-- rejected mid-migration.
ALTER TABLE "tenants" ADD COLUMN "webhook_token" varchar(64);

UPDATE "tenants"
SET "webhook_token" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE "webhook_token" IS NULL;

ALTER TABLE "tenants" ALTER COLUMN "webhook_token" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_tenants_webhook_token" ON "tenants" ("webhook_token");
