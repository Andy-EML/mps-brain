CREATE TABLE "cartridge_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"colour" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"alarm_id" text,
	"low_snapshot_id" integer,
	"high_snapshot_id" integer,
	"low_level" double precision,
	"high_level" double precision,
	"outcome" text NOT NULL,
	"reason" text,
	"proposal_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_stock_events" ALTER COLUMN "alarm_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "replenishment_settings" ADD COLUMN "spare_black" boolean;--> statement-breakpoint
ALTER TABLE "replenishment_settings" ADD COLUMN "spare_black_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_stock_events" ADD COLUMN "source" text DEFAULT 'empty_alarm' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_stock_events" ADD COLUMN "high_snapshot_id" integer;--> statement-breakpoint
ALTER TABLE "site_stock_events" ADD COLUMN "low_snapshot_id" integer;--> statement-breakpoint
ALTER TABLE "cartridge_changes" ADD CONSTRAINT "cartridge_changes_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cartridge_changes" ADD CONSTRAINT "cartridge_changes_proposal_id_replenishment_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."replenishment_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cartridge_changes_uq" ON "cartridge_changes" USING btree ("drms_equipment_id","colour","source","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_stock_events_level_uq" ON "site_stock_events" USING btree ("shelf_id","drms_equipment_id","colour","high_snapshot_id") WHERE source = 'level';--> statement-breakpoint
UPDATE "replenishment_settings" SET "spare_black" = true, "spare_black_from" = now() WHERE "scope" = 'default';
