# PM due — meter-driven preventive maintenance list

Status: design, 2026-11-17. Sub-project after toner yield. Read-only towards Vantage.

## Why

BGB has never been able to run reliable PM schedules in Vantage Online. Vantage's own PM scheduling
(`PMConfiguration` / `PMScheduleEntry`) is time-based only (an interval in weeks/months per contract
charge) and Vantage has no combined meter to drive it. Machines wear by pages, not by calendar, so
time-based PMs land too early on quiet machines and too late on busy ones.

The app now has a combined page history per machine: Vantage meter readings (12 months, nightly) merged
with DRMS counter snapshots (`packages/db/src/queries/toner-yield.ts`, `getFleetYields`), Black +
Colour per reading. With Vantage's past engineer visits added, the app can say which machines are due a
PM by pages printed since their last real service visit.

## Goals

- A **PM due** list: every serviced machine with pages since its last qualifying visit, its PM
  interval, % of interval used, an estimated due date, and a status (Overdue / Due soon / OK /
  Held off / Unknown).
- A per-machine PM section on the device page: interval, last qualifying visit, pages since, recent
  visits (with which ones counted and why), status.
- PM interval editable in settings: one global default (100,000 pages, user 2026-11-17) with an
  optional override per cartridge family.
- A "frequent calls" flag on machines with many visits in a short period (also useful later for the
  profitability tab).

## Non-goals

- **No writes to Vantage.** The app does not create PM schedule entries, work, or anything else in
  Vantage (user chose "option 1", 2026-11-17). Someone books the PM in Vantage as today. Pushing
  entries via `PMScheduleEntry/BulkImport` is a possible later step once the dates are trusted; it would
  need its own explicit user yes.
- No per-device interval override (family + global only, for now).
- No engineer scheduling, routing or capacity planning.
- Profitability tab: separate design, later (shares the visit data pulled here).

## Anti-goals

- Raising a PM for a machine an engineer spent real time on last week.
- Raising PMs on machines with frequent call-outs (they are getting attention; they need looking at,
  not a routine PM).
- Treating stale or missing meter history as "0 pages, not due". Unknown must look unknown.

## User rules (decided 2026-11-17)

1. Default PM interval **100,000 pages** (Black + Colour combined), editable globally and per cartridge
   family in settings.
2. A visit **45 minutes or longer** resets the PM clock. Shorter visits are ignored for PM purposes.
3. Many short calls in a short period **must not create a PM**. Proposed numbers (stated to user, not
   objected to; keep them as editable settings): **3 or more visits within 30 days** = frequent calls;
   PM is held off while that holds and for **30 days after the last visit**; the machine is flagged
   "Frequent calls".
4. Read-only: list only, booking stays manual in Vantage.
5. **Only machines on an active service contract** are in the list (user, 2026-11-17). Rule already
   proven in `F:\dev\API Docs Etc\aged_contract_machines\` (2026-11-16): linked to at least one
   contract via a meter charge or periodic charge whose Status is `Active`, not deleted, no
   `CancellationDate`; evergreen contracts past `ExpiryDate` still count. Pull contracts + charges
   nightly (GET only) into the app DB.
6. **Time cap: 12 months.** A machine is due a PM at least every 12 months even if it prints little or
   nothing (user, 2026-11-17). Due = whichever comes first: interval pages since last qualifying visit,
   or 12 months since it (setting, default 12). No qualifying visit in the 12-month history = due by time.
7. **A PM visit performed means don't flag** (user, 2026-11-17). Any field visit in a PM category resets
   the clock regardless of its length (in addition to the 45-minute rule). Which categories are "PM" is
   chosen in settings from the categories seen in the data (builder: preselect names containing "PM",
   "Service" or "Maintenance" and let the user confirm).
8. **PM already booked** (my reading of 7, stated to user): an open or future-dated job in a PM category
   for the machine shows **"PM booked <date>"** and drops out of the default view, so the list doesn't
   nag or invite double-booking.

## Data

### Visits (new pull from Vantage)

Vantage `Work` (a job) has `WorkUnit`s (each a visit/attendance). Relevant `WorkUnit` fields
(`$metadata`, api-version 1.22): `WorkId`, `CategoryId`, `LoggedDate`, `WorkStartDate`,
`WorkEndDate`, `WorkHours`, `TravelHours`, `MaintenanceWasPerformed`, `ActionDetails`,
`SymptomDetails`, `WorkUnitEngineerId`, `ScheduledStartDate`. `Work` gives `EquipmentId`,
`CustomerId`, `ContractId`, `LoggedDate`, `CompletedDate`, `DeletedDate`, `Reference`.
`WorkCategory` (`Name`, `TypeId` -> `WorkType`) separates Field visits from Booking/other
(see memory note: Analysis Centre "Field" visits = category type "Field").

New table (e.g. `vantage_work_visits`, one row per WorkUnit) with: work unit id (pk), work id, work
reference, vantage equipment id, customer id, category id + name + type, logged date, work start/end,
work hours, maintenance-was-performed, action details (text, for display), deleted flag, raw jsonb,
modified date, synced_at. Open and future-dated work is pulled too (for "PM booked"). New worker job `vantage-work` alongside
`vantage-meters`: first run backfills **12 months**, then incremental by `ModifiedDate`; prune older than 12 months (same pattern as
`apps/worker/src/jobs/vantage-meters.ts`). GET only. Filter deleted work (`deleteddate eq null` on
Work; check whether WorkUnit has its own deleted flag).

### Visit duration

Duration = `WorkHours` when > 0, else `WorkEndDate - WorkStartDate` when both set and the gap is
under 24h, else unknown. Travel time is not counted. Unknown duration does not reset the clock.
Evidence (STCA01 export, 2026-11-16): 112 of 117 WorkUnits had `WorkHours` > 0 with actual
start/end times (e.g. 10:56–11:52 = 0.93h), so duration is reliable. `MaintenanceWasPerformed` was
ticked on 0 of 117: confirms it can't be used.

### What one "visit" is (my call)

WorkUnits for the same equipment on the same calendar day (UK time, by `WorkStartDate`, else
`LoggedDate`) are **one visit**: durations summed (so two 30-minute units on one job the same day
qualify), counted once for frequent calls. The visit date for the meter lookup is that day's earliest
`WorkStartDate` (else `LoggedDate`). A return trip on another day is a separate visit.

### Field visits only (my call)

Only categories whose `WorkType` is Field count, for both the 45-minute rule and frequent calls (same
split Analysis Centre uses: Field vs Booking). Missing or other types are stored and shown on the device
page as "not a field visit" but never count. The settings page lists the categories seen, read-only, so
the user can spot a mis-typed category.

### Qualifying visit

A visit resets the PM clock when: it is a Field-type visit, on non-deleted work, for that equipment,
with duration >= 45 minutes (setting). `MaintenanceWasPerformed` is stored and shown but not used in the
rule (user's rule is duration-based; revisit if engineers tick it reliably).

### Pages since last qualifying visit

Combined meter = Black:Total + Full Color:Total (mono: Black only), from the merged Vantage + DRMS
series already used by toner yield. Reuse its merge (`mergeSnapshots`) and meter-at-time lookup
(`meterPointAt`); extract shared pieces into a small `meter-history` module if that keeps it clean.
Pages since = latest combined meter - combined meter at the qualifying visit date. Unknown when there is
no meter at/near the visit or no reading after it (same rule as toner yield's `pagesSinceLastOrder`).

If the combined meter goes down between the visit and now (board swap, reset, replaced unit), pages
since is **Unknown — meter reset** (my call); never a confident OK/Overdue.

No qualifying visit in the 12-month window: pages since = latest meter - earliest meter in the window,
shown as "at least N pages" (a lower bound), status computed from that.

### Estimated due date

Average pages/day over the last 90 days of the merged meter series (fewer days if that's all there is,
minimum 14 days of span); days to due = (interval - pages since) / pages per day. Unknown if no rate.

## Status

In priority order:
- **PM booked**: open/future PM-category job exists (shows its date).
- **Held off — frequent calls**: >= 3 Field visits (any duration) in any 30-day window ending within the
  last 30 days. Shows the visit count and when the hold lifts.
- **Unknown**: no usable meter history (no reading in 30 days, or pages since unknown). Says why.
- **Overdue**: pages since >= interval, or 12 months (time cap) since the last qualifying visit.
- **Due soon**: pages since >= 85% of interval, or estimated due date within 30 days, or time cap
  within 30 days (settings).
- Unknown meter history does not block the time cap: a machine with no usable meters but a known last
  visit date still goes Overdue at 12 months ("due by time").
- **OK**: otherwise.

## Settings

On the existing settings area (next to `/settings/replenishment` and `/settings/cartridge-families`):
- Global: PM interval (100,000), time cap months (12), PM categories (multi-select from categories
  seen), qualifying visit minutes (45), frequent-call count (3), frequent-call
  window days (30), hold days after last visit (30), due-soon % (85), due-soon days (30).
- Per family: optional PM interval on the cartridge family edit dialog (blank = global). Devices with no
  family use the global interval.

Stored in the app DB (new columns/table; builder's call on shape, following how replenishment settings
are stored).

## Screens

- **PM due list** (new page, own sidebar entry "PM due"): table of machines with customer, serial,
  model, family, interval, last qualifying visit (date, duration, reference), pages since, % used,
  estimated due date, status badge. Default view: Overdue + Due soon, plus Held-off machines that are
  past their interval (shown with a "Frequent calls" badge, visit count and hold-lift date, so a
  problem machine never vanishes; my call); filters for status, customer,
  family; search. Hidden devices excluded (`notHiddenDevice()`). Row click opens the device page.
  CSV export (same pattern as `/reconnect/export`).
- **Device page**: "Preventive maintenance" card: status, interval (and where it came from: family or
  global), last qualifying visit, pages since / % / due date, and the last ~10 visits with date,
  category, duration, engineer action text, and "counted" / "too short" / "not a field visit".

## Approaches considered

1. **App shows a PM due list; booking stays manual in Vantage.** Read-only, safe to trial, lets the user
   check predictions first. **Chosen** (user, 2026-11-17).
2. App writes PM schedule entries into Vantage via `PMScheduleEntry/BulkImport`
   (ContractReference, SerialNumber, ScheduledStartDateTime, ScheduledHours, Category,
   EngineerReference). Removes the manual step but writes to the live ERP. Deferred: needs trust in
   the dates and an explicit yes.
3. Configure Vantage's native time-based PM per contract from the app's average pages/day. Rejected:
   still calendar-driven, drifts as usage changes, and is also a write.

## Constraints

- Branch `feat/site-stock` worktree `C:\dev\mps-brain-replenishment` carries many uncommitted changes;
  this work must not disturb them.
- Migrations: add new tables and apply (worker restart via `scripts/mps.ps1`) **before** any web code
  queries them (web reads the same DB; see repo CLAUDE.md).
- Vantage: always `api-version` header; GET only; respect rate limits; use `ModifiedDate` for
  incremental sync; date parameters via OData aliases (see Vantage notes).
- Production run is via `scripts/mps.ps1` (web is a production build: `mps.ps1 build` after changes).

### Contracts (new pull)

Vantage Contract (Status, DeletedDate, CancellationDate, ExpiryDate) with its meter charges and
periodic charges (EquipmentId), GET only, nightly, into app tables. Reuse the query shape from
`F:\dev\API Docs Etc\aged_contract_machines\pull.mjs`. Also stored for the later profitability tab.

## Left to the builder

- Exact table/column names, job schedule time (after `vantage-meters` at 02:45 is fine).
- Whether to `$expand` WorkUnits from Work or page WorkUnit directly; how to resolve category type.
- Shape of settings storage.
- Shared meter-history refactor out of toner-yield, if it helps.
- Page layout details within existing UI conventions.
