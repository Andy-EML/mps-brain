CREATE TABLE "pm_plan" (
	"vantage_equipment_id" integer PRIMARY KEY NOT NULL,
	"when_in_area" boolean DEFAULT false NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	"board_column" text,
	"board_note" text,
	"added_at" timestamp with time zone,
	"asked_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"done_reason" text,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pm_plan_board_column" CHECK (board_column is null or board_column in ('to_plan', 'asked', 'done')),
	CONSTRAINT "pm_plan_done_reason" CHECK (done_reason is null or done_reason in ('visit', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "pm_plan" ADD CONSTRAINT "pm_plan_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;