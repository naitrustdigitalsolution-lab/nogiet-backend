CREATE TABLE IF NOT EXISTS "imeo_feed_config" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "mode" varchar(10) DEFAULT 'manual' NOT NULL,
  "active_batch_id" uuid,
  "last_api_test_at" timestamp with time zone,
  "last_api_test_success" boolean,
  "last_api_test_message" text,
  "updated_by" uuid REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "imeo_feed_config_singleton" CHECK ("id" = 1),
  CONSTRAINT "imeo_feed_config_mode" CHECK ("mode" IN ('manual', 'api'))
);
CREATE TABLE IF NOT EXISTS "imeo_upload_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "filename" varchar(255) NOT NULL,
  "checksum" varchar(64) NOT NULL,
  "format" varchar(20) NOT NULL,
  "reporting_month" varchar(7) NOT NULL,
  "uploaded_by" uuid NOT NULL REFERENCES "users"("id"),
  "r2_key" text NOT NULL,
  "record_count" integer NOT NULL,
  "rejected_count" integer DEFAULT 0 NOT NULL,
  "status" varchar(20) DEFAULT 'published' NOT NULL,
  "failure_summary" text,
  "is_active" boolean DEFAULT false NOT NULL,
  "restored_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "imeo_upload_batches_checksum_idx" ON "imeo_upload_batches" ("checksum");
CREATE TABLE IF NOT EXISTS "imeo_manual_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "imeo_upload_batches"("id") ON DELETE CASCADE,
  "source_id" varchar(255) NOT NULL,
  "payload" jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "imeo_manual_records_batch_source_idx" ON "imeo_manual_records" ("batch_id", "source_id");
INSERT INTO "imeo_feed_config" ("id", "mode") VALUES (1, 'manual') ON CONFLICT ("id") DO NOTHING;
