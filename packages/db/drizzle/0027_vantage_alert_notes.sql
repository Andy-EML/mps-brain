CREATE TABLE "vantage_alert_notes" (
	"note_id" integer PRIMARY KEY NOT NULL,
	"parent_type" text NOT NULL,
	"parent_id" integer NOT NULL,
	"parent_reference" text,
	"text" text,
	"logged_date" timestamp with time zone,
	"logged_by" text,
	"modified_date" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vantage_alert_notes_parent_idx" ON "vantage_alert_notes" USING btree ("parent_type","parent_id");