CREATE TABLE "customer_flags" (
	"vantage_customer_id" integer PRIMARY KEY NOT NULL,
	"self_managed" boolean DEFAULT false NOT NULL,
	"self_managed_note" text,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_flags" ADD CONSTRAINT "customer_flags_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
