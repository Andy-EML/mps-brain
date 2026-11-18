CREATE TABLE "pm_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"vantage_equipment_id" integer NOT NULL,
	"kind" text NOT NULL,
	"booked_for" date,
	"reference" text,
	"reason" text,
	"note" text,
	"snooze_until" date,
	"serviced_on" date,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_reason" text
);
--> statement-breakpoint
ALTER TABLE "pm_actions" ADD CONSTRAINT "pm_actions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pm_actions_open_equipment_idx" ON "pm_actions" USING btree ("vantage_equipment_id") WHERE "pm_actions"."cleared_at" is null;