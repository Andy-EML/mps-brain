# MPS Brain — Sub-project 3: Replenishment

> Status: drafted 2026-09-21 from decisions already agreed with the user (spec
> `2026-09-17-mps-foundation-design.md` → "Replenishment settings", "Bulk settings", "Needs toner
> tile destination"; `docs/HANDOFF.md` → "Next: sub-project 3"). Choices marked **(default)** were
> not discussed and were picked to keep the build moving; each is a named constant, easy to change.

## Goal

Turn low toner and DRMS consumable alarms into **real Vantage consumable orders**, with an operator
approving every one. Nothing is ordered without a person pressing Approve.

## Decisions carried over (do not re-ask)

- Thresholds cascade **default → customer → device**. Defaults **black 15%, cyan/magenta/yellow
  10%**. Each effective value shows where it came from, and who set it and when.
- Triggers: **our thresholds** (from the snapshot) **and DRMS alarms**.
- `auto_replenish` flag, default **on**, same cascade. Off = still monitored, but excluded from
  "Needs toner" and from proposals; listed under a "Manual replenishment" filter and badged on the
  device page.
- `alerts_enabled` flag (no-meter-reading alerts on/off), same cascade, default on.
- Bulk settings on the devices list: per-row checkbox, select page, **select all N matching**,
  per-colour thresholds / auto-replenish / alerts / reset to inherited. Confirmation step (with a
  warning when the selection spans more than one customer), **one transaction, audited**.
- Customer-level editing, so a whole site changes without touching each machine.
- Any signed-in user may change settings; only admins manage users.
- Proposals go to an **operator review queue**: approve / edit quantity / reject. Approved ones
  become real Vantage orders via `POST /Equipment({id})/CreateConsumableOrder`, and appear with the
  existing `created_by_mps` badge, open until Vantage completes them.
- **Quantity 1** of each low colour by default; the operator can raise it.
- **Duplicate suppression**: no proposal for a colour while an open Vantage order exists for that
  device and colour, nor for **14 days** after one completed.
- **Waste toner boxes raise proposals; drum / imaging unit / parts alarms do not.**
- Mono devices never get cyan/magenta/yellow thresholds or proposals (`drms_equipment.is_colour`).
- The Fleet overview **"Needs toner" tile opens the queue**.

## Data model (new tables)

`replenishment_settings` — one row per scope. `scope` is `default` (exactly one row, seeded by the
migration), `customer` (keyed by `vantage_customer_id`) or `device` (keyed by `drms_equipment_id`).
Columns `threshold_black/cyan/magenta/yellow` (int %, null = inherit), `auto_replenish` and
`alerts_enabled` (bool, null = inherit), `updated_by`, `updated_at`. The default row has no nulls.
A device's customer is the **Vantage** customer of its linked equipment
(`device_links → vantage_equipment.vantage_customer_id`); an unlinked device skips the customer
level.

`audit_log` — `at`, `user_id`, `action`, `entity`, `entity_ids jsonb`, `details jsonb`. Every
settings write and every proposal decision writes one row. A bulk write is one row listing all ids.

`replenishment_proposals` — one row per **device + colour** per episode. `colour` is
`black|cyan|magenta|yellow|waste`; `trigger` `threshold|alarm`; `level` and `threshold` at
detection (null for waste — DRMS has no waste counter); `alarm_id`/`alarm_description` for alarm
triggers; `quantity` (default 1); `status`:

| status | meaning |
|---|---|
| `pending` | waiting for an operator |
| `approved` | approved, attached to an order row, not yet sent |
| `ordered` | its order reached Vantage |
| `failed` | its order was refused by Vantage (operator can retry or reject) |
| `rejected` | an operator said no |
| `superseded` | the reason went away before anyone acted (level back above threshold) |

A partial unique index allows only one **live** (`pending|approved`) proposal per device + colour.

`replenishment_orders` — one row per Vantage order we send: one device, one or more proposals
(components). `status` `queued|submitting|submitted|failed|uncertain`; `request jsonb`,
`response jsonb`, `vantage_sales_order_id`, `vantage_reference`, `error`, `created_by`,
`created_at`, `submitted_at`.

## Engine (`@mps/core`, pure)

`evaluateDevice(input) → ProposalCandidate[]` for one device. Input: `isColour`, levels, the
**already-resolved** settings (the cascade is resolved once, in SQL — see below), recent consumable
alarms, the per-colour order state and the live/recent proposals.

1. `auto_replenish` false, or no linked Vantage equipment → nothing.
2. Channels: black always; cyan/magenta/yellow only when `isColour`; waste always.
3. **Threshold trigger**: `level !== null && level < threshold` (strictly below).
4. **Alarm trigger**: a DRMS alarm with `status = 'ReadyForErpDelivery'`, received within
   **7 days (default)**, category `toner` (`TN-*`, `TS-*`) whose colour is read from the
   description's bracket — `(K)`/`(BK)` black, `(C)` cyan, `(M)` magenta, `(Y)` yellow — or
   category `waste` (`TO-*`, `TR-*`) → waste. `parts` / `service` / `jam` never propose. An alarm
   for a CMY channel on a mono device is ignored.
5. A channel that triggers is **suppressed** when any of these hold:
   - a live proposal for that device + colour already exists;
   - an open order for that colour: a Vantage sales-order line (not returned, order not deleted,
     `completed_date is null`) on the device's equipment, **or** one of our own
     `replenishment_orders` still in flight (`queued|submitting|uncertain`, or `submitted` whose
     Vantage order has not been pulled yet or is still open);
   - an order for that colour completed less than **14 days** ago;
   - a proposal for that colour was **rejected less than 7 days ago (default)**, unless the
     trigger is an alarm received after the rejection.
6. Threshold wins over alarm when both fire (it carries a level); the alarm is recorded alongside.

`supersede`: a `pending` **threshold** proposal whose current level is back at or above its
threshold (a cartridge was fitted) becomes `superseded`. Alarm proposals are never superseded by a
level recovering. Switching `auto_replenish` off supersedes **every** pending proposal of that device,
whatever its trigger — a manual device has no place in the review queue.

## Settings cascade (SQL, one place)

`effectiveSettingsSubquery(db)` returns one row per DRMS device with each effective value **and its
source** (`device|customer|default`) — `coalesce(device.x, customer.x, default.x)`. The engine, the
fleet counts, the devices-list filters, the queue and the device page all read it, so they cannot
disagree.

"Needs toner" (fleet tile, devices filter) = any cartridge the device has is **below its effective
threshold** and `auto_replenish` is on. "Manual replenishment" filter = the same test with
`auto_replenish` off. The 5% / 20% colours on the toner bars stay as they are — they are a display
scale, not an ordering rule.

## Jobs (worker)

- `replenish-evaluate` — runs the engine over every Registered/Discovered device, inserts new
  proposals, supersedes recovered ones. Queued after `drms-snapshot`, `drms-alarms` and
  `vantage-orders` finish (like `link-run`), and runnable by hand.
- `vantage-order-submit` — sends every `queued` order, **one POST per order, never retried**.
  A 2xx stores the response (Id / Reference / IsOnHold when present) and marks it `submitted` and
  its proposals `ordered`. A 4xx is `failed` with Vantage's message. A timeout, network error or
  5xx is **`uncertain`**: the order may exist, so a person checks Vantage and marks it
  ordered or failed — the job never re-sends. Queued by the web app on approval.
- `vantage-orders` (existing) additionally sets `created_by_mps` on pulled sales orders whose id
  is in `replenishment_orders.vantage_sales_order_id`.

**Kill switch**: worker env `VANTAGE_ORDERS_ENABLED` (default **false**). While false the submit
job leaves orders `queued` and does nothing else. The worker writes the flag to
`app_state.vantage_orders_enabled` at startup so the web app can show "Sending to Vantage is
switched off" on the queue.

## Vantage API — to be confirmed live (Task 1 gate)

The docs give the body (`{ components: [{ Type, RequestedPartNumber?, RequestedQuantity? }] }`,
Type 1 Black · 2 Cyan · 3 Magenta · 4 Yellow · 5 Waste) but not the exact path (`Equipment(1)/
CreateConsumableOrder` vs without the slash) nor the response. They say 201 returns the created
record, 204 nothing, and that a mismatched part number yields an **on-hold** order. The first live
call — a genuine order for a device that needs toner, chosen by the user — settles this and its
findings are written back into this section before the submit job is built.

## UI

- **Toner orders** (`/orders`, sidebar item with a badge of devices awaiting review). Tabs
  *Review · In progress · Ordered · Rejected*. Review groups proposals by device: model, site,
  customer, and per colour the level vs effective threshold (with source), the trigger (threshold,
  or alarm description), the last order of that colour and any open order. Per colour a checkbox
  and quantity stepper; per device *Approve selected* and *Reject*. Header stats: awaiting review,
  open MPS orders, cartridges ordered this quarter. Banner when the kill switch is off.
- **Fleet overview**: "Needs toner" uses the cascade and links to `/orders`; sub-line
  "N awaiting review · M on order".
- **Device page**: a *Replenishment* card — effective threshold per channel with its source and
  "set by user, date", auto-replenish and alerts, *Edit* (device level, including reset to
  inherited), and this device's live proposals and MPS orders. A "Manual replenishment" badge when
  auto-replenish is off.
- **Devices list**: checkbox column, select page, select all matching, bulk actions bar
  (thresholds per colour, auto-replenish, alerts, reset), confirmation dialog, new filter tab
  *Manual replenishment*; *Needs toner* switches to the cascade rule.
- **Replenishment settings** (`/settings/replenishment`, all users): the default row, and a table
  of customer overrides with add / edit / reset.

## Out of scope

Site stock (sub-project 4) in the queue, notifications (5), meter sync (2), an ad-hoc "order now"
form without a proposal (the mockup's left panel), staples, part-number selection (Vantage picks the
compatible consumable), delivery address selection (Vantage's ship-to).

## Verification

Unit tests for the engine and settings cascade; PGlite tests for every query, action and job with
fake clients; one live, user-approved Vantage order before enabling the kill switch; a full test
pass written up as `docs/TEST-REPORT-*.md` at the end.

## Added requirement (2026-09-21, user): "Needs reconnecting"

Machines drop off CSRC and nobody notices: CSRC doesn't make it visible, and the app's only alert
("No meter reading", 24 h) covers Registered devices that have reported counters. Example: Frimley C
of E Junior School's four machines first connected on install day (4 Aug 2023) and have sent nothing
since. The user wants to react as machines *start* to go offline.

- **Last contact** per DRMS device = the newest of `last_counter_received_time`, DRMS
  `LastAlarmReceivedTime` (from `raw`), our newest `device_alarms.received_time`, and DRMS
  `InitialConnectionTime` (so a machine that only ever connected at install still has a date).
- **Needs reconnecting** = linked to Vantage equipment (active link, equipment not deleted), DRMS
  status not Deleted, not missing, last contact older than **14 days** (`RECONNECT_DAYS`, a named
  constant; the user said "14 days at least"). A device with no contact date at all is included.
- **Pattern**: `install_only` (no alarm and no counter ever) or `went_quiet`. **Signal**: `counters`
  when the device has ever reported a counter (a strong daily heartbeat), else `alarms` (weak: a
  healthy machine can go weeks without an alarm), shown so an operator knows how sure the list is.
- Ordered **most recently silent first** (newly dropped off at the top). Filter tabs *All · Newly
  silent (14–30 days) · Long silent (over 30 days) · Only connected at install*; search by
  customer/serial; **Export CSV** of the current view.
- Fleet overview tile "Needs reconnecting" (count; sub-line "N went quiet in the last 30 days")
  linking to the page; sidebar item with the newly-silent count as its badge.
- Registering more devices is what strengthens the signal: a Registered device's daily counters
  make silence certain within a day.

**Correction (user, same day): DRMS has no heartbeat for a Discovered device.** BSRIA's and CB
Heslop's machines have never had a DRMS alarm on record, yet they check in on CSRC every day — "no
alarm" only means no alarm reached DRMS. So:
- A device is **silent** (and listed as needing reconnection) **only if it has ever reported a meter
  reading** (`last_counter_received_time is not null`) and its last contact is older than 14 days.
  For those devices last contact is the newest of the meter reading and any alarm.
- Devices with **no meter reading ever** are never called silent or offline. They appear on the same
  page in a separate tab, **"Not monitored yet"**, grouped as *Registered, waiting for first reading*
  and *Not registered in DRMS* (register them to monitor them), with their DRMS status, first
  connection and any last alarm shown for information.
- The `install_only` pattern is dropped; the `signal` field is dropped (every silent device is
  counter-based). Filter tabs: *Newly silent (14–30 days) · Long silent (over 30 days) · Not
  monitored yet*.
- The Fleet overview tile and sidebar badge count **silent** devices only.

## Added requirement (2026-09-21, user): auto-register new machines in DRMS

> **REVISED by the user the same day: approval queue, not automatic.** The nightly job only
> *discovers and checks*; machines that pass the rules go to **Awaiting approval**. Nothing is sent to
> DRMS until a person approves (per row or a ticked selection). Approved rows are registered by the
> worker one at a time with the pause below. Rejected rows leave the queue and are not proposed again
> unless un-rejected. **No kill switch** — approval is the gate. Every attempt is logged (request,
> response, result, DRMS status after) and every approve/reject/retry is audited; the page has a CSV
> export of the log. Tabs: *Awaiting approval · Waiting · Registered · Failed · Rejected*; sidebar badge
> = awaiting approval. Customer mismatches are flagged in the queue (the user decides at approval).
> Statuses become `awaiting_approval | waiting | approved | registered | failed | rejected`. Where the
> text below says "automatically", "dry run", `ready` or the kill switch, this revision wins.

When an engineer connects a new machine to CSRC it appears in DRMS as **Discovered** (our hourly
`drms-pull` sees it). Registering it by hand is what we did all day on 2026-09-21; the user wants a
routine so every new machine is registered — and therefore monitored with daily meter readings —
without anyone remembering to do it. **This lifts the Foundation rule "DRMS is read-only"** for
exactly one call family: `EquipmentRequest/Register` and polling `EquipmentRequest/{id}`.

Rules (the ones settled with the user while registering ~550 devices by hand):
- DRMS status **Discovered**, not missing; `CommunicationType = CSRC_HTTP` on `COM_GB502`/`COM_GB503`;
  has CsrcId, CsrcProductId, a 13-character serial and a `CUST…` customer code; DRMS `ErpId` empty or
  equal to the serial (a different ErpId means someone else set it — leave it).
- Name not refurb/unsold/awaiting/demo/loan; not an excluded customer (configurable regex, default
  `tfc group` — Primaflow TFC Group; Abacus Direct is now allowed).
- **Exactly one** Vantage equipment with that serial (not deleted), with a customer and an **active
  contract** (status 1, not on hold, not cancelled, not deleted) — checked live against Vantage per
  candidate, read-only, as the batch selector does.
- **No check-in rule** — DRMS has no heartbeat for Discovered devices.
- **Customer mismatches are registered automatically** (user decision) and flagged on the page.
- `EquipmentErpId` = the Vantage `Equipment.Id`; the other fields from DRMS's own record, exactly as
  `register.mjs` sends them.

Safety (learnt the hard way): **one registration at a time, never in parallel**; a pause between
registrations (`AUTO_REGISTER_PAUSE_SECONDS`, default **90** — the DRMS backbone deadlocks under a
steady stream); a cap per run (`AUTO_REGISTER_MAX_PER_RUN`, default **40**); poll each request every
30 s for up to 20 min; **never re-send** a request that has an id; a 429 or auth error stops the run;
a DRMS pre-check read that fails (e.g. HTTP 500) skips the device without sending anything.

Outcomes, one row per attempt in `drms_registrations`: `registered` · `failed` (DRMS error text,
e.g. a Backbone deadlock that leaves the device Deleted) · `waiting` (a rule not yet met — no Vantage
match yet, no active contract…, re-checked every run, reason shown). A failed device can be retried
from the page (re-registration of a device DRMS set to Deleted worked on 2026-09-21).

Schedule: daily at **03:30** Europe/London (after the 02:00 Vantage pull and its link run), plus
*Run now* on the Jobs page. Kill switch `DRMS_AUTO_REGISTER_ENABLED` (default **false**): while off the
job still evaluates and records `waiting`/would-register rows as a dry run (status `ready`), but
sends nothing. Mirrored to `app_state.drms_auto_register_enabled` for the page banner.

UI: **Registrations** page (`/registrations`): tabs *Registered · Ready (dry run) · Waiting · Failed*,
with serial, device name, Vantage customer, customer-match flag, reason/DRMS message, dates; *Retry*
on failed rows; banner when the switch is off. Linked from Admin → Jobs and the sidebar.
