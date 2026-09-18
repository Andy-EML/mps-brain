CREATE TABLE "device_alarms" (
	"alarm_id" text PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"received_time" timestamp with time zone NOT NULL,
	"fc_code" text,
	"sc_code" text,
	"description" text,
	"status" text,
	"total_count" bigint,
	"total_color_count" bigint,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"category" text
);
--> statement-breakpoint
ALTER TABLE "device_alarms" ADD CONSTRAINT "device_alarms_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_alarms_device_received_idx" ON "device_alarms" USING btree ("drms_equipment_id","received_time");--> statement-breakpoint
CREATE INDEX "device_alarms_category_received_idx" ON "device_alarms" USING btree ("category","received_time");--> statement-breakpoint
CREATE INDEX "device_alarms_status_idx" ON "device_alarms" USING btree ("status");