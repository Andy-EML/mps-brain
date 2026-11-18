CREATE TABLE "vantage_meter_readings" (
	"vantage_id" integer PRIMARY KEY NOT NULL,
	"vantage_equipment_id" integer NOT NULL,
	"meter_type_id" integer NOT NULL,
	"meter_type_name" text,
	"meter_class" text,
	"reading_type_id" integer,
	"reading_at" timestamp with time zone NOT NULL,
	"reading" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"modified_date" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vantage_meter_readings_equipment_at_idx" ON "vantage_meter_readings" USING btree ("vantage_equipment_id","reading_at");