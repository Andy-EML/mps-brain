CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replenishment_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"vantage_equipment_id" integer NOT NULL,
	"status" text NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"vantage_sales_order_id" integer,
	"vantage_reference" text,
	"is_on_hold" boolean,
	"error" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"resolved_by" integer,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "replenishment_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"vantage_equipment_id" integer,
	"colour" text NOT NULL,
	"trigger" text NOT NULL,
	"level" double precision,
	"threshold" integer,
	"alarm_id" text,
	"alarm_description" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"order_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "replenishment_proposals_quantity" CHECK (quantity between 1 and 20)
);
--> statement-breakpoint
CREATE TABLE "replenishment_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"vantage_customer_id" integer,
	"drms_equipment_id" text,
	"threshold_black" integer,
	"threshold_cyan" integer,
	"threshold_magenta" integer,
	"threshold_yellow" integer,
	"auto_replenish" boolean,
	"alerts_enabled" boolean,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replenishment_settings_scope_key" CHECK ((scope = 'default' and vantage_customer_id is null and drms_equipment_id is null)
       or (scope = 'customer' and vantage_customer_id is not null and drms_equipment_id is null)
       or (scope = 'device' and drms_equipment_id is not null and vantage_customer_id is null)),
	CONSTRAINT "replenishment_settings_threshold_range" CHECK (coalesce(threshold_black, 0) between 0 and 100 and coalesce(threshold_cyan, 0) between 0 and 100
       and coalesce(threshold_magenta, 0) between 0 and 100 and coalesce(threshold_yellow, 0) between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_orders" ADD CONSTRAINT "replenishment_orders_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_proposals" ADD CONSTRAINT "replenishment_proposals_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_proposals" ADD CONSTRAINT "replenishment_proposals_order_id_replenishment_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."replenishment_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_proposals" ADD CONSTRAINT "replenishment_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_settings" ADD CONSTRAINT "replenishment_settings_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_settings" ADD CONSTRAINT "replenishment_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_at_idx" ON "audit_log" USING btree ("entity","at");--> statement-breakpoint
CREATE INDEX "replenishment_orders_status_idx" ON "replenishment_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "replenishment_orders_device_idx" ON "replenishment_orders" USING btree ("drms_equipment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_proposals_live_uq" ON "replenishment_proposals" USING btree ("drms_equipment_id","colour") WHERE status in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "replenishment_proposals_status_idx" ON "replenishment_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_settings_default_uq" ON "replenishment_settings" USING btree ("scope") WHERE scope = 'default';--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_settings_customer_uq" ON "replenishment_settings" USING btree ("vantage_customer_id") WHERE scope = 'customer';--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_settings_device_uq" ON "replenishment_settings" USING btree ("drms_equipment_id") WHERE scope = 'device';--> statement-breakpoint
-- The one default row. Every threshold here is the agreed starting point (spec 2026-09-21):
-- black 15%, cyan/magenta/yellow 10%, auto-replenish and alerts on. Editable from the UI.
INSERT INTO "replenishment_settings" ("scope", "threshold_black", "threshold_cyan", "threshold_magenta", "threshold_yellow", "auto_replenish", "alerts_enabled")
VALUES ('default', 15, 10, 10, 10, true, true);