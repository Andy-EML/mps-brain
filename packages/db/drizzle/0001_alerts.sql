CREATE TABLE "device_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"type" text NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_report_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"acknowledged_by" integer,
	"acknowledged_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_alerts" ADD CONSTRAINT "device_alerts_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_alerts" ADD CONSTRAINT "device_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_alerts_open_uq" ON "device_alerts" USING btree ("drms_equipment_id","type") WHERE cleared_at is null;--> statement-breakpoint
CREATE INDEX "device_alerts_type_cleared_idx" ON "device_alerts" USING btree ("type","cleared_at");