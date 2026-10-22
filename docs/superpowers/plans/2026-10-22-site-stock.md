# MPS Brain Sub-project 4 — Site Stock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count DRMS Toner Empty / Waste Full alarms against per-site spare-toner shelves and, when a colour's last spare is used, put one top-up proposal for the whole shelf in the existing review queue.

**Architecture:** A shelf is (Vantage customer = site) × (cartridge family); its devices are **derived** in SQL from `device_links → vantage_equipment.vantage_customer_id` and `drms_equipment.model_name ∈ cartridge_family_models`. Pure rules in `@mps/core` (`site-stock.ts`) decide which alarms are uses, whether a use counts, and what a top-up contains. `evaluateSiteStock` runs at the start of `replenish-evaluate`, writes `site_stock_events`, bumps `used_*`, inserts top-up rows into `replenishment_proposals` (with `shelf_id`, trigger `site_stock`), and returns the consumables each device has covered so the normal engine suppresses them. Approval reuses `approveProposals` (one order on the triggering device) and additionally subtracts approved quantities from the shelf.

**Tech Stack:** Existing monorepo — TypeScript/ESM, Drizzle + Postgres (PGlite in tests), pg-boss, Next.js 16 App Router + React 19 + Tailwind v4 + shadcn/ui, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-site-stock-design.md` (read it first; it builds on `2026-09-21-replenishment-design.md`). Mockup: `.superpowers/brainstorm/site-stock-mockup.html`.

## Global Constraints

- Worktree `C:\dev\mps-brain-replenishment`, branch **`feat/site-stock`** (off `feat/foundation-web` @ 11aaf4e). Windows 10, Node 24, Git Bash.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Stage explicit paths only. Commit per task; **push only when the user says**.
- Never read or print `.env` or `F:\dev\API Docs Etc\API Keys.txt`. **No customer names or ids in git** (seed shelves through the app's CSV import, not a migration).
- Stop the dev worker before editing `apps/worker`.
- Nothing here calls Vantage or DRMS. Approved top-ups go through the existing kill-switched path (`VANTAGE_ORDERS_ENABLED` stays false).
- Consumables: `black, cyan, magenta, yellow, waste` (`REPLENISH_COLOURS`). Mono families: black + waste only.
- Constants (in `packages/core/src/site-stock.ts`): `FRESH_CARTRIDGE_LEVEL = 80`, `RECOUNT_DAYS = 14`, `MAX_HOLDING = 20`.
- Holdings are integers **0–20**; `used_*` integers ≥ 0. Approved quantity 1–20 (existing `MAX_ORDER_QUANTITY`).
- Count alarms **regardless of DRMS `status`**; never count alarms received before the shelf's `counting_from`.
- Tests: Vitest; `createTestDb()` (PGlite) for anything touching the DB; no live APIs; no DOM tests. Run `npx vitest run <paths>`, then `npm run typecheck` and `npm run lint` before every commit.
- Every server action calls `requireUser()` first; user id from the session. Every write to shelves/families writes one `audit_log` row.
- UI tasks (10–13) use **opus**; reuse `Card`, `PageHeader`, `FilterTabs`, `ToneBadge`, `Breadcrumb`, `ui/*`, `toCsv` and match the mockup.

## Review Focus

1. **DRMS repeats an Empty while no level data exists** (Discovered device, 4 days apart) → counted once, second logged "repeat". (Task 2, Task 7)
2. **A shelf created today with weeks of old Empty alarms in `device_alarms`** → nothing counted, no top-up. (Task 7)
3. **Use counted while a top-up is pending, then the top-up is approved** → used = old used + new − approved, not 0. (Task 6)
4. **CSV row with holding "abc", 25, a negative, or an unknown site/family** → per-row error in preview, nothing applied. (Task 3, Task 5)
5. **Device moves to another site or its model gets no family** → it silently leaves the shelf; its covered consumables return to normal replenishment on the next run. (Task 4, Task 7)

## File Map

```
packages/db/src/schema.ts, drizzle/0009_site_stock.sql          T1 tables, proposal shelf_id, index swap
packages/core/src/site-stock.ts (+test)                           T2 use / count-once / top-up rules
packages/core/src/site-stock-csv.ts (+test)                       T3 CSV parse + row validation
packages/core/src/replenishment.ts (+test)                        T4 'site_stock' suppression
packages/db/src/queries/site-stock.ts (+test)                     T4 membership + reads + export rows
packages/db/src/queries/site-stock-actions.ts (+test)             T5 families, shelves, holdings, import
packages/db/src/queries/replenishment-actions.ts (+test)          T6 approve subtracts, reject-after-fail restores
apps/worker/src/jobs/site-stock-evaluate.ts (+test)               T7 counting + top-ups
apps/worker/src/jobs/replenish-evaluate.ts (+test)                T7 wire in, supersede covered
packages/db/src/queries/replenishment.ts (+test)                  T8 shelf info on queue rows
apps/worker/scripts/derive-cartridge-families.ts, seed-*.ts       T9 family list (user-confirmed)
apps/web/src/app/(app)/settings/cartridge-families/*              T10
apps/web/src/app/(app)/site-stock/** , device page, sidebar       T11
apps/web/src/app/(app)/site-stock/export/route.ts, import/*       T12
apps/web/src/components/replenishment-queue.tsx, review-row.ts    T13
docs/TEST-REPORT-*.md, docs/HANDOFF.md                            T14
```

---

### Task 1: Schema and migration `0009_site_stock`

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0009_site_stock.sql` (via `npm run generate -w @mps/db`, then hand-check)
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Produces tables (Drizzle exports in brackets):
  - `cartridge_families` [`cartridgeFamilies`]: `id serial pk`, `name text not null unique`, `is_colour boolean not null`, `rated_yield_black|cyan|magenta|yellow|waste integer null` (pages), `notes text`, `updated_by → users`, `updated_at`.
  - `cartridge_family_models` [`cartridgeFamilyModels`]: `model text pk` (exact `drms_equipment.model_name`), `family_id → cartridge_families on delete cascade`.
  - `site_stock_shelves` [`siteStockShelves`]: `id serial pk`, `vantage_customer_id integer not null`, `family_id → cartridge_families` (restrict), `holding_black..waste integer not null default 0` check 0–20, `used_black..waste integer not null default 0` check ≥ 0, `counting_from ts not null`, `created_by`, `created_at`, `updated_by`, `updated_at`; unique `(vantage_customer_id, family_id)`.
  - `site_stock_events` [`siteStockEvents`]: `id bigserial pk`, `shelf_id → site_stock_shelves on delete cascade`, `alarm_id text not null`, `drms_equipment_id → drms_equipment`, `colour text` (ReplenishColour), `received_at ts not null`, `counted boolean not null`, `reason text not null`, `created_at`; unique `(shelf_id, alarm_id)`.
  - `replenishment_proposals.shelf_id integer null → site_stock_shelves`; `ProposalTrigger` gains `'site_stock'` (text enum, TS only).
  - Index swap: `replenishment_proposals_live_uq` becomes `on (drms_equipment_id, colour) where status in ('pending','approved') and shelf_id is null`; new `replenishment_proposals_shelf_live_uq on (shelf_id, colour) where status in ('pending','approved') and shelf_id is not null`.
- Types: `export type ShelfConsumableCounts = Record<ReplenishColour, number>`.

- [ ] **Step 1: Write failing tests** in `schema.test.ts`: `site_stock_shelves rejects holding 21 and -1`; `site_stock_shelves is unique per customer + family`; `a shelf top-up and a normal proposal can both be live for the same device + colour` (insert one with `shelf_id`, one without, both `pending` → both succeed; a second shelf row for the same shelf + colour → unique violation).
- [ ] **Step 2: Run** `npx vitest run packages/db/src/schema.test.ts` — Expected: FAIL (tables missing).
- [ ] **Step 3: Implement** the schema, generate `0009_site_stock.sql`, check the SQL drops and recreates the live index with the new `where`.
- [ ] **Step 4: Run** the test — Expected: PASS. Then `npx vitest run packages/db` — all green (existing replenishment tests must not change).
- [ ] **Step 5: Commit** `feat(db): site stock tables and shelf-aware proposal index`.

### Task 2: Pure rules — `packages/core/src/site-stock.ts`

**Files:** Create `packages/core/src/site-stock.ts`, `site-stock.test.ts`; export from `packages/core/src/index.ts`.

**Interfaces:**
- Produces:
  - `FRESH_CARTRIDGE_LEVEL = 80`, `RECOUNT_DAYS = 14`, `MAX_HOLDING = 20`.
  - `siteStockUse(description: string | null): ReplenishColour | null` — `Toner Empty(BK|K|C|M|Y)` (case-insensitive, **not** preceded by "Near") → colour; `Waste Toner Bottle Full` (not "Almost Full") → `'waste'`; anything else → null.
  - `interface PriorUse { receivedAt: Date }`, `interface LevelPoint { at: Date; value: number }`.
  - `countUse(args: { colour: ReplenishColour; receivedAt: Date; countingFrom: Date; previous: PriorUse | null; levelsSincePrevious: LevelPoint[] }): { counted: boolean; reason: 'before_counting_start' | 'first' | 'fresh_cartridge' | 'after_recount_days' | 'repeat' }`.
    Rule: before `countingFrom` → not counted. No previous → `first`. Colour not waste and any level ≥ 80 strictly after `previous.receivedAt` → `fresh_cartridge`. Else if `receivedAt − previous ≥ 14 days` → `after_recount_days` **only when** waste or there were **no** level points at all; otherwise `repeat`.
  - `topUpLines(holding: ShelfConsumableCounts, used: ShelfConsumableCounts): { colour: ReplenishColour; quantity: number }[]` — `[]` unless some colour has `holding > 0 && used >= holding`; then every colour with `holding > 0 && used > 0`, `quantity = min(used, 20)`, in K, C, M, Y, waste order.
  - `ShelfConsumableCounts` lives here (re-exported by `@mps/db` schema types if needed).

- [ ] **Step 1: Failing tests:**
  - `siteStockUse`: `'Toner Empty(BK)'→black`, `'Toner Empty(K)'→black`, `'Toner Empty(M)'→magenta`, `'Toner Near Empty(K)'→null`, `'Toner Delivery(BK)'→null`, `'Waste Toner Bottle Full'→waste`, `'Waste Toner Bottle Almost Full'→null`, `null→null`.
  - `countUse`: first use counts; repeat 4 days later with no levels → `repeat`; repeat 4 days later with a 92% reading between → `fresh_cartridge`; 15 days later with no levels → `after_recount_days`; 15 days later with levels all < 80 → `repeat`; waste 15 days later → `after_recount_days`; alarm before `countingFrom` → `before_counting_start`.
  - `topUpLines`: user's example `holding {K3,C2,M2,Y2,W0}`, `used {K3,C1,M0,Y1,W0}` → `[K×3, C×1, Y×1]`; same with `K2` → `[]`; holding 0 colour with used 5 → ignored; used 25 on holding 20 → quantity 20; mono shelf (CMY holding 0) works.
- [ ] **Step 2: Run** `npx vitest run packages/core/src/site-stock.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(core): site stock use, count-once and top-up rules`.

### Task 3: CSV parse and validate — `packages/core/src/site-stock-csv.ts`

**Files:** Create `packages/core/src/site-stock-csv.ts` + test; export from index.

**Interfaces:**
- Produces:
  - `SITE_STOCK_CSV_HEADERS = ['vantage_customer_id','site_name','customer_reference','postcode','family','machines','hold_black','hold_cyan','hold_magenta','hold_yellow','hold_waste','used_black','used_cyan','used_magenta','used_yellow','used_waste'] as const` (export uses it too).
  - `parseCsv(text: string): string[][]` — RFC 4180: quoted fields, doubled quotes, CRLF/LF, leading BOM stripped, a leading `'` added by `toCsv` stripped from text fields, trailing blank lines dropped.
  - `interface ImportRow { line: number; vantageCustomerId: number; family: string; holding: ShelfConsumableCounts; used: ShelfConsumableCounts }`.
  - `validateImport(rows: string[][]): { rows: ImportRow[]; errors: { line: number; message: string }[] }` — header row required (order-insensitive, by name; extra columns ignored; missing required `vantage_customer_id`, `family` or any `hold_*` → one file-level error, line 1). Blank `hold_*`/`used_*` = 0; non-integer, < 0, or `hold_*` > 20 → row error naming the column. Duplicate (customer, family) → error on the second line.

- [ ] **Step 1: Failing tests:** round-trip a `toCsv`-style string with BOM, quoted comma, `'=x`; `hold_black=abc` → error "hold_black must be a whole number"; `hold_cyan=25` → "0 to 20"; `-1` → error; blank → 0; missing `family` column → file error; duplicate row → error on its line; columns in a different order still parse.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(core): site stock CSV parsing and validation`.

### Task 4: Shelf membership, reads, and engine suppression

**Files:**
- Modify: `packages/core/src/replenishment.ts` (+test)
- Create: `packages/db/src/queries/site-stock.ts` (+test); export from `queries/index.ts`.

**Interfaces:**
- Consumes: T1 tables, T2 `ShelfConsumableCounts`.
- Produces:
  - `DeviceReplenishInput.siteStockCovered?: ReplenishColour[]`; `SuppressReason` gains `'site_stock'`. In `evaluateDevice`, a covered channel that would trigger is pushed to `suppressed` with `'site_stock'` and never proposed — checked **before** the other suppressions. `auto_off` / `unlinked` behaviour unchanged.
  - `shelfDevicesSubquery(db)` — one row per monitored device on a shelf: `{ shelfId, drmsId, vantageEquipmentId, vantageCustomerId, familyId }` (active link, `status in (REGISTERED, DISCOVERED)`, `missing_since is null`, model in `cartridge_family_models`).
  - `interface ShelfSummary { id; vantageCustomerId; siteName: string; customerReference: string | null; postcode: string | null; headOfficeName: string | null; familyId; familyName; isColour: boolean; machines: number; holding: ShelfConsumableCounts; used: ShelfConsumableCounts; liveTopUp: boolean; autoOffDevices: number }` — site name/town/postcode from `vantage_customers` (`name`, `raw->>'PostCode'`, head office via `raw->>'HeadOfficeId'`).
  - `listShelves(db, args: { search?: string }): Promise<ShelfSummary[]>` (search over site name, reference, postcode, family; sorted: live top-up first, then site name).
  - `getShelf(db, id): Promise<(ShelfSummary & { devices: { drmsId; displayName; model; serial }[]; events: { at; drmsId; displayName; colour; counted; reason }[] }) | null>` (events newest first, last 100).
  - `listShelfForDevice(db, drmsId): Promise<{ shelfId; siteName; familyName } | null>`.
  - `listFamilies(db): Promise<{ id; name; isColour; models: string[]; ratedYield: Partial<Record<ReplenishColour, number>>; notes; shelves: number }[]>`.
  - `listUnmappedModels(db): Promise<{ model: string; devices: number }[]>` — monitored, linked devices whose `model_name` has no family.
  - `listSiteStockExportRows(db): Promise<(string|number|null)[][]>` — one row per (site, family) present in the fleet (linked monitored devices with a family), shelf values or zeros, in `SITE_STOCK_CSV_HEADERS` order.

- [ ] **Step 1: Failing tests:**
  - core: `a covered black below threshold is suppressed as site_stock`; `uncovered waste on the same device still proposes`; `covered + auto_off → skipped auto_off` (unchanged).
  - db (PGlite, extend `seedDemoFixture` data inline): two linked devices at one customer with models in one family → one shelf, 2 machines; same customer, model in another family → separate shelf; device unlinked → not a member; device whose model has no family → appears in `listUnmappedModels`; export lists a (site, family) with no shelf as zeros.
- [ ] **Step 2: Run** `npx vitest run packages/core/src/replenishment.test.ts packages/db/src/queries/site-stock.test.ts` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(db): shelf membership and site stock reads; engine site_stock suppression`.

### Task 5: Site stock writes — `packages/db/src/queries/site-stock-actions.ts`

**Files:** Create `site-stock-actions.ts` (+test); export from index.

**Interfaces:**
- Consumes: T1, T3 `ImportRow`/`validateImport`, T4 reads.
- Produces (all transactional, one `audit_log` row each, guarded, `SiteStockError(message, code)` with codes `'not_found' | 'bad_value' | 'duplicate' | 'in_use' | 'empty'`):
  - `saveFamily(db, { id?: number; name: string; isColour: boolean; models: string[]; ratedYield: Partial<Record<ReplenishColour, number|null>>; notes?: string; userId })`: upsert; a model already in another family → `duplicate`.
  - `deleteFamily(db, { id, userId })` — `in_use` when any shelf references it.
  - `createShelf(db, { vantageCustomerId; familyId; holding; used?; userId; now? }) → { shelfId }` — `counting_from = now`.
  - `updateShelf(db, { shelfId; holding?: Partial<ShelfConsumableCounts>; used?: Partial<ShelfConsumableCounts>; userId })` — `used` here is the audited manual correction.
  - `deleteShelf(db, { shelfId, userId })` — supersedes its pending top-up rows (note `shelf deleted`).
  - `previewImport(db, rows: ImportRow[]) → { line; vantageCustomerId; siteName; family; action: 'create'|'update'|'unchanged'|'error'; message? ; changes: string[] }[]` — unknown customer id or family name → `error`. Create only when any holding > 0.
  - `applyImport(db, { rows: ImportRow[]; userId; now? }) → { created; updated; unchanged }` — re-runs the preview inside the transaction; any `error` → throws, nothing written. Update writes **holdings only**; create also takes `used_*`.
  - `resetAutoReplenishForShelf(db, { shelfId, userId })` — sets `auto_replenish = null` on device-scope settings of the shelf's devices that have it `false` (reuse `updateDeviceSettings`).

- [ ] **Step 1: Failing tests:** each function's happy path + audit row; holding 21 → `bad_value`; import with one bad line applies nothing; import update ignores `used_*`; import create keeps `used_*`; deleting a family with shelves → `in_use`; `deleteShelf` supersedes its pending top-up.
- [ ] **Step 2–4:** run `npx vitest run packages/db/src/queries/site-stock-actions.test.ts` — FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(db): site stock and cartridge family writes, CSV import`.

### Task 6: Approval subtracts, rejection-after-failure restores

**Files:** Modify `packages/db/src/queries/replenishment-actions.ts` (+test).

**Interfaces:**
- Consumes: T1 `shelf_id`.
- Changes:
  - `approveProposals`: inside its transaction, for each approved item whose proposal has `shelf_id`, `used_<colour> = greatest(used_<colour> − quantity, 0)` on that shelf; audit `details` gains `shelfAdjust: { shelfId, colour, by }[]`.
  - `rejectProposals`: for rejected rows that were `failed` and have `shelf_id`, `used_<colour> += quantity` (restore); rejecting a `pending` top-up changes nothing on the shelf.

- [ ] **Step 1: Failing tests:** `approving a top-up subtracts approved quantities` (used K3,C2 with a C use counted after the proposal → approve K3,C1 → used K0,C1); `approving a smaller quantity leaves the remainder`; `rejecting a pending top-up leaves counts`; `rejecting a failed top-up restores counts`; existing approve/reject tests unchanged.
- [ ] **Step 2–4:** `npx vitest run packages/db/src/queries/replenishment-actions.test.ts packages/db/src/queries/replenishment.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(orders): site stock top-ups adjust shelf counts on approve and reject`.

### Task 7: Worker — count uses, raise top-ups, suppress covered channels

**Files:** Create `apps/worker/src/jobs/site-stock-evaluate.ts` (+test); modify `apps/worker/src/jobs/replenish-evaluate.ts` (+test).

**Interfaces:**
- Consumes: T2 rules, T4 `shelfDevicesSubquery`, T1 tables, `TONER_NAMES`, `counterSnapshots/counterValues`.
- Produces: `evaluateSiteStock(db: Db, now: Date): Promise<{ covered: Map<string, Set<ReplenishColour>>; stats: { shelves; considered; counted; topUps } }>`.
  1. Load shelves + member devices. `covered[drmsId]` = colours with holding > 0 on its shelf (CMY only if family `is_colour`).
  2. Load alarms for member devices with `received_time >= min(counting_from)` and `alarm_id` not already in `site_stock_events` for that shelf; classify with `siteStockUse`; ignore nulls and colours with holding 0.
  3. Oldest first: previous counted use for (device, colour) from `site_stock_events`; level points from `counter_values` (`TONER_NAMES[colour]`) for that device after the previous use; `countUse`; insert event (counted or not, `reason`); counted → `used_<colour> += 1` (same transaction per alarm).
  4. Per shelf with no live top-up (`pending|approved` with that `shelf_id`): `topUpLines`; non-empty → insert proposals (`trigger 'site_stock'`, `shelf_id`, `drms_equipment_id` = device of the newest counted use that crossed the trigger, `vantage_equipment_id` from its link, `quantity`, `alarm_id`/`alarm_description` of that use, `status pending`), `onConflictDoNothing`.
- `runReplenishEvaluate` calls `evaluateSiteStock` **first**; passes `siteStockCovered: [...covered.get(d.drmsId) ?? []]` to `evaluateDevice`; supersedes pending **non-shelf** proposals for covered colours (note `covered by site stock`); the device loop never touches shelf rows (`shelf_id is null` filter on `proposalRows`). Stats gain `siteStock`.

- [ ] **Step 1: Failing tests** (PGlite, fixed `now`):
  - user's example end to end: shelf K3,C2,M2,Y2; Empty(BK)×3 on two devices on different days + Empty(C) + Empty(Y) with ≥ 80% readings between blacks → one top-up K3,C1,Y1 on the device of the third black.
  - repeat Empty(BK) 4 days apart, no readings → one counted, one `repeat`.
  - alarm before `counting_from` → no event counted, no top-up.
  - Empty with DRMS status `NoAlarmFilterHierarchyFound` counts.
  - second run is idempotent (no new events, no second top-up).
  - a further use while a top-up is pending bumps `used` but makes no second top-up.
  - replenish-evaluate: a pending threshold proposal for a covered black is superseded `covered by site stock`; low waste with holding 0 still proposes normally; device moved off the shelf (link to another customer) gets normal proposals again.
- [ ] **Step 2: Run** `npx vitest run apps/worker/src/jobs/site-stock-evaluate.test.ts apps/worker/src/jobs/replenish-evaluate.test.ts` — FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS, plus `npx vitest run apps/worker`.
- [ ] **Step 5: Commit** `feat(worker): count site stock uses and propose shelf top-ups`.

### Task 8: Queue rows know their shelf

**Files:** Modify `packages/db/src/queries/replenishment.ts` (+test).

**Interfaces:**
- `QueueProposal.shelfId: number | null`; `QueueDevice.shelf: { id: number; siteName: string; familyName: string; machines: number } | null` (set when any of its proposals has `shelf_id`). `listDeviceReplenishment` unchanged apart from `shelfId`.
- [ ] **Step 1: Failing test:** review tab returns a top-up device with `shelf` filled and its proposals' `shelfId`; a normal device has `shelf: null`.
- [ ] **Step 2–4:** run `npx vitest run packages/db/src/queries/replenishment.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(db): shelf details on review queue rows`.

### Task 9: Cartridge family list — derive, user confirms, seed

**Files:** Create `apps/worker/scripts/derive-cartridge-families.ts` (+test for its pure grouping fn), `apps/worker/scripts/seed-cartridge-families.ts`, `apps/worker/scripts/cartridge-families.json` (after user confirms).

**Interfaces:**
- `groupModelsByPart(lines: { details: string; partNumber: string | null }[], models: string[]): { part: string; models: string[] }[]` — a model joins a part when its number (e.g. `450i`, `C300i`) appears in that part's line text; merge parts that share models into one family.
- `derive-…ts` (read-only): reads `vantage_sales_order_lines` + distinct `drms_equipment.model_name` of linked devices, prints proposed families and unmapped models as CSV to stdout.
- `cartridge-families.json`: `[{ "name": "...", "isColour": true, "models": ["bizhub C450i", ...] }]` — model names only, no customer data.
- `seed-…ts [--apply]`: dry-run by default; inserts missing families/models via `saveFamily` (userId null); never edits existing.
- [ ] **Step 1: Failing test** for `groupModelsByPart` with ACV1150 lines naming 450i/451i/550i/650i and AAV8150 naming C250i/C300i/C360i.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: USER STEP.** Ask the user to run `! cd C:\dev\mps-brain-replenishment\apps\worker && npx tsx --env-file=../../.env scripts/derive-cartridge-families.ts` (auto-mode blocks Claude running scripts against the real DB). Show them the families; they confirm or correct, including whether ineo+ joins bizhub. Write `cartridge-families.json`.
- [ ] **Step 6: Commit** `feat(worker): derive and seed cartridge families`. Seeding (`--apply`) is run by the user at Task 14.

### Task 10 (opus): Cartridge families settings page

**Files:** Create `apps/web/src/app/(app)/settings/cartridge-families/page.tsx`, `actions.ts`; add a tab/link beside `/settings/replenishment`.
- Table of families: name, colour/mono, models (chips), rated yield per consumable (optional numbers), shelves count; add / edit dialog (name, mono/colour, models multi-input with suggestions from `listUnmappedModels`, yields, notes); delete (disabled when in use). "Models with no family" card listing `listUnmappedModels`.
- Actions wrap T5 `saveFamily` / `deleteFamily`; errors shown via `?error=<code>` like `/orders`.
- [ ] Implement; `npm run typecheck`, `npm run lint`, `npm run build -w @mps/web` pass; manual check on :3000 with seeded families.
- [ ] Commit `feat(web): cartridge families settings`.

### Task 11 (opus): Site stock list, shelf page, device badge, sidebar

**Files:** Create `apps/web/src/app/(app)/site-stock/page.tsx`, `site-stock/[id]/page.tsx`, `site-stock/actions.ts`, `apps/web/src/components/shelf-pills.tsx` (+ pure helper `shelf.ts` + test for pill state: `used >= holding && holding > 0` → `full`); modify `app-sidebar.tsx` (item "Site stock", icon `Boxes`, between Toner orders and Needs reconnecting), device page (`devices/[id]/page.tsx`) badge "Site stock: <site> · <family>" linking to the shelf, and `replenishment-card.tsx` note "Normal proposals off for <colours> — on a site stock shelf".
- List = mockup screen 1 (search, used/held pills with red ring when full, status *Holding* / *Top-up proposed*, **+ New shelf** dialog: site search via existing customer search, family select). Export / Import buttons link to Task 12.
- Shelf page = mockup screen 2: holdings steppers 0–20 + Save; used counts with "Correct counts" (confirm dialog, audited); machines (derived); events log (counted / not counted with reason in plain words: `repeat` → "repeat, not counted", `before_counting_start` → "before this shelf existed"); banner when devices have auto-replenish off with **Switch back to inherited** (T5 `resetAutoReplenishForShelf`); delete shelf.
- [ ] Unit test `shelf.ts`; typecheck, lint, build; manual check.
- [ ] Commit `feat(web): site stock list and shelf page`.

### Task 12 (opus): CSV export and import

**Files:** Create `apps/web/src/app/(app)/site-stock/export/route.ts`, `site-stock/import/page.tsx`, `site-stock/import/actions.ts`.
- Export: `GET` → `requireUser()`; `toCsv([...SITE_STOCK_CSV_HEADERS], await listSiteStockExportRows(db))`; filename `site-stock-YYYY-MM-DD.csv` (Europe/London date).
- Import: file input (`.csv`, ≤ 1 MB) → server action parses with `parseCsv` + `validateImport` → `previewImport` → preview table (create / update / unchanged / error, changes listed) held in a hidden field as the validated JSON rows → **Apply** (disabled if any error) calls `applyImport`; redirect to `/site-stock` with a result banner.
- [ ] typecheck, lint, build; manual round-trip: export → edit two holdings in Excel → import preview shows exactly those → apply.
- [ ] Commit `feat(web): site stock CSV export and import`.

### Task 13 (opus): Review queue site row

**Files:** Modify `apps/web/src/components/replenishment-queue.tsx`, `review-row.ts` (+test), `replenishment.ts` (`triggerLabel` for `site_stock`: "Last <colour> spare went in <date> (<device>)").
- A device with `shelf` renders mockup screen 3: heading = site name + "Site stock" badge + "<n> machines · <family>", chips per line (K × 3 …), why text, existing stepper/approve/reject. Mixed rows (top-up + normal proposals on one device) show both groups under one heading.
- [ ] Test `triggerLabel` and chips for a top-up; typecheck, lint, build; manual check with a seeded top-up.
- [ ] Commit `feat(web): site stock top-ups in the review queue`.

### Task 14: Test pass, seed with the user, docs

- [ ] Full `npm test`, `npm run typecheck`, `npm run lint`, `npm run build -w @mps/web` — all green; record counts.
- [ ] **USER STEPS:** user runs `seed-cartridge-families.ts --apply`; restarts the branch worker (it migrates 0009 on boot); signs in; on `/site-stock` exports, fills **Christ the King Primary** (C551i family: 1 each K C M Y + 1 waste) and **Priorsfield School** (ineo+ 360i and 450i families: 2 each K C M Y), imports; enters Howden / Hewetts shelves as they know them; offers to switch auto-replenish back on those devices.
- [ ] Run jobs `drms-alarms` then `replenish-evaluate` (via `/admin/jobs` Run all); sanity SQL: no counted events before `counting_from`; `used_*` = counted events − approved quantities per shelf; no live normal proposal on a covered colour.
- [ ] Write `docs/TEST-REPORT-<date>-site-stock.md`; update `docs/HANDOFF.md` and the spec status line.
- [ ] Commit `docs: site stock test report and handoff`.
