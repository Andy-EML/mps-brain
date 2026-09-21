CREATE TABLE "drms_registrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"serial" text,
	"device_name" text,
	"drms_customer_name" text,
	"vantage_equipment_id" integer,
	"vantage_customer_id" integer,
	"vantage_customer_name" text,
	"status" text NOT NULL,
	"reason" text,
	"customer_match" text,
	"request" jsonb,
	"request_id" text,
	"response" jsonb,
	"drms_status_after" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"note" text,
	"submitted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"retry_requested_by" integer,
	"retry_requested_at" timestamp with time zone,
	CONSTRAINT "drms_registrations_status" CHECK (status in ('awaiting_approval', 'waiting', 'approved', 'registered', 'failed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "drms_registrations" ADD CONSTRAINT "drms_registrations_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drms_registrations" ADD CONSTRAINT "drms_registrations_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drms_registrations" ADD CONSTRAINT "drms_registrations_retry_requested_by_users_id_fk" FOREIGN KEY ("retry_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drms_registrations_live_uq" ON "drms_registrations" USING btree ("drms_equipment_id") WHERE status in ('awaiting_approval', 'waiting', 'approved');--> statement-breakpoint
CREATE INDEX "drms_registrations_status_idx" ON "drms_registrations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "drms_registrations_device_idx" ON "drms_registrations" USING btree ("drms_equipment_id","id");