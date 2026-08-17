ALTER TABLE "data_feed_config" DROP CONSTRAINT IF EXISTS "data_feed_config_mode";
ALTER TABLE "data_feed_config" ADD CONSTRAINT "data_feed_config_mode" CHECK ("mode" IN ('inactive', 'manual', 'api'));
ALTER TABLE "data_feed_config" ALTER COLUMN "mode" SET DEFAULT 'inactive';
UPDATE "data_feed_config" SET "mode" = 'inactive', "updated_at" = now();
UPDATE "imeo_upload_batches" SET "is_active" = false WHERE "is_active" = true;
