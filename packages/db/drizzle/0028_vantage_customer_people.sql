CREATE TABLE "vantage_customer_people" (
	"person_id" integer PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"full_name" text,
	"role" text,
	"phone" text,
	"extension" text,
	"mobile" text,
	"email" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"modified_date" timestamp with time zone,
	"raw" jsonb NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "vantage_customer_people_customer_idx" ON "vantage_customer_people" USING btree ("customer_id");