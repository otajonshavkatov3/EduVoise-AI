ALTER TABLE "tenants"
  ALTER COLUMN "webhook_token"
  SET DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
