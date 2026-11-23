# PM planner — design

Date: 2026-11-23. Status: draft, awaiting user approval.

## Why

PM due (`/pm`) says *which* machines need a preventive visit. Scheduling them is still done by hand: the office (the user) works out which due machines sit near each other, and rings engineers to add a PM while they are already in an area. Two things get in the way today:

- The list is full of machines we never service: sites looked after by other dealers (all of Ireland by MJ Flood, Scotland by CMYK).
- Nothing groups due machines by area or ties them to where engineers are going. Engineers often log a job start only after finishing (from the car), so a "job started" trigger arrives too late. Planning must happen **before** the engineer sets off, from the engineers' booked diary.

Success: the office opens one page, sees due PMs grouped by area with priorities on top, sees each engineer's booked calls for today/tomorrow with the PMs near each call, and moves machines through a small board as it arranges them.

## Goals

1. **Other dealer** — whole-site flag; those sites' machines leave PM due (and the planner). Auto rule by region: Republic of Ireland + Northern Ireland → MJ Flood; Scotland → CMYK. Per-site override both ways.
2. **When in area** — per-machine status: not worth a dedicated trip, do it if someone is nearby. Own tab on PM due; shown as add-ons in its area on the planner.
3. **Priority** — per-machine flag; sorts first in its area and everywhere it's listed.
4. **PM planner page** (new, `/pm/planner`):
   - **Board**: columns *To plan → Asked engineer → Booked → Done*, cards grouped by **county → postcode district**.
   - **Upcoming jobs**: each engineer's booked field calls for today and tomorrow, each with the PMs near that call.
5. Read-only toward Vantage. The user still books PM jobs in Vantage.

## Non-goals

- No writes to Vantage (no PMScheduleEntry import, no work creation).
- No engineer-facing notifications or messages; the office rings the engineer.
- Map view: next project (it will be a second view of this page).
- Customers accordion: separate, small project, built before this one.

## Anti-goals

- Other-dealer must **not** affect toner replenishment, alerts, reconnect, Devices or Fleet overview — PM only (user, 2026-11-23).
- The board must not silently lose a card: anything removed automatically says why.

## Decided with the user

- Other dealer is set per **whole site** (Vantage customer record), with the dealer's name. Regions: all of Ireland incl. Belfast → MJ Flood; Scotland → CMYK.
- Areas = **county, then postcode district** (outward code, e.g. GU14). Optional user-named **patches** grouping several districts (e.g. "Farnborough patch" = GU14 + GU11 + GU51).
- Board columns: To plan → Asked engineer → Booked → Done. **Booked** is set manually *and* automatically when a PM-category job for that machine appears in Vantage.
- Trigger for suggestions = engineers' **booked diary** (scheduled field calls), not job start.
- Separate planner page (approach 2 below).

## Approaches considered

1. **Everything on PM due** — new tabs, priority, area grouping and a Board tab all on `/pm`. One place, but `/pm` already has Due/Booked/Dismissed/All + accordion; adding the board, upcoming jobs and later the map overloads it.
2. **PM due stays the triage list + new PM planner page** — *picked by the user.* Statuses (other dealer, when in area, priority) live on PM due; planning (board, areas, upcoming jobs, later map) on `/pm/planner`.
3. **Push plans into Vantage's PM schedule** (`PMScheduleEntry/BulkImport`) — ruled out: the app is read-only toward Vantage by standing decision.

## Design

### Other dealer

- Store on `customer_flags` (extend; same place as `self_managed`): `other_dealer` text (dealer name, null = ours) + `other_dealer_source` (`manual` | `region`) + an explicit override "ours" (so a region rule can be undone per site).
- Region rule, computed (not stored per site) from the Vantage customer address:
  - **Republic of Ireland**: postcode looks like an Eircode (routing key letter + 2 digits / `D6W`, then a **4-char** unique id — UK inward codes are 3 chars), or no postcode and county starts `Co.`/`Co `/`County <Irish county>` or contains Dublin.
  - **Northern Ireland**: postcode area `BT`.
  - **Scotland**: postcode area in AB, DD, DG, EH, FK, G, HS, IV, KA, KW, KY, ML, PA, PH, TD, ZE (G = `G` followed by a digit).
  - Region → dealer mapping editable in `/settings/pm` (two rows today).
- Recon 2026-11-23: ~40 Republic of Ireland sites, 23 Scotland, 1 NI out of 898 customers. `Country` is always empty in Vantage.
- Effect: machines at an other-dealer site are excluded from PM due's Due/Booked/Dismissed/All and from the planner. New **Other dealer** tab on PM due lists them with the dealer name and an undo ("ours") per site.
- Customers page: badge "Other dealer: MJ Flood" on the site row/page; set/clear on the customer page beside Self-managed.

### When in area / Priority (per machine)

- New per-machine PM plan state (new table, e.g. `pm_plan`, one row per equipment): `when_in_area` bool, `priority` bool, `board_column` (null | `to_plan` | `asked` | `booked` | `done`), `board_note`, timestamps, `updated_by`.
- Relationship with existing `pm_actions` (booked / dismissed): Board **Booked** = an open `pm_actions` row of kind `booked` (manual) **or** an open/future PM-category Vantage job for the machine (auto, already detected by PM due as "PM booked"). Don't duplicate booking state.
- **When in area** machines: own tab on PM due; not in the Due tab; still due-tracked. They **stay** When in area until the user clears the flag — never auto-return to Due (user, 2026-11-23) — but carry an overdue warning ("overdue 18m", red when overdue) wherever shown. On the planner they appear in their area group as add-ons (muted style) and in Upcoming jobs suggestions.
- **Priority**: star toggle on PM due rows and planner cards; sorts first.

### Board

- **Board = working set the user picks** (user, 2026-11-23). Machines get on the board via "Add to plan" on PM due rows (Due and When-in-area tabs) and on Upcoming-jobs suggestions; Priority machines are added automatically. Machines never added are not on the board (PM due remains the full list; Upcoming-jobs suggestions still search the whole due list, not just the board).
- Columns: **To plan** (added machines), **Asked engineer** (manual), **Booked** (manual or auto), **Done** (auto when a qualifying PM visit lands per existing PM-reset rule; manual allowed; clears after 14 days — builder's call on exact retention).
- Cards grouped by county → district (→ patch if defined). Group header: count due, overdue, priority.
- Moving a card = button/menu (Move to…) is enough; drag-and-drop is nice-to-have.
- Auto moves are shown with a small reason ("Booked: Vantage job W12345").

### Upcoming jobs

- Source: Vantage work units with `ScheduledStartDate` today or tomorrow (London), field category type, not completed, with engineer (`EngineerId` → Engineer name). Already pulled by `vantage-work` (full 36-month refresh nightly) — needs an **intraday refresh** of upcoming scheduled units (e.g. every 30 min during working hours, scheduled window only) so same-day bookings show.
- Location of a call = its customer's Latitude/Longitude (836/897 have it) else postcode → postcodes.io lookup cached.
- For each call: PMs "near" = same postcode district **or** within N miles (default 10, setting). Order: priority, overdue, due soon, when-in-area. Excludes machines already Booked/other dealer/dismissed.
- Per engineer, per day, calls in scheduled order. Button on a suggestion: "Asked engineer" (moves card).

### Data refresh

- Areas need customer postcode/county/lat-long: in `vantage_customers.raw` already.
- Engineers: pull Vantage `Engineer` (id, name, active) nightly; small table.
- `EngineerHeartbeat` (GPS) exists in Vantage but is **out of scope**; untested access.

## Calls made after builder check (mine, user to check)

- **Booked is derived, not stored**: Booked column = open `pm_actions` kind `booked` OR PM-category Vantage job (existing "PM booked" detection). "Move to Booked" on the planner opens the existing Mark-booked form (date + optional reference) and writes `pm_actions`. `pm_plan.board_column` stores only `to_plan` / `asked` / `done`. When `pm_actions` booked goes stale ("no visit seen" after 14 days) the card returns to To plan with that reason badge.
- **Done** is persisted (`done_at`, reason `visit` | `manual`); Done cards show 14 days then drop off; when the machine becomes due again it starts fresh (plan row reset).
- **Asked engineer** has no expiry; cards there > 7 days get an "asked 9 days ago" badge.
- **Card leaves the due set** (dismissed, contract ended, other dealer, snoozed): card stays in its column with a reason badge and a "Remove" button; never vanishes silently.
- **Other dealer hierarchy** mirrors `self_managed`: a head-office flag covers its sites. Region rule uses the **site's own** address (equipment's customer). Precedence: site manual ("ours" or dealer) > head-office manual > region rule.
- **Upcoming jobs include calls with no machine** (site visits, installs): a separate small table of scheduled field units (work unit id, engineer id, customer id, scheduled start, category, equipment id nullable, work start, completed) fed by an intraday job; `vantage_work_visits` stays as is. All Field category types count (incl. installs). A unit with `WorkStartDate` already set still shows (engineer is there), marked "started". Engineer field: builder verifies against live API (`WorkUnit.EngineerId`).
- **County** for grouping comes from postcodes.io (admin county / region for the district, cached per postcode district), falling back to Vantage `County`; Vantage `County` is free text and often blank.

## Left to the builder

- Table/column names, migration split, whether region rule lives in SQL or TS (must be one function used everywhere).
- Planner page layout details (board left, upcoming jobs right is the intent), mobile layout.
- Done retention period, refresh cron times, postcodes.io caching approach.
- Exact Eircode regex, provided it is tested against the recon examples (`D04 EK2K`, `Y35 HYE0`, `A92 X7FA`, `E91 HX70` = Ireland; `B46 1DA`, `W14 9EQ`, `B16 8TP` (UK, 3-char inward) = not).
