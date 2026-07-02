ALTER TABLE "alerts" ALTER COLUMN "facility_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "source_name" varchar(255);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "geofences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"geometry" jsonb NOT NULL,
	"alert_enabled" boolean DEFAULT true NOT NULL,
	"threshold" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "name" varchar(255);--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "geometry" jsonb;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "alert_enabled" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "threshold" real;--> statement-breakpoint
ALTER TABLE "geofences" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
UPDATE "geofences" SET "alert_enabled" = true WHERE "alert_enabled" IS NULL;--> statement-breakpoint
UPDATE "geofences" SET "created_at" = now() WHERE "created_at" IS NULL;--> statement-breakpoint
ALTER TABLE "geofences" ALTER COLUMN "alert_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "geofences" ALTER COLUMN "alert_enabled" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "geofences" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "geofences" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "geofences" ADD CONSTRAINT "geofences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
