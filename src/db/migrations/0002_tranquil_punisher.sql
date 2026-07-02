ALTER TABLE "satellite_sources" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "satellite_sources" CASCADE;--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "facility_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "source_name" varchar(255);--> statement-breakpoint
ALTER TABLE "ground_measurements" ADD COLUMN IF NOT EXISTS "latitude" real;--> statement-breakpoint
ALTER TABLE "ground_measurements" ADD COLUMN IF NOT EXISTS "longitude" real;
