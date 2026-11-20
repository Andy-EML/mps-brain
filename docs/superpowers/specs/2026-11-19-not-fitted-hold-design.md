# Hold toner orders while the last cartridge is still on site

Status: design, 2026-11-19. Read-only towards Vantage: the app only proposes.

## Why (user, 2026-11-19)

- Northwood C450i (AA7R027020591): magenta proposed at 0%, but magenta was sent on 2 Apr 2026 and the machine
  does little colour. That cartridge was never fitted (magenta 1% → 0% since 20 Sep, no rise; black went
  1% → 100% on 6 Oct, so the customer does fit cartridges). It is not a real order.
- "This logic needs to apply to all the orders, because there are probably loads that aren't actual orders as
  they haven't replaced the toner yet. This needs to be a global thing."
- Vantage has monthly billing meter readings either side of an order: use them to estimate the meter on the
  order date and so the pages a cartridge has done.

Live check, 293 pending device proposals (2026-11-19): 59 have no level change since their colour's last
order (spare probably on site); 114 have a last order older than the DRMS level history with a low first
reading (Northwood is one); 40 show a change since the order (genuine); 32 older order, first reading fine;
48 no earlier order.

## Decisions (user)

- Applies to every toner proposal from the device evaluator (threshold, alarm) for every colour.
- A held proposal goes to its own **"Probably on site"** tab in the Review queue (option a), with the reason,
  still approvable; it leaves the tab by itself when the cartridge is seen fitted.
- Yield hold point: **under 50% of the rated yield** since the last order. Rated yields are per 5% coverage.
- Rated yields entered 2026-11-19 (families 1–9, via `saveFamily`, audited).
- Vantage meter readings kept for **24 months** (was 12).

## The rule

For a device + colour with a proposal, find the **last toner order** for that colour: newest Vantage sales
order line for that equipment and colour (not deleted, not returned), by order date. Open (undelivered) orders
are already suppressed by `open_order` and are not touched.

1. **No last order** → propose as today.
2. **Fitted since the order** → propose as today. Fitted = either, after the anchor date (see resolutions): a
   level rise per the spare-black rule (<= `LOW_LEVEL` then >= `RISE_LEVEL`), or (my call) any jump of >= 30 points between consecutive readings — toner never rises
   except by a new cartridge, and a cartridge fitted early (say at 25%) never satisfies the <= 15 rule.
3. **Level history spans the order** (a level reading for that colour at or before the order date) and nothing
   fitted since → **hold**, reason `not_fitted`: "Magenta sent 22 Sep 2026, no new cartridge seen since — spare
   should be on site".
4. **Level history starts after the order** → **yield check**: pages since the order (below) vs the family's
   rated yield for that colour. Under 50% → **hold**, reason `low_yield`: "~8,220 pages since magenta sent
   2 Apr 2026 (29% of 28,000) — April cartridge probably not fitted". 50% or more → propose. No rated yield
   (model without a family) or pages not measurable → propose, as today.

Waste is out (no level series). Shelf top-ups (`site_stock`) and `spare_used` proposals are out: both are
already replacements for a counted use.

Spare black fits without special cases: a threshold black proposal on a machine whose spare_used replacement
was delivered and not yet fitted is held (the spare covers it); when the spare is fitted the change raises
spare_used as today.

### Builder-check resolutions (my calls, 2026-11-19)

- **Anchor date** = the last order's `order_date` (not `completed_date`). Live check 2026-11-20: Vantage completes
  toner orders a median of 9 days after ordering (p90 19), and completion is not delivery, so a cartridge fitted on
  delivery would look as if it was fitted before a completion anchor. Cost: a customer fitting their old spare
  between ordering and delivery counts as this order's fit, so the order is proposed, as it is today.
- **Quantity**: the last order = all lines for that colour on the same order day (London), quantities summed (N).
  Released only when N fits are seen since the anchor; the yield check compares against 50% of rated × N.
- **Toner Empty alarms do not count as fitted** (an Empty means the machine ran dry, not that a cartridge went
  in). Fitted is level evidence only: the <= 15 → >= 50 rise or a >= 30-point jump. An Empty-alarm proposal on
  a machine whose last order is unfitted is held: the spare should be fitted.
- **Both directions every run**: hold is recomputed from the data each run (a released proposal can be re-held,
  e.g. after the meter backfill). Proposals a `cartridge_changes` row relies on as cover are never held.
- **Rule 3 safety net**: even with level history spanning the anchor, pages since >= 100% of rated × N → not
  held (a change must have been missed in a gap).
- **Panel series** keeps the alarm page-count points on top of DRMS + Vantage snapshots.
- **Stale meters** (newest reading > 14 days old) → no `low_yield` hold (pages since can only be undercounted).

## Meter on a date (shared by the hold rule, the yield line and the panel)

- Series: DRMS counter snapshots merged with Vantage meter readings (existing `mergeSnapshots`).
- Meter at date t: a reading exactly at t, else **linear interpolation** between the newest reading before t
  and the oldest after t when they are <= 45 days apart, else the existing fallback (newest before, or oldest
  after within 14 days), else unknown. Pages since = latest reading − meter at the order date; negative =
  meter reset = unknown.
- Text says "~" when interpolated ("~8,220 pages since 2 Apr 2026").
- The Review detail panel's "Pages since last order" switches to this series and function, so it always
  agrees with the yield line (today the panel uses DRMS only and says "no reading at order time").
- Cartridge history (achieved yield, under-yielding) uses the same function at both ends.

## Holding

- Re-decided on every replenish-evaluate run for every live pending device proposal, so existing pending
  proposals are sorted on the first run after ship. Held = pending proposal with `hold_reason`
  (`not_fitted` | `low_yield`) and `hold_detail` (the text facts: order date, reference, pages, %).
- A held proposal that later qualifies (change seen) has its hold cleared and appears in Review; usually the
  level has recovered and the existing "level recovered" supersede clears it instead.
- Approving from "Probably on site" works exactly like Review (audit as today) — for when the customer says
  the spare is not there.
- Review tab and its count exclude held proposals; "Probably on site" tab lists them with the reason.

## Vantage meters 24 months

- `METER_WINDOW_MONTHS` 12 → 24 (prune keeps 24). A one-off backfill pulls months 13–24 for linked
  equipment (the job is incremental after its first success).

## Not changing

No Vantage writes. Thresholds, alarm triggers, other suppressions, shelves, spare-black, Review approve flow.

## Approaches considered

- **Hold in a separate tab (chosen)**: nothing lost, queue clean, overridable.
- Keep in Review unticked with a warning: visible but leaves the queue cluttered. Rejected by user.
- Drop with no proposal: cleanest, but a missed change would let a machine run dry unseen. Rejected.

## Left to the builder

Column names/migration (0019); how the tab is wired into `listReplenishmentQueue`; wording within the
examples; reading level history efficiently; backfill mechanics.
