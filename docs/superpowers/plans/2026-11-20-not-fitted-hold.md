# Not-fitted hold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hold toner proposals whose last delivered cartridge for that colour was probably never fitted, in a new "Probably on site" tab, using an interpolated meter-on-a-date shared by the hold rule, the yield line and the Review panel.

**Architecture:** One pure meter function (`meterAt`, `packages/db/src/queries/toner-yield.ts`) replaces `meterPointAt` everywhere. One pure decision (`decideHold`, `packages/core/src/not-fitted.ts`). One loader (`computeHolds`, `packages/db/src/queries/not-fitted.ts`) feeds it per pending proposal; `runReplenishEvaluate` writes `hold_reason`/`hold_detail` every run. The queue gets an `on-site` tab; Review excludes held rows.

**Tech Stack:** TypeScript, Drizzle (Postgres), Vitest, Next.js app router (apps/web), pnpm monorepo.

**Spec:** `docs/superpowers/specs/2026-11-19-not-fitted-hold-design.md`

## Global Constraints

- Vantage read-only: GET only. The app only proposes.
- Do NOT commit. No `git commit` in any task (user rule: commits only with the user's OK). Leave changes in the working tree.
- Never print `DATABASE_URL` or any credential.
- Hold point: pages since order < **50%** of rated × N → `low_yield`. Safety net: pages since ≥ **100%** of rated × N → never held.
- Fitted = level evidence only, after the anchor: a reading ≤ `LOW_LEVEL` (15) later followed by ≥ `RISE_LEVEL` (50), or a rise of ≥ **30** points between consecutive readings. Toner Empty alarms never count as fitted.
- Anchor = last order's `order_date` (not `completed_date`: Vantage completes toner orders a median of 9 days after ordering, p90 19, live check 2026-11-20; completion is not delivery). Last order = all lines of that colour (not deleted, not returned, equipment = `coalesce(line.vantage_equipment_id, order.vantage_equipment_id)`) sharing the newest order day (London); N = summed quantity (null/invalid = 1).
- Meter at date t: exact reading; else linear interpolation between newest before and oldest after when ≤ **45** days apart; else newest before, or oldest after within `METER_LOOKAHEAD_DAYS` (14); else unknown. Text shows "~" when interpolated.
- Stale meters (newest meter reading > 14 days before now) → no `low_yield` hold.
- Out of scope for holds: waste, `site_stock`, `spare_used`, shelf proposals (`shelf_id` not null), proposals referenced by `cartridge_changes.proposal_id`.
- Hold reasons: `not_fitted` | `low_yield`. Copy examples: "Magenta sent 22 Sep 2026, no new cartridge seen since — spare should be on site"; "~8,220 pages since magenta sent 2 Apr 2026 (29% of 28,000) — April cartridge probably not fitted".
- `METER_WINDOW_MONTHS` = 24.
- Tests: `pnpm vitest run <path>` from repo root `C:\dev\mps-brain-replenishment`; typecheck `pnpm -r exec tsc --noEmit` (or the repo's `typecheck` script if present).

## Review Focus

1. Delivery fitted the same day it was completed (reading before anchor low, first after high) → counts as fitted (a jump spanning the anchor counts); test in Task 2.
2. Quantity 2 with one fit seen → still held; two fits → released; test in Task 2.
3. Proposal that later becomes a spare-black cover (`cartridge_changes.proposal_id`) → hold cleared that run; test in Task 4.
4. Held proposal approved from the on-site tab → order created as from Review, and the held row leaves both tabs; test in Task 6.
5. Device with a meter reset after the order (latest < meter at order) → pages unknown → no low_yield hold; test in Task 1/2.

---

### Task 1: `meterAt` — interpolated meter on a date

**Files:**
- Modify: `packages/db/src/queries/toner-yield.ts` (replace `meterPointAt`; update `buildCartridges`, `computeColourYield`, `ColourYield`)
- Test: `packages/db/src/queries/toner-yield.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const INTERPOLATE_MAX_DAYS = 45;
  export interface MeterAt { value: number; estimated: boolean; before: YieldMeterPoint | null; after: YieldMeterPoint | null }
  export function meterAt(points: YieldMeterPoint[], t: Date): MeterAt | null
  // ColourYield gains: pagesSinceEstimated: boolean
  ```
  `before`/`after`: the bracketing points used (exact or fallback-before → `{before: p, after: null}`; fallback-after → `{before: null, after: p}`; interpolated → both). Value rounded to an integer.
- `meterPointAt` is removed; grep the repo for other callers and move them to `meterAt`.

- [ ] **Step 1: Write failing tests** in `toner-yield.test.ts` (`describe('meterAt')`):
  - exact hit at t → `{ value, estimated: false }`.
  - points 27 Mar 2026 = 33,710 and 26 Apr 2026 = 35,356, t = 2 Apr 2026 → `estimated: true`, value = 33,710 + round(1646 × 6/30) = 34,039 (assert within ±1 of linear formula computed in the test).
  - gap of 46 days around t → falls back to newest before (`estimated: false`, value = before).
  - nothing before, first point 10 days after → that point; 15 days after → null.
  - `buildCartridges`: two deliveries both inside one interpolation gap with no reading between → `pagesDone` null; deliveries with a reading between → measured from interpolated ends.
  - `computeColourYield`: last order 2 Apr between the two points above, latest point 42,251 → `pagesSinceLastOrder` = 42,251 − meterAt(2 Apr).value, `pagesSinceEstimated: true`; latest < base (reset) → null.
- [ ] **Step 2:** `pnpm vitest run packages/db/src/queries/toner-yield.test.ts` → FAIL (`meterAt` not exported).
- [ ] **Step 3: Implement.** `buildCartridges`: pagesDone null when either end null, when both ends share the same `before` and `after` (no reading between the deliveries — generalises today's `a !== b`), or when b < a. `computeColourYield`: base = `meterAt(points, last.orderDate)`; keep "current must be after order date" and "no negative" rules; set `pagesSinceEstimated = base.estimated`.
- [ ] **Step 4:** same command → PASS; run the whole `packages/db` tests and `apps/web/src/components/toner-yield.test.ts` → PASS.

### Task 2: `decideHold` — pure rule

**Files:**
- Create: `packages/core/src/not-fitted.ts`, `packages/core/src/not-fitted.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces:**
- Consumes: `LOW_LEVEL`, `RISE_LEVEL` from `./cartridge-change`.
- Produces:
  ```ts
  export const FIT_JUMP_POINTS = 30;
  export const LOW_YIELD_HOLD_PCT = 0.5;
  export const SAFETY_NET_PCT = 1;
  export type HoldReason = 'not_fitted' | 'low_yield';
  export interface HoldInput {
    colour: 'black' | 'cyan' | 'magenta' | 'yellow';
    lastOrder: { anchor: Date; orderDate: Date; reference: string | null; quantity: number } | null;
    /** That colour's DRMS level readings, any order. */
    levels: { at: Date; value: number }[];
    /** Pages since lastOrder.orderDate (Task 1 figure); null = not measurable. */
    pagesSince: number | null;
    pagesSinceEstimated: boolean;
    ratedYield: number | null;
    metersStale: boolean;
  }
  export interface HoldDecision { reason: HoldReason; detail: string }
  export function countFits(levels: { at: Date; value: number }[], anchor: Date): number
  export function decideHold(input: HoldInput): HoldDecision | null
  ```
- `countFits`: sort by time; seed `prev` = last reading at or before anchor (if any) and `low = prev.value <= LOW_LEVEL`. For each reading after anchor: if `prev` and `r - prev >= FIT_JUMP_POINTS` → fit, `low = false`; else if `low` and `r >= RISE_LEVEL` → fit, `low = false`; then if `r <= LOW_LEVEL` → `low = true`. `prev = r`. (A jump spanning the anchor counts — Review Focus 1.)
- `decideHold` order: no lastOrder → null; `countFits >= quantity` → null; let `full = ratedYield × quantity`; if any level reading at or before anchor: `pagesSince !== null && full && pagesSince >= SAFETY_NET_PCT × full` → null, else `not_fitted`; otherwise (history starts after anchor): ratedYield null, pagesSince null, or metersStale → null; `pagesSince < LOW_YIELD_HOLD_PCT × full` → `low_yield`; else null.
- Detail copy (date format `d MMM yyyy`, en-GB, numbers with thousands commas, % rounded):
  - not_fitted: `"{Colour} sent {orderDate}{ ({ref})}, no new cartridge seen since — spare should be on site"`; quantity > 1: `"{N} {colour} sent {date}{ ({ref})}, {k} fitted since — spares should be on site"`.
  - low_yield: `"{~}{pages} pages since {colour} sent {orderDate} ({pct}% of {full}) — {Month} cartridge probably not fitted"` (`~` only when estimated; `{Month}` = full month name of orderDate; quantity > 1 → "cartridges").

- [ ] **Step 1: Write failing tests** covering: no order → null; Northwood: anchor 2 Apr 2026, levels start 20 Sep at 1 → 0, pages 8,220 estimated, rated 28,000, qty 1 → `low_yield`, detail exactly `"~8,220 pages since magenta sent 2 Apr 2026 (29% of 28,000) — April cartridge probably not fitted"`; history spans anchor (reading 22 Sep at 3%, anchor 22 Sep 2026 completed, readings after stay ≤ 3) → `not_fitted`, detail `"Magenta sent 22 Sep 2026, no new cartridge seen since — spare should be on site"` (reference null); same plus pagesSince ≥ rated → null; rise 10 → 92 after anchor → null; rise 40 → 75 (jump 35) → null; low 12 then 55 three readings later → null; jump spanning anchor (5 before, 95 after) → null; qty 2 with one fit → `not_fitted`, two fits → null; pages 15,000/28,000 → null; stale meters → null; ratedYield null → null; pagesSince null (reset) → null.
- [ ] **Step 2:** `pnpm vitest run packages/core/src/not-fitted.test.ts` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** → PASS.

### Task 3: Schema, migration 0019, `computeHolds` loader

**Files:**
- Modify: `packages/db/src/schema.ts` (`replenishmentProposals`: `holdReason: text('hold_reason', { enum: ['not_fitted', 'low_yield'] })`, `holdDetail: text('hold_detail')`, both nullable)
- Create: `packages/db/drizzle/0019_proposal_hold.sql` via `pnpm --filter @mps/db generate` (rename to `0019_proposal_hold.sql` + journal tag if drizzle names it otherwise)
- Modify: `packages/db/src/queries/toner-yield.ts` (export `loadInputs` as `loadYieldInputs`, unchanged behaviour)
- Create: `packages/db/src/queries/not-fitted.ts`, `packages/db/src/queries/not-fitted.test.ts`; export from `packages/db/src/queries/index.ts`

**Interfaces:**
- Consumes: `decideHold`, `HoldDecision` (Task 2); `meterPointsFor`, `computeColourYield`-style arithmetic / `meterAt`, `isStale` (Task 1, toner-yield).
- Produces:
  ```ts
  export interface HoldCandidate { id: number; drmsEquipmentId: string; colour: 'black' | 'cyan' | 'magenta' | 'yellow' }
  export async function computeHolds(db: Db, candidates: HoldCandidate[], now: Date): Promise<Map<number, HoldDecision | null>>
  ```
  Every candidate id appears in the map.
- Loading (one query each, only for candidate devices): `loadYieldInputs` (devices, link, family rated yields, merged DRMS+Vantage snapshots); last-order lines per linked equipment + colour with `order_date`, reference, quantity (same filters as `loadInputs` deliveries) → group by London order day, newest day wins, N summed, anchor = orderDate = that day's order_date, reference = first; level readings `BlackTonerLevel|CyanTonerLevel|MagentaTonerLevel|YellowTonerLevel` from `counter_snapshots`/`counter_values` (`received_time` not null). pagesSince = latest meter point − `meterAt(points, orderDate)` when latest is after orderDate and not negative (same rule as Task 1 `computeColourYield`); metersStale = `isStale(latest meter point at, now)`. Unlinked device → null.
- Test against the repo's existing DB test harness (see how `toner-yield.test.ts` / `site-stock.test.ts` seed data): one device spanning case → `not_fitted`; one Northwood-like case with Vantage readings either side of the order → `low_yield`; rise after the order date (even with completed_date later) → not held (anchor = order date); unlinked → null.

- [ ] **Step 1:** schema + generate migration; check SQL is two `ADD COLUMN`s only.
- [ ] **Step 2:** failing tests for `computeHolds`.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `pnpm vitest run packages/db/src/queries/not-fitted.test.ts packages/db/src/queries/toner-yield.test.ts` → PASS.

### Task 4: Apply holds in `runReplenishEvaluate`

**Files:**
- Modify: `apps/worker/src/jobs/replenish-evaluate.ts`
- Test: `apps/worker/src/jobs/replenish-evaluate.test.ts`

**Interfaces:**
- Consumes: `computeHolds` (Task 3).
- At the end of the run (after `evaluateSpareBlack`, so its new covers count), select every proposal with `status = 'pending'`, `shelf_id is null`, `trigger in ('threshold','alarm')`, `colour <> 'waste'`, `id not in (select proposal_id from cartridge_changes where proposal_id is not null)`. Proposals outside that set that carry a hold get it cleared (both columns null). For the set, `computeHolds`, then write only changed rows (`hold_reason`, `hold_detail`), guarded by `status = 'pending'`. Stats: `held` (rows now held), `holdSet`, `holdCleared`.
- No other behaviour changes; supersede rules still apply to held rows.

- [ ] **Step 1:** failing tests: not-fitted proposal gets `hold_reason='not_fitted'`; a later run after a rise reading clears it; a held proposal that becomes a `cartridge_changes.proposal_id` cover is cleared; a `spare_used` proposal is never held.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `pnpm vitest run apps/worker/src/jobs/replenish-evaluate.test.ts apps/worker/src/jobs/spare-black.test.ts` → PASS.

### Task 5: Vantage meters 24 months + automatic backfill

**Files:**
- Modify: `apps/worker/src/jobs/vantage-meters.ts`, `apps/worker/src/jobs/vantage-meters.test.ts`; `packages/db/src/queries/toner-yield.ts` comment "last 12 months" → 24.

**Interfaces:**
- `METER_WINDOW_MONTHS = 24`, comment "User rule (2026-11-19): meter readings are kept for the last 24 months."
- `export const BACKFILL_SLACK_DAYS = 45;` A run is full when there is no previous success OR the oldest stored `reading_at` is later than `windowStart + BACKFILL_SLACK_DAYS` days (or the table is empty). Stats gain `full` as today. This pulls months 13–24 once after ship, then goes incremental again.

- [ ] **Step 1:** failing tests: `meterWindowStart(2026-11-20)` = 2024-11-20; full run when oldest stored reading is 2025-11-25 and window start 2024-11-20; incremental when oldest is 2024-11-25.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `pnpm vitest run apps/worker/src/jobs/vantage-meters.test.ts` → PASS.

### Task 6: Queue `on-site` tab (data)

**Files:**
- Modify: `packages/db/src/queries/replenishment.ts`, `packages/db/src/queries/replenishment.test.ts`

**Interfaces:**
- `QueueTab = 'review' | 'on-site' | 'in-progress' | 'ordered' | 'rejected'`.
- `review`: `status = 'pending' and hold_reason is null`. `on-site`: `status = 'pending' and hold_reason is not null`, sorted like review (`byUrgency`).
- `QueueProposal` gains `holdReason: 'not_fitted' | 'low_yield' | null; holdDetail: string | null`.
- `ReplenishmentStats`: `awaitingReviewDevices`/`awaitingReviewProposals` exclude held; new `onSiteDevices: number`.
- Approve/reject actions unchanged (they act on pending ids); approving a held proposal sets status approved so it leaves `on-site`. Test that (Review Focus 4) with `approveProposals`.

- [ ] **Step 1:** failing tests (held row only in on-site; stats counts; approve from on-site). **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `pnpm vitest run packages/db/src/queries/replenishment.test.ts packages/db/src/queries/queries.test.ts` → PASS.

### Task 7: Review panel uses the shared meter series

**Files:**
- Modify: `packages/db/src/queries/review-detail.ts`, `packages/db/src/queries/review-detail.test.ts`

**Interfaces:**
- `PagesSince` `'pages'` variant gains `estimated: boolean`. `'no-reading'` stays for "no meter at order time".
- Series per toner colour: `loadYieldInputs` snapshots for the device (DRMS + Vantage merged) → `meterPointsFor(colour, isColour, snaps)`, plus the alarm page-count points from `meterPoints` (alarm values mapped the same way: C/M/Y = colour count; black = total on colour and mono). Then `meterAt(points, orderDate)` and latest point; negative → `meter-reset`; base null → `no-reading`.
- `pagesSinceOrder` signature becomes `pagesSinceOrder(points, orderDate)` using `meterAt` (drop the 45-day window param; interpolation window covers it). Remove `PAGES_SINCE_WINDOW_DAYS` if unused.
- Test: Northwood-shaped data (Vantage readings 27 Mar / 26 Apr, order 2 Apr, DRMS latest 42,251) → `{ kind: 'pages', estimated: true, pages: 42,251 − interpolated }`, same number as `getDeviceYield(...).colours.magenta.pagesSinceLastOrder`.

- [ ] **Step 1:** failing test. **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `pnpm vitest run packages/db/src/queries/review-detail.test.ts` → PASS.

### Task 8: UI — tab, hold reason, "~" (Opus)

**Files:**
- Modify: `apps/web/src/app/(app)/orders/page.tsx`, `apps/web/src/components/replenishment-queue.tsx`, `apps/web/src/components/review-row.ts` (+ test), `apps/web/src/components/review-detail-panel.tsx`, `apps/web/src/components/toner-yield.ts` (+ test) / `yield-note.tsx` / `toner-yield-card.tsx` where "pages since" text is built.

**Interfaces:**
- Consumes: Task 6 (`'on-site'` tab, `holdReason`, `holdDetail`, `onSiteDevices`), Task 7 (`estimated`), Task 1 (`pagesSinceEstimated`).
- Tabs: Review, **Probably on site** (count `onSiteDevices`), In progress, Ordered, Rejected. `TABS` includes `'on-site'`.
- On-site rows render like Review rows (same approve/reject controls and detail panel) with each held proposal's `holdDetail` shown under it as a muted note. Empty state: "Nothing held — every pending order shows a fitted cartridge or enough pages since the last one."
- `pagesSinceText` and the yield line prefix the number with "~" when estimated ("~8,220 pages since 2 Apr 2026").

- [ ] **Step 1:** failing unit tests in `review-row.test.ts` / `toner-yield.test.ts` for the "~" text. **Step 2:** FAIL. **Step 3:** implement UI. **Step 4:** `pnpm vitest run apps/web` → PASS; `pnpm -r exec tsc --noEmit` clean; `pnpm --filter web build` (or repo lint) clean.

### Task 9: Live verification (controller)

- [ ] Apply migration 0019 to the dev DB (`scripts/mps.ps1` migrate path, as before), run replenish-evaluate once, and report counts held `not_fitted` / `low_yield` vs the 2026-11-19 baseline (59 / 114 groups), and confirm Northwood C450i magenta is `low_yield` with detail text. Do not trigger the Vantage meters backfill against production without the user's OK if the run would exceed normal API usage; otherwise run it and re-evaluate.
