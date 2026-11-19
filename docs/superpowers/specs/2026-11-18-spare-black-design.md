# Spare black on site + cartridge-change detection

Status: design, 2026-11-18. Read-only towards Vantage: the app only proposes; orders still go through the Review
queue as today.

## Why (user, 2026-11-18)

- "99% of machines will have K as site stock": almost every customer keeps one spare black cartridge. When they
  fit it, we must send a replacement spare. A few customers (usually schools) hold full site stock on shelves.
- "Sometimes the empty alarms don't happen": confirmed. Of 22 cartridge changes seen in DRMS toner levels since
  2026-09-17 (level <= 15% then >= 80%), only 7 had a Toner Empty alarm before them; 9 had Near Empty only, 6 had
  no alarm. Shelves today count a use only from an Empty alarm, so they miss most changes.
- Order/alert on the change "when they go from 0-15% back to 90+%".

## Decisions (user)

- **A**: a "spare black on site" setting, on for every machine by default. A detected black change proposes
  "spare used: send 1 black" in the Review queue.
- **C**: shelves also count a use from a level change, not only from an Empty alarm.
- **Both triggers**: Near Empty / Empty alarms and the threshold still propose as today; the change trigger is
  added. Guard against ordering twice for the same cartridge.
- Machines on a shelf that covers black: the shelf owns black (as today); spare-black does nothing for them.

## Change detection (one pure rule, shared by A and C)

Per device + toner colour, from the DRMS level series (`BlackTonerLevel` etc., one reading every 1-10 days) and
toner alarms (any DRMS status: the change rule never uses the Ready filter):

- The **current cartridge** starts at the last counted change for that device + colour, or at the device's
  counting start when there is none (see Roll-out). No ">= 80 reading" is needed to start one, so a short
  history or a first reading below 80 still works.
- A **change** is counted at most once per cartridge, at the first of:
  1. a Toner Empty alarm for that colour (same `siteStockUse` description match as shelves), or
  2. a **rise**: a reading >= `RISE_LEVEL` (50, new constant) after a reading <= `LOW_LEVEL` (15, new constant),
     both inside the current cartridge. Dated at the high reading. Toner never goes up except by a new
     cartridge, so a jump from 15% or less to 50%+ is a swap even when the fresh cartridge is first read late
     (e.g. at 70%).
- An Empty alarm followed by the rise for the same cartridge is one change: the Empty is counted, and the next
  rise (low reading at or before the Empty, high reading after it) is absorbed into that same change, not
  counted again. The cartridge after it starts at the rise's high reading.
- My call on numbers: the user said "0-15% back to 90+%". 15 is kept. 90 is not required as the high: readings
  arrive days after the swap so a new cartridge is often already below 90 when first read; any jump from <= 15
  to >= 50 can only be a swap. Both are constants.
- Changes are recorded (device, colour, at, source `empty_alarm` | `level`, alarm id or snapshot ids,
  outcome, reason, proposal id) so a change is decided once and never counted twice. Builder decides the table
  shape (or extends `site_stock_events`, whose `alarm_id` is not null today).

### Outcome of a change (decided once, never retried) — my call

- `proposed` (with proposal id), `covered` (the guard found an order/proposal for this cartridge),
  `ineligible` (spare_black off, auto off, unlinked, hidden, shelf-covered — reason recorded), or for shelves
  `counted` / `repeat` as today.
- A rejected spare_used proposal is final for that change; it is not re-proposed. A change seen while the
  machine was ineligible does not propose later when it becomes eligible.

### Roll-out — my call

- Counting start per device = the later of the ship time (one global timestamp stored at migration) and the
  device's first link to Vantage. Nothing before it is looked at, so history and newly linked machines never
  flood the queue.

## A. Spare black on site

- New setting `spare_black` on `replenishment_settings`, inherited default → customer → device like
  `auto_replenish`. Default row: on. Edited where auto-replenish is edited (device + customer settings).
- Applies when: spare_black on, auto-replenish on, linked to Vantage, not hidden, and no shelf covers black for
  the device. Black only (mono and colour machines).
- On a counted black change: proposal `trigger = 'spare_used'`, colour black, quantity 1, with the change date and
  the low/high levels or the alarm description, in the same Review queue. Text e.g. "Spare used: black changed
  ~12 Nov (3% → 92%)" / "Spare used: Toner Empty(K) 12 Nov".
- **Double-order guard** (the only suppression for spare_used — my call): outcome `covered` when, for the
  cartridge being replaced (start → change date), there is any black proposal of ours (pending, approved or
  ordered; any trigger) created on/after its start, or any Vantage sales-order line for black on that
  equipment (`vantage_sales_order_lines.colour = 'black'`, not deleted, not returned) with `order_date` on/after
  its start. That order or proposal is the replacement spare. The time-based suppressions (completed < 14 days,
  rejected < 7 days) are not used here: an order completed 10 days ago for the previous cartridge must not hide
  this change. The existing alarm/threshold path is unchanged.
- Runs in the existing replenish-evaluate job (after each counter pull).

## C. Shelves count level changes

- In the site-stock evaluator, a member device's level rise is a shelf use for that colour, alongside Empty
  alarms. Waste stays alarm-only (no level).
- Precedence (my call): Empty alarms keep going through `countUse` exactly as today. A rise counts as a use
  unless an Empty for that device + colour was counted at or after the rise's low reading (Empty + rise = one
  use). A counted rise becomes `previous` for the next Empty, and the readings after it satisfy `countUse`'s
  fresh-cartridge check, so the next real Empty still counts.

## Not changing

No Vantage writes. Threshold and alarm triggers, shelf top-up rule, Review queue flow, thresholds. Colour spares
outside shelves are not covered (user: 99% is black).

## Approaches considered

- **A: per-machine spare-black setting, default on (chosen)**: no setup for ~900 machines; one change → one
  proposal.
- B: black-only shelves for every site: hundreds of shelves to create, and shelves top up only when all spares are
  used, wrong for "replace on each change". Rejected.
- **C: level detection on shelves (chosen, with A)**: needed anyway for schools; alone it misses the 99%.

## Left to the builder

Table shape for change events; migration (0017) for `spare_black` + trigger value; where the toggle sits in the
settings UI; Review-queue wording within the examples above; reading the level series efficiently (only devices
with a new reading since the last run).
