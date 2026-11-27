# Toner Delivery = cartridge fitted — plan

User (2026-11-27): a DRMS "Toner Delivery(X)" alarm means a new toner cartridge went in, so the level should
read 100%. Checked live: of 768 Delivery alarms with a DRMS reading either side, the level was ~11% before on
average and ~82% after, and 625 rose by 30 points or more. "Waste Toner Bottle Delivery" is the same event for
the waste bottle.

## Decisions (user)
1. **No order from a Delivery alarm**, except where the device's site-stock shelf *holds that colour* (a
   held spare: typically black or waste, but any colour the shelf holds). There Delivery counts as a spare
   used and the shelf's top-up orders it. If the shelf doesn't hold the colour, or the device isn't on a
   shelf, a Delivery never orders: that colour orders from the per-cartridge % threshold using the effective
   level (Delivery newer than the reading = 100%). Near Empty and Empty alarms are unchanged.
2. **Delivery = fit date** for toner yield and the "not fitted yet" hold. Fall back to the sales order date
   when there's no Delivery alarm.

## Rules
- A Delivery alarm is `Toner Delivery(BK|K|C|M|Y)` or `Waste Toner Bottle Delivery`, whatever its DRMS status.
- **Level shown:** when the latest Delivery alarm for a colour is newer than the latest DRMS toner reading,
  show that colour at 100% with a note "new cartridge <date>". Waste shows as emptied. Applies everywhere a
  level is shown or used: toner chips, device page toner bars, parts panel and replenishment thresholds.
- **Replenishment (worker replenish-evaluate):**
  - A Delivery alarm no longer triggers a proposal.
  - A Delivery does nothing else by itself: it never creates, cancels or supersedes a proposal or order.
    Approved and ordered orders are never touched. The only knock-on is the existing threshold-recovery
    rule: a pending *threshold* proposal is superseded ("level recovered") once the effective level is back
    at or above its threshold, and a Delivery makes the effective level 100%. No new superseding is added.
  - The threshold check uses the effective level from the rule above.
  - Near Empty and Empty alarms still trigger proposals as now.
- **Site stock (worker site-stock-evaluate):**
  - Delivery is a use for shelf members.
  - Dedupe so one cartridge change counts once: an Empty alarm, a Delivery alarm and a level rise for the same
    device and colour within a short window (match the existing dedupe window; otherwise 3 days) are one use.
  - Prefer the Delivery as the reason (new reason `delivery`, with a label in `apps/web/src/components/shelf.ts`).
- **Yield and hold** (`packages/db/src/queries/toner-yield.ts`, `not-fitted.ts`):
  - The fit for an order is the first Delivery alarm for that colour on or after the order's date, and before
    the next order of that colour.
  - No Delivery alarm means the current behaviour.
  - A Delivery alarm with no order still marks a fit (a cartridge from elsewhere) for the yield maths. Keep
    this conservative: if it's too invasive, record it as a follow-up instead.
- **Parts panel:** nothing changes, apart from using the effective toner level.
