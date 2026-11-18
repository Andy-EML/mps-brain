ALTER TABLE "replenishment_proposals" ADD COLUMN "vantage_sales_order_id" integer;--> statement-breakpoint
ALTER TABLE "replenishment_proposals" ADD COLUMN "vantage_sales_order_line_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_proposals_so_line_uq" ON "replenishment_proposals" USING btree ("vantage_sales_order_line_id") WHERE vantage_sales_order_line_id is not null;