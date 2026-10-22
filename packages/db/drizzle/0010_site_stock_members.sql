CREATE TABLE "site_stock_members" (
	"shelf_id" integer NOT NULL,
	"drms_equipment_id" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	CONSTRAINT "site_stock_members_shelf_id_drms_equipment_id_pk" PRIMARY KEY("shelf_id","drms_equipment_id")
);
--> statement-breakpoint
ALTER TABLE "site_stock_members" ADD CONSTRAINT "site_stock_members_shelf_id_site_stock_shelves_id_fk" FOREIGN KEY ("shelf_id") REFERENCES "public"."site_stock_shelves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_stock_members" ADD CONSTRAINT "site_stock_members_drms_equipment_id_drms_equipment_drms_id_fk" FOREIGN KEY ("drms_equipment_id") REFERENCES "public"."drms_equipment"("drms_id") ON DELETE no action ON UPDATE no action;