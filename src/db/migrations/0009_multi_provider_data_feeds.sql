ALTER TABLE "imeo_upload_batches" ADD COLUMN IF NOT EXISTS "provider" varchar(30) DEFAULT 'imeo' NOT NULL;
ALTER TABLE "imeo_upload_batches" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
ALTER TABLE "imeo_upload_batches" ADD COLUMN IF NOT EXISTS "last_reminder_at" timestamp with time zone;
DROP INDEX IF EXISTS "imeo_upload_batches_checksum_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "imeo_upload_batches_provider_checksum_idx" ON "imeo_upload_batches" ("provider", "checksum");
CREATE TABLE IF NOT EXISTS "data_feed_config" (
  "provider" varchar(30) PRIMARY KEY NOT NULL,
  "mode" varchar(10) DEFAULT 'inactive' NOT NULL,
  "active_batch_id" uuid,
  "last_api_test_at" timestamp with time zone,
  "last_api_test_success" boolean,
  "last_api_test_message" text,
  "updated_by" uuid REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "data_feed_config_mode" CHECK ("mode" IN ('inactive', 'manual', 'api')),
  CONSTRAINT "data_feed_config_provider" CHECK ("provider" IN ('imeo', 'carbon_mapper', 'tropomi', 'emit'))
);
INSERT INTO "data_feed_config" ("provider", "mode", "active_batch_id")
SELECT 'imeo', 'inactive', "active_batch_id" FROM "imeo_feed_config" WHERE "id" = 1
ON CONFLICT ("provider") DO NOTHING;
INSERT INTO "data_feed_config" ("provider", "mode") VALUES
  ('carbon_mapper', 'inactive'), ('tropomi', 'inactive'), ('emit', 'inactive')
ON CONFLICT ("provider") DO NOTHING;
