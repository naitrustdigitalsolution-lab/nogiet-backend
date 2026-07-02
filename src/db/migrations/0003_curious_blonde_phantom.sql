ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'facility_owner';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "field_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb,
	"latitude" real NOT NULL,
	"longitude" real NOT NULL,
	"weather_conditions" varchar(255),
	"equipment_used" varchar(255),
	"notes" text,
	"methane_reading" real NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "facilities" ADD COLUMN IF NOT EXISTS "state" varchar(100);--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN IF NOT EXISTS "lga" varchar(100);--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN IF NOT EXISTS "oil_block" varchar(100);--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN IF NOT EXISTS "operator" varchar(255);--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN IF NOT EXISTS "facility_type" varchar(100);--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN IF NOT EXISTS "alert_threshold" real;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "field_submissions" ADD CONSTRAINT "field_submissions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "field_submissions" ADD CONSTRAINT "field_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "geofences" ADD CONSTRAINT "geofences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
