CREATE TABLE "hidden_devices" (
	"drms_equipment_id" text PRIMARY KEY NOT NULL,
	"hidden_by" integer,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "hidden_devices" ADD CONSTRAINT "hidden_devices_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hidden_devices" ADD CONSTRAINT "hidden_devices_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;