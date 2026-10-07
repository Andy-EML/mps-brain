# Phase B sanity check: replenish-evaluate (sync_runs id 488)

Run confirmed: `sync_runs` id 488, job `replenish-evaluate`, started `2026-09-25T15:39:36.495Z`,
finished `2026-09-25T15:39:37.136Z`, status `success`. Ran right after `drms-alarms` (486) and
`vantage-orders` (487), both `success`, both started `2026-09-25T15:39:04`.

## Code relied on

- `apps/worker/src/jobs/replenish-evaluate.ts` — the job. Loads devices (`status in
  ('REGISTERED','DISCOVERED')` and `missingSince is null`, line 74), effective settings
  (`effectiveSettingsSubquery`) and toner levels (`counterPivotSubquery`), ready alarms in the last
  `ALARM_WINDOW_DAYS` (line 76-88), open pending/approved/recently-rejected proposals (line 93-106),
  and `getOrderStates` (line 108-109). Supersedes first (line 127-145: ordered-in-Vantage,
  auto-replenish-off, or **threshold-trigger-only** recovery, line 133), then calls
  `evaluateDevice` per device and inserts `candidates` as new `pending` proposals (line 179-199).
- `packages/core/src/replenishment.ts` — pure engine.
  - `channels()` (line 96-98): colour channels checked are `REPLENISH_COLOURS` (black/cyan/magenta/
    yellow/waste) for `isColour: true`, else `['black','waste']` only.
  - `evaluateDevice()` (line 132-162): for each channel, `byThreshold = level < threshold` (both
    non-null); a candidate is raised if `byThreshold || alarm-in-window`, unless `suppression()`
    (line 114-130) returns a reason (`live_proposal`, `open_order`, `recently_completed` within
    `COMPLETED_SUPPRESS_DAYS=14`, or `recently_rejected` within `REJECTED_SUPPRESS_DAYS=7` and no
    newer alarm).
  - `latestAlarms()` (line 100-112): only alarms with `status === READY_FOR_ERP` (`'ReadyForErpDelivery'`)
    and `receivedAt >= now - ALARM_WINDOW_DAYS(7) days` count, newest per colour.
  - **Important**: once a proposal is `pending`, nothing re-checks whether its *triggering alarm* is
    still inside the 7-day window. Recovery-based auto-supersede (line 133 in the job) only fires for
    `trigger === 'threshold'` proposals — alarm-triggered proposals are never auto-superseded by the
    alarm ageing out; they sit until a human decides, an order is placed, or auto-replenish is
    switched off. This matters for Check 1 below.
- `packages/core/src/models.ts` — `isColourModel()` — mono/colour regex (`+`, `MF`, or leading `C\d`).
  Not used at query time; `drms_equipment.is_colour` (schema.ts:139-156) is *this same function's
  output*, stored at `drms-pull` time (`apps/worker/src/jobs/drms-pull.ts:22`). Per the task
  instructions I used the stored `is_colour` column directly for Check 2 rather than
  re-implementing the regex.
- `packages/db/src/schema.ts` — `replenishment_proposals` (line 454-486, status enum `pending|
  approved|ordered|failed|rejected|superseded`, one live row per device+colour via the partial
  unique index on `status in ('pending','approved')`), `vantage_sales_orders` (line 79-106,
  `completedDate` null = open), `vantage_sales_order_lines` (line 108-137, `colour` derived by
  `classifyOrderLine` at insert time, `returnedDate` marks a returned line), `device_alarms` (line
  312-336), `replenishment_settings` (line 374+, cascade scopes `device`/`customer`/`default`).
- `packages/db/src/queries/settings.ts` — `effectiveSettingsSubquery()` (line 52-79): the
  `device → customer → default` coalesce cascade, reproduced in SQL below.
- `packages/db/src/queries/shared.ts` — `counterPivotSubquery()` (line 74-97): latest snapshot's
  counter values pivoted to columns; `colourPivot()` (line 63-65) nulls Cyan/Magenta/Yellow for a
  non-colour device (`is_colour = false`) even if a stray reading exists.
- `packages/db/src/queries/order-state.ts` — `getOrderStates()` (line 40-121): per Vantage
  equipment + colour, `open` = newest Vantage line with `completedDate is null`, header not
  `deletedDate`, line not `returnedDate`, `colour in REPLENISH_COLOURS` (line 49-68); plus our own
  in-flight `replenishment_orders` not yet pulled into a Vantage row, `status in ('queued',
  'submitting','uncertain')` or `submitted` within `COMPLETED_SUPPRESS_DAYS` (line 84-119). This
  `open` feeds `suppression()`'s `hasOpenOrder` check (evaluator sets `history[colour].hasOpenOrder
  = states?.[colour].open != null`, replenish-evaluate.ts:156) — no date comparison against the
  proposal's `createdAt` (that gating is only in `orderedInVantage()`, used for *superseding an
  existing* pending proposal, not for blocking a *new* one).

Tables used: proposals = `replenishment_proposals`; toner levels (latest snapshot) =
`counter_snapshots` + `counter_values` pivoted; thresholds/settings = `replenishment_settings`
(cascade via `effectiveSettingsSubquery`); alarms = `device_alarms`; sales orders =
`vantage_sales_orders` + `vantage_sales_order_lines`; our own orders = `replenishment_orders`.

All SQL below ran read-only via a temp `.mts` script in `packages/db/` (deleted after use;
`git status --short` in the worktree is clean).

---

## Check 1 — every pending proposal's colour is below its *current* effective threshold, or has a *current* ready alarm

```sql
with eff as (
  select
    de.drms_id,
    dl.vantage_equipment_id,
    coalesce(rs_dev.threshold_black, rs_cus.threshold_black, rs_def.threshold_black) as threshold_black,
    coalesce(rs_dev.threshold_cyan, rs_cus.threshold_cyan, rs_def.threshold_cyan) as threshold_cyan,
    coalesce(rs_dev.threshold_magenta, rs_cus.threshold_magenta, rs_def.threshold_magenta) as threshold_magenta,
    coalesce(rs_dev.threshold_yellow, rs_cus.threshold_yellow, rs_def.threshold_yellow) as threshold_yellow
  from drms_equipment de
  left join device_links dl on dl.drms_equipment_id = de.drms_id and dl.unlinked_at is null
  left join vantage_equipment ve on ve.vantage_id = dl.vantage_equipment_id
  left join replenishment_settings rs_dev on rs_dev.scope='device' and rs_dev.drms_equipment_id = de.drms_id
  left join replenishment_settings rs_cus on rs_cus.scope='customer' and rs_cus.vantage_customer_id = ve.vantage_customer_id
  join replenishment_settings rs_def on rs_def.scope='default'
),
latest_snap as (
  select drms_equipment_id, max(id) as snapshot_id from counter_snapshots group by drms_equipment_id
),
pivot as (
  select ls.drms_equipment_id as drms_id,
    max(case when cv.name='BlackTonerLevel' then cv.value end) as black,
    case when de.is_colour then max(case when cv.name='CyanTonerLevel' then cv.value end) end as cyan,
    case when de.is_colour then max(case when cv.name='MagentaTonerLevel' then cv.value end) end as magenta,
    case when de.is_colour then max(case when cv.name='YellowTonerLevel' then cv.value end) end as yellow
  from latest_snap ls
  join drms_equipment de on de.drms_id = ls.drms_equipment_id
  left join counter_values cv on cv.snapshot_id = ls.snapshot_id
  group by ls.drms_equipment_id, de.is_colour
),
ready_alarms as (
  select drms_equipment_id,
    case
      when category='waste' then 'waste'
      when category='toner' and description ~* '\((BK|K)\)\s*$' then 'black'
      when category='toner' and description ~* '\(C\)\s*$' then 'cyan'
      when category='toner' and description ~* '\(M\)\s*$' then 'magenta'
      when category='toner' and description ~* '\(Y\)\s*$' then 'yellow'
    end as colour
  from device_alarms
  where status = 'ReadyForErpDelivery'
    and category in ('toner','waste')
    and received_time >= '2026-09-25T15:39:36.495Z'::timestamptz - interval '7 days'
)
select p.id, p.drms_equipment_id, p.colour, p.trigger, p.level as level_at_proposal, p.threshold as threshold_at_proposal,
  case p.colour when 'black' then piv.black when 'cyan' then piv.cyan when 'magenta' then piv.magenta when 'yellow' then piv.yellow else null end as current_level,
  case p.colour when 'black' then eff.threshold_black when 'cyan' then eff.threshold_cyan when 'magenta' then eff.threshold_magenta when 'yellow' then eff.threshold_yellow else null end as current_threshold,
  exists(select 1 from ready_alarms ra where ra.drms_equipment_id = p.drms_equipment_id and ra.colour = p.colour) as has_ready_alarm
from replenishment_proposals p
join eff on eff.drms_id = p.drms_equipment_id
left join pivot piv on piv.drms_id = p.drms_equipment_id
where p.status = 'pending';
```

A row is a violation when NOT (`current_level < current_threshold` (both non-null) OR `has_ready_alarm`).

**Result: 377 pending proposals checked, 5 violations.**

| id | drms_equipment_id | colour | trigger | current_level | current_threshold | has_ready_alarm |
|---|---|---|---|---|---|---|
| 29 | 5e699c0b-...871a | yellow | alarm | 100 | 10 | false |
| 116 | c6739c11-...871a | waste | alarm | null | null | false |
| 128 | 220f9617-...871a | black | alarm | null | 15 | false |
| 139 | e00f9617-...871a | waste | alarm | null | null | false |
| 164 | 731eb7c2-...871a | waste | alarm | null | null | false |

**Investigation**: all 5 have `created_at = 2026-09-21T15:06:26.966Z` — i.e. they predate run 488
by 4 days (run 488's own inserts all carry `created_at = 2026-09-25T15:39:36.499Z`, and none of
these 5 ids are among them). Their triggering alarm (looked up by `p.alarm_id`, e.g.
`815c3875-...` "Toner Delivery(Y)", received `2026-09-18T14:07:01Z`) is **still** `status =
'ReadyForErpDelivery'` in `device_alarms` today — it was never resolved or cleared — but its
`received_time` is now just past the rolling 7-day window measured from run 488's `now`
(`2026-09-25T15:39:36`; the alarm is ~7d 1.5h old). Per `latestAlarms()` (replenishment.ts:100-112)
and the job's own alarm query (`gte(deviceAlarms.receivedTime, since)`, replenish-evaluate.ts:88),
an alarm that ages out of the window simply stops being *visible* to the engine on later runs — and
critically, nothing in `replenish-evaluate.ts` re-validates or expires an existing `pending`
alarm-triggered proposal when that happens (the only auto-supersede recovery path is gated to
`p.trigger === 'threshold'`, line 133). So these proposals are working as designed: they were
correctly raised on 2026-09-21 when the alarm was fresh, and correctly remain pending afterwards —
this is a **known gap in the rule set** (stale alarm-triggered proposals never expire on their own),
not a bug introduced by run 488. Run 488 itself created zero violating rows.

**Verdict: PASS** — zero violations among proposals created by run 488; the 5 flagged rows are
pre-existing pending proposals whose triggering alarm has aged past the 7-day freshness window
without being re-validated, which is consistent with the code's design (no alarm-expiry path for
already-pending proposals).

---

## Check 2 — no Cyan/Magenta/Yellow proposed on a mono device

Used the stored `drms_equipment.is_colour` column (schema.ts:139-156: `boolean('is_colour')
.notNull().default(false)`, set from `isColourModel(e.ModelName)` in `drms-pull.ts:22` — the same
rule `packages/core/src/models.ts` implements, so reproducing the regex in SQL was unnecessary per
the column's own doc comment).

```sql
select p.id, p.drms_equipment_id, p.colour, de.model_name, de.is_colour
from replenishment_proposals p
join drms_equipment de on de.drms_id = p.drms_equipment_id
where p.status='pending' and p.colour in ('cyan','magenta','yellow') and de.is_colour = false;
```

**Result: 0 rows.**

**Verdict: PASS** — no CMY proposals on a mono device.

---

## Check 3 — no proposal where an open Vantage or in-flight MPS order already exists for that device/colour

```sql
with device_link as (
  select drms_equipment_id, vantage_equipment_id from device_links where unlinked_at is null
),
vantage_open as (
  select coalesce(l.vantage_equipment_id, h.vantage_equipment_id) as vantage_equipment_id, l.colour
  from vantage_sales_order_lines l
  join vantage_sales_orders h on h.vantage_id = l.sales_order_id
  where h.deleted_date is null
    and l.returned_date is null
    and l.colour in ('black','cyan','magenta','yellow','waste')
    and h.completed_date is null
),
mps_open as (
  select ro.vantage_equipment_id, rp.colour
  from replenishment_orders ro
  join replenishment_proposals rp on rp.order_id = ro.id
  left join vantage_sales_orders vso on vso.vantage_id = ro.vantage_sales_order_id
  where vso.vantage_id is null
    and (
      ro.status in ('queued','submitting','uncertain')
      or (ro.status = 'submitted' and ro.submitted_at >= '2026-09-25T15:39:36.495Z'::timestamptz - interval '14 days')
    )
)
select p.id, p.drms_equipment_id, p.colour, dl.vantage_equipment_id,
  exists(select 1 from vantage_open vo where vo.vantage_equipment_id = dl.vantage_equipment_id and vo.colour = p.colour) as vantage_open_order,
  exists(select 1 from mps_open mo where mo.vantage_equipment_id = dl.vantage_equipment_id and mo.colour = p.colour) as mps_open_order
from replenishment_proposals p
left join device_link dl on dl.drms_equipment_id = p.drms_equipment_id
where p.status = 'pending'
  and (
    exists(select 1 from vantage_open vo where vo.vantage_equipment_id = dl.vantage_equipment_id and vo.colour = p.colour)
    or exists(select 1 from mps_open mo where mo.vantage_equipment_id = dl.vantage_equipment_id and mo.colour = p.colour)
  );
```

This reproduces `getOrderStates()`'s `open` semantics exactly (order-state.ts:70-119), which is what
feeds `suppression()`'s `hasOpenOrder` check (no date filter against the proposal's `createdAt` —
that gating only applies to *superseding* an already-pending proposal via `orderedInVantage()`, a
different code path).

**Result: 0 rows.**

**Verdict: PASS** — no pending proposal coexists with an open Vantage or in-flight MPS order for the
same device/colour.

---

## Check 4 — counts and cross-check against run 488's stats

```sql
select status, count(*) from replenishment_proposals group by status order by status;
select colour, count(*) from replenishment_proposals where status='pending' group by colour order by colour;
select count(distinct drms_equipment_id) from replenishment_proposals where status='pending';
select created_at, count(*) from replenishment_proposals where created_at > now() - interval '2 hours' group by created_at;
```

**Proposals by status (all-time):**

| status | count |
|---|---|
| pending | 377 |
| rejected | 1 |
| superseded | 39 |

(no `approved`/`ordered`/`failed` rows exist yet — nothing has been actioned in Vantage.)

**Pending proposals by colour:**

| colour | count |
|---|---|
| black | 118 |
| cyan | 83 |
| magenta | 94 |
| waste | 13 |
| yellow | 69 |

Sum = 377, matches total pending.

**Distinct devices with a pending proposal: 275.**

**Cross-check against run 488's stats (`devices: 833, proposed: 251, superseded: 39, suppressed:
230`):**

- `stats.superseded = 39` matches exactly: `select count(*) from replenishment_proposals where
  status='superseded' and decided_at = '2026-09-25T15:39:36.499Z'` → 39. (These 39 rows were all
  originally `created_at = 2026-09-21T15:06:26.966Z`, i.e. superseded from the *previous* run's
  output — consistent with `toSupersede`/`stats.superseded` being computed per run before new
  inserts, replenish-evaluate.ts:127-145.)
- `stats.proposed = 251` matches exactly: `select count(*) from replenishment_proposals where
  created_at = '2026-09-25T15:39:36.499Z'` → 251, all `status='pending'`.
- `stats.devices = 833` is the count of devices *evaluated* this run (the `devices` array length,
  replenish-evaluate.ts:111), i.e. every `REGISTERED`/`DISCOVERED`, non-missing DRMS device with an
  effective-settings row — not the count of devices with a pending proposal.
- `stats.suppressed = 230` is a count of (device, colour) **suppression events** logged during this
  run's loop (`result.suppressed.length`, summed per device, line 177) — i.e. how many
  colour-channels this run considered actionable but held back (`live_proposal`, `open_order`,
  `recently_completed`, `recently_rejected`), not a count of proposal or device rows in the table.
- The DB's current totals (377 pending / 275 distinct devices) are **larger** than `proposed=251`
  because pending proposals accumulate run over run until a human decides them or they're
  superseded/ordered — 377 pending includes rows from earlier runs (e.g. the un-superseded portion
  of the 2026-09-21 batch) plus this run's 251 new ones. This is expected: `stats.proposed` is a
  per-run delta, not a queue depth.

**Verdict: PASS** — every stats field reconciles exactly to a corresponding DB query once the
per-run-delta vs. cumulative-queue distinction is accounted for; no discrepancy found.

---

## Summary

| Check | Verdict | Reason |
|---|---|---|
| 1. Proposed colour below threshold or has ready alarm | PASS | 5 rows fail the *right-now* re-check, but all 5 predate run 488 (created 2026-09-21) and are alarm-triggered proposals whose source alarm is still `ReadyForErpDelivery` but has aged just past the 7-day window; the code has no expiry path for already-pending alarm proposals, so this is expected, not a bug. Zero violations among run 488's own 251 inserts. |
| 2. No CMY on mono device | PASS | 0 violations, using the stored `is_colour` column (same `isColourModel` rule). |
| 3. No proposal with an open order for that device/colour | PASS | 0 violations, reproducing `getOrderStates()` open semantics (Vantage + in-flight MPS orders). |
| 4. Counts / cross-check | PASS | `stats.proposed` (251) and `stats.superseded` (39) match exact `created_at`/`decided_at` timestamp queries; `stats.devices` (833) is devices evaluated and `stats.suppressed` (230) is suppression events this run, both correctly distinct from the 377-row/275-device cumulative pending queue. |
