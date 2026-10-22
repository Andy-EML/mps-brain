CREATE TABLE "cartridge_families" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_colour" boolean NOT NULL,
	"rated_yield_black" integer,
	"rated_yield_cyan" integer,
	"rated_yield_magenta" integer,
	"rated_yield_yellow" integer,
	"rated_yield_waste" integer,
	"notes" text,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cartridge_families_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "cartridge_family_models" (
	"model" text PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_stock_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"shelf_id" integer NOT NULL,
	"alarm_id" text NOT NULL,
	"drms_equipment_id" text,
	"colour" text,
	"received_at" timestamp with time zone NOT NULL,
	"counted" boolean NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_stock_shelves" (
	"id" serial PRIMARY KEY NOT NULL,
	"vantage_customer_id" integer NOT NULL,
	"family_id" integer NOT NULL,
	"holding_black" integer DEFAULT 0 NOT NULL,
	"holding_cyan" integer DEFAULT 0 NOT NULL,
	"holding_magenta" integer DEFAULT 0 NOT NULL,
	"holding_yellow" integer DEFAULT 0 NOT NULL,
	"holding_waste" integer DEFAULT 0 NOT NULL,
	"used_black" integer DEFAULT 0 NOT NULL,
	"used_cyan" integer DEFAULT 0 NOT NULL,
	"used_magenta" integer DEFAULT 0 NOT NULL,
	"used_yellow" integer DEFAULT 0 NOT NULL,
	"used_waste" integer DEFAULT 0 NOT NULL,
	"counting_from" timestamp with time zone NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_stock_shelves_holding" CHECK (holding_black between 0 and 20 and holding_cyan between 0 and 20 and holding_magenta between 0 and 20 and holding_yellow between 0 and 20 and holding_waste between 0 and 20),
	CONSTRAINT "site_stock_shelves_used" CHECK (used_black >= 0 and used_cyan >= 0 and used_magenta >= 0 and used_yellow >= 0 and used_waste >= 0)
);
--> statement-breakpoint
DROP INDEX "replenishment_proposals_live_uq";--> statement-breakpoint
ALTER TABLE "replenishment_proposals" ADD COLUMN "shelf_id" integer;--> statement-breakpoint
ALTER TABLE "cartridge_families" ADD CONSTRAINT "cartridge_families_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cartridge_family_models" ADD CONSTRAINT "cartridge_family_models_family_id_cartridge_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."cartridge_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_stock_events" ADD CONSTRAINT "site_stock_events_shelf_id_site_stock_shelves_id_fk" FOREIGN KEY ("shelf_id") REFERENCES "public"."site_stock_shelves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_stock_events" ADD CONSTRAINT "site_stock_events_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_stock_shelves" ADD CONSTRAINT "site_stock_shelves_family_id_cartridge_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."cartridge_families"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_stock_shelves" ADD CONSTRAINT "site_stock_shelves_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_stock_shelves" ADD CONSTRAINT "site_stock_shelves_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_stock_events_shelf_alarm_uq" ON "site_stock_events" USING btree ("shelf_id","alarm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_stock_shelves_customer_family_uq" ON "site_stock_shelves" USING btree ("vantage_customer_id","family_id");--> statement-breakpoint
ALTER TABLE "replenishment_proposals" ADD CONSTRAINT "replenishment_proposals_shelf_id_site_stock_shelves_id_fk" FOREIGN KEY ("shelf_id") REFERENCES "public"."site_stock_shelves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_proposals_shelf_live_uq" ON "replenishment_proposals" USING btree ("shelf_id","colour") WHERE status in ('pending', 'approved') and shelf_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_proposals_live_uq" ON "replenishment_proposals" USING btree ("drms_equipment_id","colour") WHERE status in ('pending', 'approved') and shelf_id is null;