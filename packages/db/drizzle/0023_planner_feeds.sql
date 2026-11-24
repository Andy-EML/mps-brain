CREATE TABLE "postcode_districts" (
	"district" text PRIMARY KEY NOT NULL,
	"county" text,
	"admin_district" text,
	"latitude" double precision,
	"longitude" double precision,
	"status" text NOT NULL,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postcode_districts_status" CHECK (status in ('ok', 'not_found'))
);
--> statement-breakpoint
CREATE TABLE "vantage_engineers" (
	"vantage_id" integer PRIMARY KEY NOT NULL,
	"name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vantage_scheduled_units" (
	"work_unit_id" integer PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"work_reference" text,
	"engineer_id" integer,
	"customer_id" integer,
	"vantage_equipment_id" integer,
	"scheduled_start" timestamp with time zone NOT NULL,
	"category_id" integer,
	"category_name" text,
	"category_type" text,
	"work_start" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vantage_scheduled_units_start_idx" ON "vantage_scheduled_units" USING btree ("scheduled_start");