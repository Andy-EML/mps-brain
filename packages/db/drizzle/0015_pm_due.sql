CREATE TABLE "vantage_equipment_contracts" (
	"vantage_equipment_id" integer NOT NULL,
	"contract_id" integer NOT NULL,
	"contract_reference" text,
	"is_active" boolean NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vantage_equipment_contracts_vantage_equipment_id_contract_id_pk" PRIMARY KEY("vantage_equipment_id","contract_id")
);
--> statement-breakpoint
CREATE TABLE "vantage_work_visits" (
	"work_unit_id" integer PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"work_reference" text,
	"vantage_equipment_id" integer,
	"customer_id" integer,
	"category_id" integer,
	"category_name" text,
	"category_type" text,
	"logged_at" timestamp with time zone,
	"work_start" timestamp with time zone,
	"work_end" timestamp with time zone,
	"work_hours" double precision,
	"scheduled_start" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"maintenance_performed" boolean,
	"action_details" text,
	"raw" jsonb NOT NULL,
	"modified_date" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cartridge_families" ADD COLUMN "pm_interval_pages" integer;--> statement-breakpoint
CREATE INDEX "vantage_work_visits_equipment_start_idx" ON "vantage_work_visits" USING btree ("vantage_equipment_id","work_start");