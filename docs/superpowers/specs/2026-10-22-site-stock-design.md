# MPS Brain — Sub-project 4: Site stock

> Status: design drafted 2026-10-22 from a brainstorm with the user (mockup:
> `.superpowers/brainstorm/site-stock-mockup.html`, approved "looks fine"). Builds on sub-project 3
> (replenishment, `2026-09-21-replenishment-design.md`) — read that first; its tables, engine,
> review queue and conventions are reused here. Items marked **(builder's call)** or
> **(Claude's call)** were not decided by the user.

## Why

Some customers keep **spare toner on site**. When a machine runs out, the customer fits a spare and
Elmdale replaces what was used. Today this is manual: CSRC emails a "Device Report" with
`Toner Empty(BK)` etc., someone tallies it ("1st request", "2nd request") against what the site
holds, and when the **last spare** of a colour goes in, they send a parcel that tops the site back
up. Batching to the last spare saves postage.

The normal replenishment engine is wrong for these machines: it proposes on low level / Near Empty,
which for a site with spares on the shelf means sending toner nobody needs yet. The interim
workaround is Auto-replenish **Off** per device, which stops all proposals.

## Goal

The app keeps the tally automatically from DRMS Empty alarms and, when a colour's last spare is
used, puts **one top-up proposal for the whole shelf** in the existing Review queue for a person
to approve.

## Non-goals

- Sending orders to Vantage. Live ordering is still deferred (replenishment spec, kill switch
  `VANTAGE_ORDERS_ENABLED`). Approved top-ups follow the same path as other approved proposals.
- Reading CSRC emails. DRMS alarms carry the same Empty events.
- Tracking stock in a warehouse, deliveries, or proof of delivery.
- Staples, drums, imaging units.
- Notifications (sub-project 5).

## Anti-goals (would make this a failure even if it works)

- Counting one cartridge twice (DRMS repeats Empty alarms) — the shelf would be topped up early.
- Proposing anything for a site-stock machine on Near Empty or low level.
- Sending an order without a person approving it.

## Concepts (user's words in quotes)

- **Site** = a Vantage customer record. In Vantage each branch is its own customer under a head
  office (e.g. Howden UK Brokers head office 660 → "C&LC" branch records, each with its own
  Town/PostCode). A device's site is `device_links → vantage_equipment.vantage_customer_id`.
  Unlinked DRMS devices have no site and cannot be on a shelf.
- **Cartridge family** = a set of models that take the same cartridges. User: "same shelf if they
  take the same cartridge". Evidence from sales orders: C450i/C451i/C550i/C650i share one genuine
  part per colour (black ACV1150); C250i/C300i/C360i share another (black AAV8150). No such
  mapping exists in the app today, so it is a new, user-maintained table.
- **Shelf** = one site + one cartridge family. "Shared shelf per site, same model machines draw from
  it." Every device at that site whose model is in that family belongs to it — membership is
  **derived**, not assigned.
- **Holding** = how many spares of each consumable the shelf keeps: black, cyan, magenta, yellow,
  waste. Set per shelf; "spares vary by customer/site". Mono families only have black + waste.
- **Used** = Empties counted since the last top-up, per consumable.
- **Top-up trigger**: "always on last toner in" — a consumable's used count reaches its holding.
- **Top-up contents**: every consumable's used count, not only the one that triggered. User's
  example: holds 3 K and 2 each of C/M/Y; 1st requests already for C and Y; last K goes in →
  send **3 × K, 1 × C, 1 × Y**.

## Rules

1. **What counts as a use.** A DRMS alarm on a shelf device whose description is a toner
   **Empty** — `Toner Empty(BK|K|C|M|Y)` — or **Waste Toner Bottle Full** (waste). Near Empty,
   Delivery, Almost Full and every other alarm are ignored. Count it **regardless of DRMS
   `status`** — Empty alarms often arrive as `NoAlarmFilterHierarchyFound` etc., not
   `ReadyForErpDelivery` (seen on ADXG02A005378, 2 Oct). Confirm the exact waste wording against
   `device_alarms` (seen so far: "Waste Toner Bottle Almost Full", "Waste Toner Bottle Delivery";
   the CSRC email shows "Waste Toner Bottle Full").
2. **Count once (Claude's call, accepted in mockup).** DRMS repeats Empty alarms (e.g. A93E321001218
   Empty(BK) on 24 Sep and again 28 Sep). An Empty for device D + colour X counts only if the
   previous counted Empty for D + X is followed by evidence of a fresh cartridge — a later toner
   level reading for D + X of **≥ 80%** (counter snapshots). Waste has no level: count a waste Full
   only if the previous counted one for D is more than **14 days** older (builder may tune; named
   constants). Every alarm considered is logged with counted / not counted and why.
   **Fallback (Claude's call):** if there is no level reading at all between the two alarms
   (device not reporting counters, e.g. Discovered), count the new Empty when the previous counted
   one is more than **14 days** older — same rule as waste. A first Empty for D + X always counts.
   Accepted risk: a part-used cartridge fitted inside 14 days with no ≥ 80% reading is undercounted
   (the shelf page's manual correction covers it). Level history comes from
   `counter_snapshots`/`counter_values` (one snapshot per DRMS collection, history kept — see
   `getCounterHistory` in `packages/db/src/queries/device.ts`).
   **Counting start (Claude's call):** each shelf has `counting_from` (= creation time). Alarms
   received before it are never counted, so creating a shelf never fires a top-up from old alarms.
   A shelf that starts mid-cycle gets its starting used counts from the shelf page or from the CSV
   (see import).
3. **Top-up.** When any consumable's used ≥ holding (holding > 0), create one top-up: one
   `replenishment_proposals` row per consumable with used > 0, `quantity = used`, all tied to the
   shelf and to one device (the device whose Empty triggered — Vantage orders are per equipment).
   A consumable with holding 0 is not counted and never triggers.
4. **Reset (Claude's call).** On **approval**, each consumable's used count is reduced by the
   **approved quantity**, floored at 0 — not set to 0 — so uses counted while the top-up waited
   are kept, and an operator who sends fewer leaves the remainder on the tally. Rejecting leaves
   counts as they are; the next counted use re-evaluates the trigger. Quantities can be edited
   before approval, as today.
   **After approval** a top-up follows the normal path exactly: one `replenishment_orders` row on
   the triggering device with every line as a component, `queued` behind the kill switch (live
   Vantage ordering is still deferred). If that order later ends `failed` and an operator rejects
   it, the approved quantities are added back to the used counts (audited).
5. **Shelf devices leave normal replenishment, per consumable.** For a device on a shelf, every
   consumable with holding > 0 gets no threshold or alarm proposals from the normal engine (new
   suppress reason `site_stock`); a consumable with holding 0 (e.g. the site keeps no spare waste
   bottle) stays on normal replenishment (Claude's call). Pending normal proposals for covered
   consumables are superseded when the shelf covers them. This replaces the Auto-replenish Off
   workaround.
   **Auto-replenish Off vs shelves (Claude's call):** a shelf is explicit intent, so shelf counting
   and top-ups **ignore** `auto_replenish`. Creating a shelf (screen or import) lists any of its
   devices with auto-replenish off and offers to reset them to inherited, so consumables with
   holding 0 go back to normal replenishment. The triggering device must be linked to Vantage
   equipment (every shelf device is, by definition of site).
6. Rejection / duplicate suppression of the normal engine (open order, 14-day completed) does
   **not** block counting uses; a top-up is not created while the shelf already has a live
   (pending/approved) top-up — further uses keep counting and the next top-up picks them up.
7. **Triggering device (Claude's call):** the device of the alarm that made used reach holding;
   if several in one run, the most recent alarm. Top-up proposal rows carry `shelf_id` and are
   **excluded** from the existing live (device, colour) unique index; they get their own partial
   unique index on (shelf_id, colour) for live rows. Collisions with normal proposals cannot
   occur, because rule 5 supersedes those. Holdings are capped at **20** per consumable (matches
   the existing quantity check).

## Data (new tables, Claude's call — builder may reshape)

- `cartridge_families` — id, name (e.g. "C450i / C550i / C650i"), is_colour, notes.
- `cartridge_family_models` — family_id, model (normalised as DRMS reports it, e.g.
  "bizhub C450i", "ineo+ 450i"). Unique on model. Seeded from sales-order evidence; editable.
  Whether Develop ineo+ models share a family with the bizhub equivalent is **the user's to
  confirm** (seed them as separate families until told).
  **Building the seed list (a plan task):** derive candidate families from
  `vantage_sales_order_lines` — group the models named in line text by genuine part number (e.g.
  ACV1150 → 450i/451i/550i/650i; AAV8150 → C250i/C300i/C360i) — cover every model string present
  in `drms_equipment` for linked devices, and **show the list to the user to confirm before
  seeding**. Models with no evidence stay unmapped and appear as the "no family" warning.
  Christ the King's C551i: family decided by this step. Families also get optional
  **rated yield per consumable** columns (user, 2026-10-22: yields per machine range — the yield
  report itself is a later piece; storing the figures now costs nothing).
- `site_stock_shelves` — id, vantage_customer_id, family_id, holding_black/cyan/magenta/yellow/waste
  (int 0–20), used_* (int ≥ 0), counting_from, updated_by/at. Unique (vantage_customer_id, family_id).
- `site_stock_events` — one row per alarm considered for a shelf: shelf_id, alarm_id, device,
  consumable, counted bool, reason, at. The shelf page's "Empties counted" list and the audit trail.
- `replenishment_proposals` gains `shelf_id` (nullable) and `trigger` gains `site_stock`.
- Holdings edits, manual used corrections and imports write `audit_log` rows.

## Engine

Pure functions in `@mps/core` (like `replenishment.ts`): classify an alarm as a use (rule 1), decide
counted / not counted (rule 2), and given a shelf's holdings + used, return the top-up lines
(rule 3). Run inside `replenish-evaluate` (already queued after `drms-alarms`, `drms-snapshot`,
`vantage-orders`), before the normal per-device evaluation so rule 5 applies.

## UI (mockup approved)

- **Site stock** — new sidebar item. Table of shelves: site name, customer + postcode, family,
  machine count, per-consumable **used / held** pills (red ring when used = held), status
  (Holding / Top-up proposed). Search. **+ New shelf** (pick site, pick family). Shows machines on
  a site whose model has **no family** as a warning so the family list gets maintained.
- **Shelf page** — editable holdings per consumable, used counts with a manual correction (audited),
  machines on the shelf (derived), log of Empties counted / not counted.
- **Review queue** (`/orders`) — a top-up shows as **one site row** with a "Site stock" badge,
  the lines (e.g. K × 3, C × 1, Y × 1) and why ("Last black spare went in 19 Oct (C450i)").
  Approve / edit quantity / reject like other rows.
- **Device page** — badge "Site stock: <shelf>" with a link; the Replenishment card says normal
  proposals are off because of the shelf.
- **Cartridge families** — settings page to add/edit families and their models.

## CSV import / export (user request, 2026-10-22)

"Import/export csv file so we can do it in bulk."

- **Export** (Site stock page): one row per **site + family that exists in the fleet** (DRMS devices
  linked to Vantage, model in a family), including ones with no shelf yet, so it doubles as a
  fill-in template. Columns (Claude's call): `vantage_customer_id, site_name, customer_reference,
  postcode, family, machines, hold_black, hold_cyan, hold_magenta, hold_yellow, hold_waste,
  used_black, used_cyan, used_magenta, used_yellow, used_waste`.
- **Import**: same columns, keyed on `vantage_customer_id + family`. Updates **holdings only**
  (Claude's call; counts come from alarms) — **except** when the row creates a new shelf, where
  `used_*` is taken as the starting count (a site set up mid-cycle, "1st request" already noted on
  paper). Creates the shelf when a row has any holding > 0 and none exists. Shows a **preview** (new / changed / unchanged / errors per
  row) and applies only on confirm, in one transaction, one audit row. Blank holding = 0. Rows for
  unknown sites/families are errors, not silently skipped.

## Seed data

From `F:\dev\API Docs Etc\Stock - Customer toner stock  June 2012.xls` (2012; most of it is
obsolete). Matched against current data 2026-10-21; row-by-row result at
`F:\dev\API Docs Etc\site-stock-2012-sheet-match.csv` (kept **out of git** — it lists customers).
Only these shelves have current DRMS-monitored machines:

- **Christ the King Primary** — bizhub C551i: 1 each K, C, M, Y + 1 waste.
- **Priorsfield School** — ineo+ 360i: 2 each K, C, M, Y. ineo+ 450i: 2 each K, C, M, Y.

Howden / A-Plan / Hewetts are not in the sheet; the user will enter them (via the screen or CSV)
once built. Seed via the CSV import or a migration — builder's call.

## Verification

Unit tests for the pure rules (use, count-once, top-up lines incl. the user's 3K/1C/1Y example,
mono shelves, holding 0). PGlite tests for the job, queries, import (preview + apply + errors) and
export. A full test pass written up as `docs/TEST-REPORT-*.md`, then a user UI pass.

## Left to the builder

Table/column names, page routes, how the device for a top-up is chosen when several Empties
coincide, migration vs import for seeding, exact UI layout within the approved mockup.
