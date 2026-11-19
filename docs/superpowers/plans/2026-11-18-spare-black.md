# Spare Black on Site + Cartridge-Change Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propose "spare used: send 1 black" when a machine's black cartridge is changed (Empty alarm or level rise), and let shelves count level rises as uses.

**Architecture:** One pure detector in `@mps/core` turns a level series + Empty alarms into cartridge changes. The replenish-evaluate job runs a new spare-black step that records each change once in `cartridge_changes` with an outcome (proposed / covered / ineligible). The site-stock evaluator feeds the same detector's level rises into shelf uses. A new inherited setting `spare_black` (default on) gates it.

**Tech Stack:** TypeScript, Drizzle + Postgres, BullMQ worker, Next.js app router, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-spare-black-design.md` (approved 2026-11-18).

## Global Constraints

- Read-only towards Vantage (GET only). The app only creates proposals in its own DB.
- **No git commits** during execution; commit only with the user's OK. Checkpoint = tests + typecheck.
- Constants: `LOW_LEVEL = 15`, `RISE_LEVEL = 50` (new, `@mps/core`); `FRESH_CARTRIDGE_LEVEL = 80` unchanged.
- A change = Toner Empty alarm (any DRMS status, `siteStockUse` match) or a reading >= 50 after a reading <= 15 in the same cartridge. Empty then rise = one change.
- Each change decided once: outcome `proposed` | `covered` | `ineligible`; never retried; a rejected spare_used proposal is final.
- Guard: `covered` when any black proposal (pending/approved/ordered, any trigger) created on/after cartridge start, or a Vantage black line (`colour='black'`, order not deleted, line not returned) with `order_date` on/after cartridge start. No 14-day/7-day suppressions for spare_used.
- Counting start per device = later of `replenishment_settings.spare_black_from` (default row, set by migration to `now()`) and the current `device_links.linked_at`.
- Eligible = effective `spare_black` on, effective auto-replenish on, linked, not hidden, no shelf covering black. Black only.
- Migration 0017 applied (worker restart `scripts/mps.ps1 restart -Only worker`) before web code uses new columns.

## Review Focus

1. **Machine on a shelf holding black** → no spare_used proposal; change recorded `ineligible` reason `shelf`. Test in Task 3.
2. **Threshold proposal already ordered for this cartridge, then the change** → `covered`, no second proposal. Test in Task 3.
3. **Empty alarm, then the rise on the next reading (two runs)** → exactly one change across both runs. Tests in Tasks 1 and 3.
4. **Level history before counting start** → nothing recorded or proposed on first run. Test in Task 3.
5. **User rejects a spare_used proposal** → next run proposes nothing for that change. Test in Task 3.

---

### Task 1: Pure cartridge-change detector

**Files:** Create `packages/core/src/cartridge-change.ts`, `packages/core/src/cartridge-change.test.ts`; modify `packages/core/src/index.ts` (export).

**Interfaces (produces):**
```ts
export const LOW_LEVEL = 15;
export const RISE_LEVEL = 50;
export interface LevelReading { at: Date; value: number; snapshotId: number }
export interface EmptyEvent { at: Date; alarmId: string }
export type ChangeSource = 'empty_alarm' | 'level';
export interface DetectedChange {
  at: Date; source: ChangeSource; alarmId: string | null;
  lowSnapshotId: number | null; highSnapshotId: number | null; lowLevel: number | null; highLevel: number | null;
}
/** Readings and empties strictly after `since`; `afterEmpty` = the last recorded change was an Empty. Chronological output. */
export function detectChanges(args: { since: Date; afterEmpty: boolean; readings: LevelReading[]; empties: EmptyEvent[] }): DetectedChange[];
```
Algorithm (events merged by time, a reading before an Empty at the same instant): state `low` (first reading <= 15 since the last change) and `pendingEmpty` (starts = `afterEmpty`).
- reading <= 15 → set `low` if unset.
- reading >= 50 → if `pendingEmpty`: clear `pendingEmpty` and `low` (swap absorbed, no output); else if `low`: emit `level` change (low/high ids + values, `at` = high reading), clear `low`.
- Empty → if `pendingEmpty`: ignore (repeat); else emit `empty_alarm` change, set `pendingEmpty`, clear `low`.

- [ ] **Step 1: Failing tests** in `cartridge-change.test.ts`: `low 5 then 92 → one level change at the 92 reading`; `low 10 then 70 → change (late first read)`; `30 then 95 → nothing`; `Empty then 3 then 90 → one empty_alarm change only`; `afterEmpty true, then 90 → nothing`; `two Empties no rise → one change`; `Empty, 95, 8, 88 → two changes (empty_alarm, level)`; `readings at/before since ignored`; `12 then 40 → nothing`.
- [ ] **Step 2:** `npx vitest run packages/core/src/cartridge-change.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement per Interfaces.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck` → exit 0.

### Task 2: Schema, migration 0017, settings plumbing

**Files:** Modify `packages/db/src/schema.ts`, `packages/db/src/queries/settings.ts` (+test), `packages/db/src/queries/index.ts`; create `packages/db/drizzle/0017_spare_black.sql` (drizzle-kit generate, then append the data statements below).

**Interfaces (produces):**
- `replenishment_settings.spare_black boolean` (null = inherit), `replenishment_settings.spare_black_from timestamptz` (used on default row only). Migration: `update replenishment_settings set spare_black = true, spare_black_from = now() where scope = 'default'`.
- `replenishmentProposals.trigger` enum gains `'spare_used'` (TS enum only; column is text, no CHECK).
- `site_stock_events.alarm_id` becomes nullable; add `source text not null default 'empty_alarm'`, `high_snapshot_id integer`, `low_snapshot_id integer`. Unique key for level rows: `(shelf_id, drms_equipment_id, colour, high_snapshot_id)` partial where `source = 'level'`.
- New table `cartridge_changes`: `id serial pk`, `drms_equipment_id text not null` (fk drms_equipment), `colour text not null`, `changed_at timestamptz not null`, `source text not null` ('empty_alarm'|'level'), `alarm_id text`, `low_snapshot_id int`, `high_snapshot_id int`, `low_level double precision`, `high_level double precision`, `outcome text not null` ('proposed'|'covered'|'ineligible'), `reason text`, `proposal_id int` (fk replenishment_proposals), `created_at timestamptz not null default now()`; unique `(drms_equipment_id, colour, source, changed_at)`.
- `effectiveSettingsSubquery` gains `spareBlack` (+`spareBlackSource`) resolved like `autoReplenish`; the settings patch/validate path accepts `spareBlack` as a flag (`keep|inherit|on|off`), same rules as `autoReplenish`.
- Export from `queries/index.ts`: `cartridgeChanges` schema is reachable through `@mps/db` schema exports as for other tables.

- [ ] **Step 1: Failing tests** in `settings.test.ts`: `default spare_black is on after migration`; `customer off overrides default`; `device on overrides customer off`; `patch spareBlack inherit clears device value`.
- [ ] **Step 2:** `npx vitest run packages/db/src/queries/settings.test.ts` → FAIL.
- [ ] **Step 3:** Schema + generate; check the SQL only adds the columns/table/index and the data `update`; implement settings; apply migration (restart worker) and confirm `\d cartridge_changes`.
- [ ] **Step 4:** `npx vitest run packages/db` → PASS (rerun known flaky files alone); typecheck exit 0.

### Task 3: Spare-black step in replenish-evaluate

**Files:** Create `apps/worker/src/jobs/spare-black.ts`, `apps/worker/src/jobs/spare-black.test.ts`; modify `apps/worker/src/jobs/replenish-evaluate.ts` (call it after the device loop; add stats `spareChanges`, `spareProposed`, `spareCovered`, `spareIneligible`).

**Interfaces:**
- Consumes Task 1 `detectChanges`, Task 2 tables/settings.
- Produces `export async function evaluateSpareBlack(db: Db, now: Date): Promise<{ changes: number; proposed: number; covered: number; ineligible: number }>`.
- Per device with a black level reading or Toner Empty(K) alarm after its counting start (Global Constraints): `since` = latest `cartridge_changes.changed_at` for (device, black) or counting start; `afterEmpty` = that row's source is `empty_alarm`. Readings: `BlackTonerLevel` counter values joined to snapshots, `received_time > since`. Empties: `device_alarms` category toner, any status, `siteStockUse(description) === 'black'`, `received_time > since`.
- For each detected change in order, in one transaction per device: decide outcome (ineligible reason `spare_off` | `auto_off` | `unlinked` | `hidden` | `shelf`; else guard → `covered` reason `proposal` | `vantage_order`; else insert proposal `trigger 'spare_used'`, colour black, quantity 1, status pending, `level` = highLevel, `alarmId`/`alarmDescription` from the Empty when source is `empty_alarm`, `vantageEquipmentId` from the link), then insert the `cartridge_changes` row (onConflictDoNothing on its unique key). Cartridge start for the guard = `since`.

- [ ] **Step 1: Failing tests** (DB tests, existing worker test helpers): `low then high after start → one pending spare_used proposal`; `Review Focus 1: shelf holds black → ineligible shelf, no proposal`; `Review Focus 2: approved threshold black proposal created after cartridge start → covered`; `Vantage black line ordered after cartridge start → covered vantage_order`; `Review Focus 3: run 1 sees Empty(K) → proposal; run 2 sees 4 then 90 → no new change`; `Review Focus 4: readings before spare_black_from → nothing recorded`; `Review Focus 5: proposal rejected, rerun → still one change, no new proposal`; `spare_black off at customer → ineligible spare_off`; `device linked after spare_black_from: readings before linked_at ignored`.
- [ ] **Step 2:** `npx vitest run apps/worker/src/jobs/spare-black.test.ts` → FAIL.
- [ ] **Step 3:** Implement; wire into `runReplenishEvaluate`.
- [ ] **Step 4:** `npx vitest run apps/worker` → PASS; typecheck exit 0.

### Task 4: Shelves count level rises

**Files:** Modify `apps/worker/src/jobs/site-stock-evaluate.ts` and its test file.

**Interfaces:** Consumes Task 1 `detectChanges`, Task 2 `site_stock_events` columns. For each shelf member device + toner colour the shelf holds: `since` = latest counted `site_stock_events.received_at` for (shelf, device, colour) or the member's counting start; `afterEmpty` = that row's source is `empty_alarm`; `empties` = this run's and earlier counted shelf Empty events for the device + colour after `since` (Empties still decided by `countUse` exactly as today, first). Each `level` change becomes a `site_stock_events` row `source 'level'`, `counted true`, `reason 'level_rise'`, `received_at` = change `at`, snapshot ids set, and increments the shelf's used count like a counted Empty. Waste unchanged.

- [ ] **Step 1: Failing tests**: `member black 6 → 91, no alarm → one counted level use, shelf used_black +1`; `counted Empty(K) then 5 → 88 → still one use`; `rise recorded in run 1, rerun → no second use`; `next real Empty after a counted rise still counts (fresh_cartridge)`; `waste unaffected`.
- [ ] **Step 2:** `npx vitest run apps/worker/src/jobs/site-stock-evaluate.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run apps/worker` → PASS; typecheck exit 0.

### Task 5: Web — setting toggle and Review queue text

**Files:** Modify `apps/web/src/lib/settings-form.ts` (+test), the replenishment settings page/actions (`apps/web/src/app/(app)/settings/replenishment/`), the device/customer settings dialog (`apps/web/src/components/settings-dialog.tsx`), `apps/web/src/components/replenishment.ts` (+test) and any component switching on `trigger`.

**Interfaces:** Consumes Task 2 `spareBlack` flag. UI label **"Spare black on site"** with help text "When black toner is changed, propose 1 black to replace the spare." Shown wherever Auto-replenish is (default, customer, device), same inherit/on/off control. Review queue line for `trigger 'spare_used'`: `Spare used: black changed <d MMM> (<low>% → <high>%)` when a level change, `Spare used: Toner Empty(K) <d MMM>` when from an alarm.

- [ ] **Step 1: Failing tests**: `settings-form parses spareBlack on/off/inherit/keep`; `replenishment text for spare_used level` → `"Spare used: black changed 12 Nov (3% → 92%)"`; `spare_used from alarm` → `"Spare used: Toner Empty(K) 12 Nov"`.
- [ ] **Step 2:** `npx vitest run apps/web` → FAIL.
- [ ] **Step 3:** Implement (low/high levels come from the linked `cartridge_changes` row; join it in the queue query by `proposal_id`).
- [ ] **Step 4:** `npx vitest run apps/web` → PASS; typecheck; eslint on changed files.

### Task 6: Ship and verify

- [ ] **Step 1:** `npm run typecheck`; `npx vitest run packages apps` → all pass (report counts).
- [ ] **Step 2:** `.\scripts\mps.ps1 build` → worker + web running, :3000 listening.
- [ ] **Step 3:** After one counter pull / replenish-evaluate run, read-only check: `cartridge_changes` rows by outcome, `spare_used` proposals count, shelf `level_rise` events. Expect near zero on day one (counting starts at migration). Do not commit.
