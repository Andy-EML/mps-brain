CREATE TABLE "app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counter_names" (
	"name" text PRIMARY KEY NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"sample_value" double precision,
	"category" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counter_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"counter_id" text NOT NULL,
	"received_time" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counter_values" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"snapshot_id" bigint NOT NULL,
	"item_number" text,
	"name" text NOT NULL,
	"value" double precision,
	"color_mode" text,
	"mode" text
);
--> statement-breakpoint
CREATE TABLE "customer_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_erp_id" text NOT NULL,
	"vantage_customer_id" integer NOT NULL,
	"method" text NOT NULL,
	"device_count" integer DEFAULT 0 NOT NULL,
	"linked_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_links_customer_erp_id_unique" UNIQUE("customer_erp_id")
);
--> statement-breakpoint
CREATE TABLE "device_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"vantage_equipment_id" integer NOT NULL,
	"method" text NOT NULL,
	"linked_by" integer,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone,
	"unlinked_reason" text
);
--> statement-breakpoint
CREATE TABLE "drms_customers" (
	"drms_id" text PRIMARY KEY NOT NULL,
	"erp_id" text,
	"name" text,
	"csrc_ids" text[],
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drms_equipment" (
	"drms_id" text PRIMARY KEY NOT NULL,
	"erp_id" text,
	"serial" text,
	"serial_norm" text,
	"model_name" text,
	"product_name" text,
	"status" text,
	"communication_type" text,
	"customer_erp_id" text,
	"customer_name" text,
	"customer_csrc_id" text,
	"registration_time" timestamp with time zone,
	"initial_connection_time" timestamp with time zone,
	"last_counter_received_time" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_since" timestamp with time zone,
	"last_snapshot_fetch_at" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_key" text NOT NULL,
	"type" text NOT NULL,
	"drms_equipment_id" text,
	"vantage_equipment_id" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" integer,
	"resolved_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "link_issues_issue_key_unique" UNIQUE("issue_key")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_sample" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'operator' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "vantage_customers" (
	"vantage_id" integer PRIMARY KEY NOT NULL,
	"reference" text,
	"name" text,
	"is_active" boolean,
	"is_on_stop" boolean,
	"modified_date" timestamp with time zone,
	"deleted_date" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vantage_equipment" (
	"vantage_id" integer PRIMARY KEY NOT NULL,
	"serial" text,
	"serial_norm" text,
	"asset_number" text,
	"description" text,
	"item_part_number" text,
	"vantage_customer_id" integer,
	"customer_reference" text,
	"customer_name" text,
	"location" text,
	"install_date" timestamp with time zone,
	"modified_date" timestamp with time zone,
	"deleted_date" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "counter_snapshots" ADD CONSTRAINT "counter_snapshots_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_values" ADD CONSTRAINT "counter_values_snapshot_id_counter_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."counter_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_links" ADD CONSTRAINT "customer_links_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_links" ADD CONSTRAINT "device_links_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_links" ADD CONSTRAINT "device_links_vantage_equipment_id_vantage_equipment_vantage_id_fk" FOREIGN KEY ("vantage_equipment_id") REFERENCES "public"."vantage_equipment"("vantage_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_links" ADD CONSTRAINT "device_links_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_issues" ADD CONSTRAINT "link_issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counter_snapshots_device_counter_uq" ON "counter_snapshots" USING btree ("drms_equipment_id","counter_id");--> statement-breakpoint
CREATE INDEX "counter_snapshots_device_received_idx" ON "counter_snapshots" USING btree ("drms_equipment_id","received_time");--> statement-breakpoint
CREATE INDEX "counter_values_snapshot_idx" ON "counter_values" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "counter_values_name_idx" ON "counter_values" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "device_links_active_drms_uq" ON "device_links" USING btree ("drms_equipment_id") WHERE unlinked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_links_active_vantage_uq" ON "device_links" USING btree ("vantage_equipment_id") WHERE unlinked_at is null;--> statement-breakpoint
CREATE INDEX "drms_equipment_serial_norm_idx" ON "drms_equipment" USING btree ("serial_norm");--> statement-breakpoint
CREATE INDEX "drms_equipment_erp_id_idx" ON "drms_equipment" USING btree ("erp_id");--> statement-breakpoint
CREATE INDEX "link_issues_status_type_idx" ON "link_issues" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "sync_runs_job_started_idx" ON "sync_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "vantage_equipment_serial_norm_idx" ON "vantage_equipment" USING btree ("serial_norm");--> statement-breakpoint
CREATE INDEX "vantage_equipment_customer_idx" ON "vantage_equipment" USING btree ("vantage_customer_id");