ALTER TABLE "drms_equipment" ADD COLUMN "is_colour" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- One-time backfill so the rows already in the table are right before the next DRMS pull rewrites
-- them. This regex is not a second source of truth: `isColourModel` (@mps/core) owns the rule, and
-- every write after this migration comes from it. Mirrors that helper: a `+` (Develop's colour
-- marker), `MF`, or a capital C in front of the model number.
UPDATE "drms_equipment" SET "is_colour" = true
WHERE "model_name" ~ '(\+|MF|(^|[^A-Za-z])C[[:space:]]*[0-9])';