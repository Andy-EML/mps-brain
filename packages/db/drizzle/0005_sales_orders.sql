CREATE TABLE "vantage_sales_order_lines" (
	"vantage_id" integer PRIMARY KEY NOT NULL,
	"sales_order_id" integer NOT NULL,
	"vantage_equipment_id" integer,
	"item_id" integer,
	"item_part_number" text,
	"item_description" text,
	"quantity" numeric,
	"returned_date" timestamp with time zone,
	"details" text,
	"comment" text,
	"colour" text,
	"colour_source" text,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vantage_sales_orders" (
	"vantage_id" integer PRIMARY KEY NOT NULL,
	"reference" text,
	"order_date" timestamp with time zone,
	"completed_date" timestamp with time zone,
	"is_on_hold" boolean,
	"is_non_stock" boolean,
	"type_id" integer,
	"type_name" text,
	"created_by_mps" boolean DEFAULT false NOT NULL,
	"vantage_equipment_id" integer,
	"contract_id" integer,
	"customer_sell_to_id" integer,
	"customer_ship_to_id" integer,
	"raw" jsonb NOT NULL,
	"modified_date" timestamp with time zone,
	"deleted_date" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vantage_sales_order_lines_order_idx" ON "vantage_sales_order_lines" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "vantage_sales_order_lines_equipment_part_idx" ON "vantage_sales_order_lines" USING btree ("vantage_equipment_id","item_part_number");--> statement-breakpoint
CREATE INDEX "vantage_sales_orders_equipment_date_idx" ON "vantage_sales_orders" USING btree ("vantage_equipment_id","order_date" DESC NULLS LAST);