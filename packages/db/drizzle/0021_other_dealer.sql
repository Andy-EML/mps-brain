ALTER TABLE "customer_flags" ADD COLUMN "other_dealer_override" text;--> statement-breakpoint
ALTER TABLE "customer_flags" ADD COLUMN "other_dealer_name" text;--> statement-breakpoint
ALTER TABLE "customer_flags" ADD CONSTRAINT "customer_flags_other_dealer" CHECK ((other_dealer_override is null and other_dealer_name is null)
       or (other_dealer_override = 'ours' and other_dealer_name is null)
       or (other_dealer_override = 'dealer' and other_dealer_name is not null));