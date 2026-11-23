# PM Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take other-dealer sites out of PM due, add per-machine *When in area* and *Priority* states, and add a `/pm/planner` page with a county → district board (To plan → Asked engineer → Booked → Done) beside each engineer's booked field calls for today/tomorrow with nearby PMs.

**Architecture:** One pure region rule and one dealer resolver (`@mps/core` + `@mps/db`) used by PM due, the planner and Customers. New tables: `pm_plan` (per-machine flags + stored board column), `vantage_engineers`, `vantage_scheduled_units` (intraday), `postcode_districts` (cache). Booked is derived from existing `pm_actions` / Vantage PM jobs, never stored. Three read-only worker jobs feed the planner; the planner page reads only our own database.

**Tech Stack:** TypeScript, Drizzle/Postgres, pg-boss worker (tsx), Next.js 16 app router, Vitest (PGlite via `createTestDb()`).

**Spec:** `docs/superpowers/specs/2026-11-23-pm-planner-design.md` (read "Decided with the user" and "Calls made after builder check": binding). Also `2026-11-17-pm-due-design.md`, `2026-11-18-pm-actions-design.md`.

## Global Constraints

- NO commits during execution — the "Commit" step is replaced by "no commit — orchestrator commits at end"; the user commits once after final review. No git command that changes HEAD/index/branches. Never print `.env` contents or tokens.
- **Never write to Vantage or DRMS.** Read-only Vantage GETs only, `api-version` header always (the client does it), `deleteddate eq null` where applicable (`listWorkUnits` precedent: `includeDeleted: true` and drop units whose `Work.DeletedDate` is set). The only external HTTP besides Vantage is `GET https://api.postcodes.io/outcodes/{district}` (outward code only, no customer data sent); tests MUST mock `fetch`.
- Other-dealer affects **PM only** (PM due, planner). It must not touch toner replenishment, alerts, reconnect, Devices or Fleet overview.
- Migrations: highest existing is `0020_customer_flags.sql` (re-check `ls packages/db/drizzle` at execution; use the next numbers: 0021, 0022, 0023 below). Generate with `cd packages/db && npx drizzle-kit generate --name <change>` after editing `schema.ts`. **A migration (column or table) and the worker restart that applies it (`.\scripts\mps.ps1 stop -Only worker` then `start -Only worker`) must happen BEFORE web code queries it** (web hot-reloads; the worker migrates on boot). Each migration task says so.
- Region rule is ONE function (`regionOf`) and the dealer decision ONE function (`resolveOtherDealer`); never re-express either in SQL or a component.
- Region rule (spec): Ireland = Eircode (routing key letter + 2 digits, or `D6W`, then a 4-character unique id; UK inward codes are 3 characters) or no postcode and county starts `Co.`/`Co `/`County <Irish county>` or contains Dublin; Northern Ireland = postcode area `BT`; Scotland = postcode area in AB, DD, DG, EH, FK, G, HS, IV, KA, KW, KY, ML, PA, PH, TD, ZE (G = `G` followed by a digit). NI and Republic both map to the `ireland` region (MJ Flood); `scotland` (CMYK). Region → dealer names editable in `/settings/pm`.
- Precedence: site manual ("ours" or a dealer) > head-office manual (covers its sites, as `self_managed`) > region rule on the **site's own** address.
- Areas = county, then postcode district (outward code, e.g. `GU14`), then optional user-named patch. County comes from postcodes.io (`admin_county`, else first `admin_district`, cached per district), falling back to Vantage `County`, else "Unknown county".
- Board: **To plan → Asked engineer → Booked → Done**. `pm_plan.board_column` stores only `to_plan` / `asked` / `done`; **Booked is derived** (open `pm_actions` kind `booked`, or the existing "PM booked" detection from a PM-category Vantage job). Done retention 14 days (setting); "Asked" > 7 days shows an "asked N days ago" badge. A card that leaves the due set (dismissed, snoozed, contract ended, other dealer) stays in its column with a reason badge and a Remove button; it never vanishes silently.
- When in area: own tab; not in Due; stays until the flag is cleared; carries an overdue warning ("overdue 18m", red when overdue) wherever shown. Priority: star; sorts first in the default order and in planner groups. Priority machines are put on the board automatically.
- Upcoming jobs: Vantage work units with `ScheduledStartDate` today/tomorrow (Europe/London days), Field category type (all Field types incl. installs), not completed, with engineer; calls with no machine are included; a unit with `WorkStartDate` set shows as "started". "Near" = same postcode district OR within N miles (default 10, setting) of the call's location (customer Latitude/Longitude, else the postcode district centroid). Order: priority, overdue, due soon, when-in-area. Excludes Booked, other-dealer, dismissed machines.
- Defaults: refresh `vantage-schedule` every 30 min 06:00-19:30 (`*/30 6-19 * * *`), `vantage-engineers` nightly 03:15, `postcode-lookup` nightly 03:40; all editable via env.
- Reuse: list-state (`parseListState`, `ListControls`, `SortHeader`, `listHref`), `safeReturnPath` / `deviceHref` (`apps/web/src/lib/device-origin.ts`) and `customerHref` (`components/customers.ts`), `isActiveContract`, the PM computation in `packages/db/src/queries/pm-queries.ts` / `pm-due.ts` (`listPmDue`, `inPmView`, `PmRow`), `TonerBars` is not needed here, `statusLabel` / `statusTone` / `ToneBadge` for the PM status chip, `markPmBooked` + the Mark-booked form.
- Tests: `npx vitest run <path>`; `npm run typecheck`; `npx eslint <files>`. The full suite (~13 min) runs only in Task 8.

## Review Focus

1. Region rule on awkward input: `d04ek2k` (lowercase, no space), `Co. Durham` / `County Durham` (England, not Ireland), `GL1 1AA` and `GU14 7PR` (not Scotland) vs `G1 1AA` (Scotland), `BT1 1AA` (NI), empty postcode + empty county (ours), `B46 1DA`/`W14 9EQ`/`B16 8TP` (UK, not Ireland); Task 1.
2. Head office set to a dealer while one site is manually "ours" → that site stays ours, its siblings follow the head office; a deleted/unknown customer id never throws; Task 1.
3. A priority or when-in-area machine whose customer becomes other-dealer, or whose contract ends, keeps its card with a reason badge and is never auto-deleted; Task 4.
4. postcodes.io 404 / 429 / 500 / network error / garbage body: job ends `partial`, nothing already cached is overwritten, a `not_found` district is not re-asked daily; Upcoming still works by same-district match when no coordinates; Task 3 and Task 4.
5. Call at 23:30Z on 31 Mar (BST) belongs to 1 Apr (London day); a completed unit, a unit with no engineer, and a unit with no machine and no coordinates still render correctly; Task 4.

---

### Task 1: Region rule, dealer resolution, other-dealer flags, planner settings (logic)

**Files:**
- Create: `packages/core/src/region.ts`, `packages/core/src/region.test.ts`
- Create: `packages/db/src/queries/other-dealer.ts` (+ `.test.ts`), `packages/db/src/queries/pm-planner-settings.ts` (+ `.test.ts`)
- Modify: `packages/core/src/index.ts`, `packages/db/src/schema.ts` (`customerFlags`: `otherDealerOverride`, `otherDealerName`), `packages/db/src/queries/index.ts`, `packages/db/src/queries/pm-queries.ts` (`loadMachines`/`PmRow`/`listPmDue`), `packages/db/src/queries/pm-queries.test.ts`, `apps/web/src/app/(app)/pm/filters.test.ts` (fixture helper gets the new `PmRow` fields)
- Create: `packages/db/drizzle/0021_other_dealer.sql` (+ meta via drizzle-kit)

**Interfaces:**
- Produces (`@mps/core`):
  ```ts
  export type DealerRegion = 'ireland' | 'scotland';
  export function postcodeOutward(postCode: string | null | undefined): string | null;   // 'gu14 7pr' | 'GU147PR' | 'GU14' -> 'GU14'; Eircodes and junk -> null
  export function postcodeArea(postCode: string | null | undefined): string | null;       // leading letters of the outward code: 'GU'
  export function isEircode(postCode: string | null | undefined): boolean;
  export function regionOf(a: { postCode: string | null | undefined; county: string | null | undefined }): DealerRegion | null;
  export type OtherDealerOverride = 'dealer' | 'ours';
  export interface OtherDealerFlag { override: OtherDealerOverride | null; name: string | null }
  export interface OtherDealerResolution { dealer: string | null; source: 'site' | 'head_office' | 'region' | null; region: DealerRegion | null }
  export function resolveOtherDealer(a: { own: OtherDealerFlag | null; headOffice: OtherDealerFlag | null; region: DealerRegion | null; regionDealers: Record<DealerRegion, string | null> }): OtherDealerResolution;
  ```
  `'ours'` overrides resolve to `{ dealer: null, source: 'site' | 'head_office' }`; a region with a blank dealer name resolves to `null`.
- Produces (`@mps/db`):
  ```ts
  export interface PmPatch { name: string; districts: string[] }
  export interface PlannerSettings { regionDealers: Record<DealerRegion, string | null>; nearMiles: number; doneRetentionDays: number; askedStaleDays: number; patches: PmPatch[] }
  export const DEFAULT_PLANNER_SETTINGS: PlannerSettings;  // MJ Flood / CMYK, 10, 14, 7, []
  export function getPlannerSettings(db: Db): Promise<PlannerSettings>;           // app_state key 'pm_planner_settings'
  export function savePlannerSettings(db: Db, s: PlannerSettings, userId: number | null): Promise<void>;  // SettingsError('...', 'invalid_planner_setting'); audit 'pm_planner_settings.update'
  export type OtherDealerInfo = OtherDealerResolution;
  export function loadDealerResolver(db: Db): Promise<(vantageCustomerId: number | null) => OtherDealerInfo>;  // one load of customers (postcode/county/head office from raw) + flags + settings
  export function setOtherDealer(db: Db, a: { vantageCustomerId: number; mode: 'default' | 'ours' | 'dealer'; name?: string | null; userId: number; now?: Date }): Promise<void>;  // upsert customer_flags; 'default' clears both columns; audit 'customer.other_dealer.set'
  // pm-queries.ts
  export type PmDealerScope = 'ours' | 'other' | 'all';   // PmFilter.dealer, default 'ours'
  // PmRow gains: customerId: number | null; district: string | null; county: string | null; otherDealer: OtherDealerInfo; plan: { whenInArea: boolean; priority: boolean }  (plan is {false,false} until Task 2 fills it)
  ```
- Validation (`savePlannerSettings`): `nearMiles` whole 1-100; `doneRetentionDays` whole 1-90; `askedStaleDays` whole 1-60; dealer names trimmed, blank -> null, <= 60 chars; patch names non-empty, <= 40, unique case-insensitively; districts match `^[A-Z]{1,2}\d[A-Z\d]?$` after trim/uppercase and each district belongs to at most one patch.

- [ ] **Step 1: Failing tests.** `region.test.ts`: `regionOf` — `D04 EK2K`, `Y35 HYE0`, `A92 X7FA`, `E91 HX70`, `d04ek2k` -> `ireland`; `B46 1DA`, `W14 9EQ`, `B16 8TP` -> `null`; `BT1 1AA`, `BT48 7XX` -> `ireland`; `EH1 1YZ`, `G1 1AA`, `G72 0AA`, `AB10 1AA`, `ZE1 0AA` -> `scotland`; `GL1 1AA`, `GU14 7PR`, `GU51 1AA` -> `null`; no postcode with county `Co. Cork`, `Co Mayo`, `County Kerry`, `Dublin 4`, `dublin` -> `ireland`; county `Co. Durham`, `County Durham`, `Hampshire`, empty -> `null`; no postcode + county `Co. Antrim` -> `ireland` (NI county); postcode present always wins over county. `postcodeOutward('gu147pr') === 'GU14'`, `('W14 9EQ') === 'W14'`, `('D04 EK2K') === null`, `(null) === null`. `resolveOtherDealer`: site `dealer` > head-office `ours`; site `ours` beats head-office `dealer` and region (Review Focus 2); head-office `dealer` applies when site has no flag; region used only when neither flag; blank region dealer -> null; `own.override` null is "no flag".
  `other-dealer.test.ts`: resolver over seeded `vantage_customers` (raw `PostCode`, `County`, `HeadOfficeId`) — Irish and Scottish sites resolve with `source: 'region'`; `setOtherDealer(..., 'dealer', 'Acme Print')` makes the site `source: 'site'`; `'ours'` on an Irish site -> `dealer: null`; `'default'` returns it to region; HO `dealer` + one site `ours` (Review Focus 2); unknown/`null` customer id -> `dealer: null`, no throw; audit row written with the user id. `pm-planner-settings.test.ts`: defaults when unset; save/get round-trip; each validation rule rejects with `SettingsError` code `invalid_planner_setting`; duplicate district across patches rejected.
  `pm-queries.test.ts`: `listPmDue` default excludes a machine at an Irish-region customer (no flag rows -> unchanged output for all existing fixtures); `{ dealer: 'other' }` returns only it with `otherDealer.dealer === 'MJ Flood'`; `{ dealer: 'all' }` returns both; a site flagged `ours` is back in the default list.
- [ ] **Step 2: Run** `npx vitest run packages/core/src/region.test.ts packages/db/src/queries/other-dealer.test.ts packages/db/src/queries/pm-planner-settings.test.ts packages/db/src/queries/pm-queries.test.ts` -> FAIL.
- [ ] **Step 3: Migration + schema.** Add to `customerFlags`: `otherDealerOverride: text('other_dealer_override')` (`dealer` | `ours`), `otherDealerName: text('other_dealer_name')`, plus a check constraint `(override = 'dealer') = (name is not null)` when override is not null. Run `npx drizzle-kit generate --name other_dealer` in `packages/db` -> `0021_other_dealer.sql`. **Apply it before any web code reads these columns:** `.\scripts\mps.ps1 stop -Only worker` then `start -Only worker`. (Spec called for `other_dealer_source`; region is computed, never stored, so only the manual override is persisted.)
- [ ] **Step 4: Implement** `region.ts` (Eircode test: `^(?:[ACDEFHKNPRTVWXY]\d{2}|D6W)\s?[0-9ACDEFHKNPRTVWXY]{4}$`, case-insensitive; Irish counties = the 26 of the Republic plus the 6 NI counties for the no-postcode rule, and the `Co.`/`Co `/`County` prefix only counts when followed by one of those names, so `Co. Durham` is not Ireland), `pm-planner-settings.ts`, `other-dealer.ts` (reads customers' `raw->>'PostCode'`, `raw->>'County'` and `headOfficeIdSql()`), and extend `loadMachines` (select `vantageCustomerId`, postcode, county) / `buildRows` / `listPmDue` (`dealer` option: partition by `otherDealer.dealer !== null`; default `'ours'`). Export everything from the package indexes.
- [ ] **Step 5: Run** the Step 2 command plus `npx vitest run packages/db apps/web/src/app/\(app\)/pm` -> PASS; `npm run typecheck` -> 0.
- [ ] **Step 6:** no commit — orchestrator commits at end.

### Task 2: `pm_plan`, PM due tabs, priority and plan actions (UI)

**Files:**
- Create: `packages/db/src/queries/pm-plan.ts` (+ `.test.ts`), `packages/db/drizzle/0022_pm_plan.sql`, `apps/web/src/lib/pm-plan-form.ts` (+ `.test.ts`)
- Modify: `packages/db/src/schema.ts` (`pmPlan`), `packages/db/src/queries/index.ts`, `packages/db/src/queries/pm-queries.ts` (fill `PmRow.plan`; default order priority first), `apps/web/src/app/(app)/pm/filters.ts` (+ `filters.test.ts`), `apps/web/src/app/(app)/pm/page.tsx`, `apps/web/src/app/(app)/pm/actions.ts`, `apps/web/src/app/(app)/pm/export/route.ts`, `apps/web/src/components/pm-row.tsx`, `packages/db/src/queries/pm-due.ts` (+ `pm-due.test.ts`)
- Test: files above

**Interfaces:**
- Consumes: Task 1 (`PmRow.otherDealer`, `PmDealerScope`, `setOtherDealer`).
- Produces:
  ```ts
  export type BoardColumnStored = 'to_plan' | 'asked' | 'done';
  export interface PmPlanRow { vantageEquipmentId: number; whenInArea: boolean; priority: boolean; boardColumn: BoardColumnStored | null; boardNote: string | null; addedAt: Date | null; askedAt: Date | null; doneAt: Date | null; doneReason: 'visit' | 'manual' | null; updatedAt: Date }
  export function loadPlanRows(db: Db, ids?: number[]): Promise<Map<number, PmPlanRow>>;
  export function setWhenInArea(db: Db, a: { vantageEquipmentId: number; on: boolean; userId: number; now?: Date }): Promise<void>;
  export function setPriority(db: Db, a: { vantageEquipmentId: number; on: boolean; userId: number; now?: Date }): Promise<void>;   // on => board_column 'to_plan' if currently null/done
  export function addToPlan(db: Db, a: { vantageEquipmentIds: number[]; userId: number; now?: Date }): Promise<void>;  // null/done -> to_plan, addedAt=now, done fields cleared; to_plan/asked untouched
  export function moveCard(db: Db, a: { vantageEquipmentId: number; to: BoardColumnStored; note?: string | null; userId: number; now?: Date }): Promise<void>;  // asked sets askedAt; done sets doneAt + doneReason 'manual'; to_plan clears askedAt
  export function removeFromPlan(db: Db, a: { vantageEquipmentId: number; userId: number }): Promise<void>;  // column -> null; row deleted when no flags remain
  export function overdueMonths(r: Pick<PmRow, 'result'>, now: Date): number | null;   // whole months since the earlier of timeCapDate/estDueDate that is <= now; null unless status overdue. Lives in packages/db/src/queries/pm-due.ts (pure; shared with the planner)
  // filters.ts
  export const PM_VIEWS = ['due', 'booked', 'dismissed', 'when-in-area', 'other-dealer', 'all'] as const;
  ```
  Tab rules (`applyPmView` / `countPm`, all rows loaded with `dealer: 'all'`): **Due** = ours, `inPmView(r,'due')`, not `whenInArea`; **When in area** = ours, `plan.whenInArea`, `inPmView(r,'due')`; **Booked/Dismissed** = ours as today; **Other dealer** = `otherDealer.dealer !== null`, any state; **All** = ours. Priority and When-in-area flags persist after a visit (the tab lists only machines still due).
  Server actions in `pm/actions.ts` (each `requireUser()` first, user id from session): `togglePriorityAction`, `toggleWhenInAreaAction`, `addToPlanAction`, `markOursAction` (calls `setOtherDealer(..., 'ours')`); forms post `return` (list URL) and `vantageEquipmentId`; `parsePlanForm(formData)` in `lib/pm-plan-form.ts`.
  Default order (`defaultPmOrder`): priority first, then today's order; an explicit `sort` stays authoritative.

- [ ] **Step 1: Failing tests.** `pm-plan.test.ts`: `setPriority` on a machine with no row creates the row on `to_plan` (auto-added); `setPriority off` keeps the card; `setWhenInArea` toggles without touching the column; `addToPlan` of a `done` row resets to `to_plan` and clears `doneAt`/`doneReason`; `addToPlan` leaves an `asked` row untouched; `moveCard` to `asked` sets `askedAt`, to `done` sets `doneReason: 'manual'`; `removeFromPlan` with flags keeps the row, without flags deletes it; every write adds an `audit_log` row. `pm-queries.test.ts`: `listPmDue` rows carry `plan`; default order puts a priority machine ahead of a more-overdue non-priority one but an explicit `sort=customer` ignores priority. `pm-due.test.ts`: `overdueMonths` — `timeCapDate` 18 months ago, status overdue -> 18; status ok -> null; pages-overdue with `estDueDate` 2 months ago -> 2; none -> null. `filters.test.ts`: Due excludes a `whenInArea` machine; When-in-area includes it only while still due and shows it even if overdue; Other-dealer tab shows other-dealer rows in every state and Due/Booked/Dismissed/All never do; `countPm` counts per tab; `parsePmFilters('?view=other-dealer')` accepted, unknown view -> `due`. `pm-plan-form.test.ts`: `parsePlanForm` accepts `^\d{1,10}$` ids, rejects blanks/negative/non-numeric with a `SettingsError`.
- [ ] **Step 2: Run** `npx vitest run packages/db/src/queries/pm-plan.test.ts packages/db/src/queries/pm-queries.test.ts packages/db/src/queries/pm-due.test.ts apps/web/src/lib/pm-plan-form.test.ts apps/web/src/app/\(app\)/pm/filters.test.ts` -> FAIL.
- [ ] **Step 3: Migration.** Add `pmPlan` to `schema.ts` (`vantage_equipment_id` integer PK; `when_in_area` and `priority` boolean not null default false; `board_column` text null with check in (`to_plan`,`asked`,`done`); `board_note` text; `added_at`, `asked_at`, `done_at` timestamptz null; `done_reason` text null check in (`visit`,`manual`); `updated_by` -> users; `updated_at` default now). `npx drizzle-kit generate --name pm_plan` -> `0022_pm_plan.sql`. **Restart the worker to apply it before `/pm` queries `pm_plan`.**
- [ ] **Step 4: Implement** `pm-plan.ts`, fill `PmRow.plan` in `buildRows` via `loadPlanRows`, `overdueMonths`, filter/tab changes, the export route (it keeps using `applyPmView`; the new views must export correctly), and the page: load once with `dealer: 'all'`, tabs Due / When in area / Booked / Dismissed / Other dealer / All with counts. In `pm-row.tsx` add a narrow rightmost "Plan" cell (star button for Priority with `aria-pressed`; a small menu with *Add to plan* (disabled "On plan" when on the board), *When in area* / *Back to Due*; on the Other dealer tab a *Mark as ours* button showing the dealer name). Rows in When in area carry the red "overdue 18m" badge from `overdueMonths` (muted when not overdue). Update `COLUMNS` and `colSpan` in the page and row. No change to `/pm` booking/dismiss behaviour.
- [ ] **Step 5: Run** Step 2 command plus `npx vitest run apps/web packages/db` -> PASS; `npm run typecheck`; `npx eslint apps/web/src packages/db/src` -> clean.
- [ ] **Step 6:** no commit — orchestrator commits at end.

### Task 3: Engineers, scheduled units, postcode districts — client reads and three worker jobs (logic)

**Files:**
- Create: `packages/db/drizzle/0023_planner_feeds.sql`, `apps/worker/src/jobs/vantage-engineers.ts`, `apps/worker/src/jobs/vantage-schedule.ts`, `apps/worker/src/jobs/postcode-lookup.ts` (+ a `.test.ts` for each)
- Modify: `packages/db/src/schema.ts` (`vantageEngineers`, `vantageScheduledUnits`, `postcodeDistricts`), `packages/vantage/src/client.ts` + `client.test.ts` (`listEngineers`, `listScheduledWorkUnits`), `packages/queue/src/index.ts`, `apps/worker/src/queue-options.ts` (+ `queue-options.test.ts`), `apps/worker/src/handlers.ts` (+ `handlers.test.ts`), `apps/worker/src/main.ts`, `apps/worker/src/env.ts` (+ `env.test.ts`), `apps/worker/src/test-helpers.ts`, `apps/web/src/components/admin-jobs.ts` (+ `admin-jobs.test.ts`)
- Test: files above

**Interfaces:**
- Produces:
  ```ts
  // @mps/vantage
  listEngineers: () => Promise<VantageRecord[]>;                                     // GET Engineer (read-only)
  listScheduledWorkUnits: (o: { from: Date; to: Date }) => Promise<VantageRecord[]>; // scheduledstartdate ge from and lt to; includeDeleted + WORK_UNIT_EXPAND (+ the engineer field)
  // @mps/queue QUEUES: vantageEngineers: 'vantage-engineers', vantageSchedule: 'vantage-schedule', postcodeLookup: 'postcode-lookup'
  // worker
  export function mapEngineer(raw: VantageRecord, syncedAt: Date): typeof vantageEngineers.$inferInsert | null;
  export function runVantageEngineers(deps: { db: Db; vantage: Pick<VantageClient, 'listEngineers'>; now?: () => Date }): Promise<JobResult>;
  export function mapScheduledUnit(raw: VantageRecord, syncedAt: Date): typeof vantageScheduledUnits.$inferInsert | null;   // null: no id, no ScheduledStartDate, or Work.DeletedDate set
  export function scheduleWindow(now: Date): { from: Date; to: Date };   // London midnight today .. London midnight day-after-tomorrow, as UTC instants
  export function runVantageSchedule(deps: { db: Db; vantage: Pick<VantageClient, 'listScheduledWorkUnits'>; now?: () => Date }): Promise<JobResult>;
  export function runPostcodeLookup(deps: { db: Db; fetch?: typeof fetch; baseUrl?: string; sleep?: (ms: number) => Promise<void>; now?: () => Date; maxPerRun?: number }): Promise<JobResult>;
  ```
  Tables (migration 0023): `vantage_engineers(vantage_id pk, name, is_active, raw jsonb, synced_at)`; `vantage_scheduled_units(work_unit_id pk, work_id, work_reference, engineer_id, customer_id, vantage_equipment_id nullable, scheduled_start not null, category_id, category_name, category_type, work_start, completed_at, raw jsonb, synced_at; index on scheduled_start)`; `postcode_districts(district pk, county, admin_district, latitude, longitude, status 'ok'|'not_found', looked_up_at)`.
  `runVantageSchedule` replaces the whole table in one transaction (it only ever holds today/tomorrow); an empty answer is valid (weekend), a failed fetch leaves the previous copy. `runPostcodeLookup`: districts = distinct `postcodeOutward(raw.PostCode)` of non-deleted customers not cached `ok` and not `not_found` within 30 days; at most `maxPerRun` (100) per run, `sleep(250)` between calls; 404 -> `not_found` row; 429 / 5xx / network error / unparsable body -> stop, status `partial`, nothing cached for that district; county = `admin_county[0] ?? admin_district[0] ?? null`. Cron env defaults: `SCHEDULE_CRON='*/30 6-19 * * *'`, `ENGINEERS_CRON='15 3 * * *'`, `POSTCODE_CRON='40 3 * * *'`; `POSTCODES_BASE_URL` default `https://api.postcodes.io`. Each queue is `stately`, `retryLimit: 0`, `expireInSeconds` 1800 (schedule) / 3600 (others).

- [ ] **Step 1: Verify the engineer field read-only against live Vantage.** Run a throwaway `npx tsx --env-file=.env` script (not committed, GET only) that fetches one `WorkUnit` with a non-null `ScheduledStartDate` and `Engineer` (2 rows, `$top=2`) and states which field carries the engineer (`WorkUnit.EngineerId`, a `Work` field, or an expanded `Engineer`), and the `Engineer` shape (id, name, active flag name). Record the sanitised field names in the test fixtures in Step 2 and use them in the mappers and `WORK_UNIT_EXPAND`. If no scheduled unit has an engineer, stop and report to the orchestrator instead of guessing.
- [ ] **Step 2: Failing tests.** `client.test.ts`: `listScheduledWorkUnits` builds the `scheduledstartdate ge <iso> and scheduledstartdate lt <iso>` filter, sends `api-version`, uses no non-GET method; `listEngineers` pages. `vantage-engineers.test.ts`: maps id/name/active, skips records without an id, empty answer -> `ParseError`-style failure leaves the previous rows. `vantage-schedule.test.ts`: `mapScheduledUnit` reads engineer id, customer id (from `Work.CustomerId`), nullable equipment, category type, `WorkStartDate`, `Work.CompletedDate`; skips deleted Work; **`scheduleWindow` for 2026-03-31T22:30Z (BST) gives `from` 2026-03-30T23:00Z and `to` 2026-04-02T23:00Z** (Review Focus 5); run replaces rows, an empty fetch clears the table, a thrown fetch keeps old rows and `RateLimitError`/`AuthError` -> `partial`. `postcode-lookup.test.ts` (mock `fetch`, injected `sleep`, no real network): ok body caches county/lat/lng with `admin_county` preferred; empty `admin_county` falls back to `admin_district`; 404 stores `not_found` and is skipped on the next run inside 30 days; 429 stops the run with `partial` and leaves later districts unqueried; 500 / thrown / garbage JSON stores nothing for that district (Review Focus 4); only `ok` rows are never re-fetched; request URLs contain only the outward code; `maxPerRun` respected; Eircodes/blank postcodes are skipped. `queue-options`/`handlers`/`env`/`admin-jobs` tests: new queues present, handlers wrapped in `withSyncRun`, env defaults, Jobs page lists the three jobs.
- [ ] **Step 3: Run** `npx vitest run packages/vantage apps/worker apps/web/src/components/admin-jobs.test.ts` -> FAIL.
- [ ] **Step 4: Migration + implement.** Add the three tables, `npx drizzle-kit generate --name planner_feeds` -> `0023_planner_feeds.sql`, implement client methods, mappers, jobs, queue/option/handler/schedule/env wiring (follow `vantageWork`'s entries everywhere it appears: `grep -rn vantageWork apps packages`), and `admin-jobs.ts` entries. **Restart the worker (`.\scripts\mps.ps1 stop -Only worker`, `start -Only worker`) to apply 0023 before any web code reads these tables.**
- [ ] **Step 5: Run** the Step 3 command -> PASS; `npm run typecheck` -> 0; `npx eslint apps/worker packages/vantage packages/queue` -> clean.
- [ ] **Step 6:** no commit — orchestrator commits at end.

### Task 4: Planner queries — board, areas, upcoming jobs (logic)

**Files:**
- Create: `packages/db/src/queries/pm-planner.ts`, `packages/db/src/queries/pm-planner.test.ts`
- Modify: `packages/db/src/queries/index.ts`, `packages/db/src/queries/pm-plan.ts` (add `markDoneByVisit`, `resetStaleDone`)

**Interfaces:**
- Consumes: Task 1 (`PmRow`, `listPmDue({dealer:'all'})`, `getPlannerSettings`, `PmPatch`), Task 2 (`loadPlanRows`, `PmPlanRow`, `overdueMonths` from `pm-due.ts`), Task 3 tables, `inPmView`, `londonDay`.
- Produces:
  ```ts
  export type BoardColumn = 'to_plan' | 'asked' | 'booked' | 'done';
  export type LeftDueReason = 'dismissed' | 'other_dealer' | 'left_contract';
  export interface BoardCard {
    vantageEquipmentId: number; customerId: number | null; customerName: string | null; town: string | null;
    serial: string | null; model: string | null; drmsEquipmentId: string | null;
    district: string | null; county: string | null;
    status: PmStatus | null; overdueMonths: number | null; whenInArea: boolean; priority: boolean;
    column: BoardColumn; reason: string | null;          // "Booked for 25 Nov (ref W-123)", "Booked: PM job in Vantage for 25 Nov", "Booked visit not seen", "Visit seen 21 Nov"
    note: string | null; askedDays: number | null; askedStale: boolean;
    leftDue: LeftDueReason | null;
  }
  export function boardColumnOf(plan: PmPlanRow, row: PmRow | null, now: Date): { column: BoardColumn; reason: string | null };  // pure
  export interface AreaGroup<T> { county: string; patches: { name: string | null; districts: { district: string | null; cards: T[] }[] }[]; due: number; overdue: number; priority: number }
  export function groupCardsByArea<T extends { district: string | null; county: string | null; priority: boolean; overdueMonths: number | null }>(cards: T[], patches: PmPatch[]): AreaGroup<T>[];  // pure
  export function loadBoard(db: Db, now?: Date): Promise<{ cards: BoardCard[]; settings: PlannerSettings }>;   // runs the done/reset sync first (own-DB writes only, logged on failure)
  export interface PmSuggestion { vantageEquipmentId: number; customerName: string | null; serial: string | null; model: string | null; status: PmStatus; overdueMonths: number | null; priority: boolean; whenInArea: boolean; distanceMiles: number | null; sameDistrict: boolean; sameSite: boolean; boardColumn: BoardColumn | null }
  export interface UpcomingCall { workUnitId: number; reference: string | null; start: Date; customerId: number | null; customerName: string | null; district: string | null; categoryName: string | null; equipment: string | null; started: boolean; located: 'customer' | 'district' | null; suggestions: PmSuggestion[] }
  export interface UpcomingEngineer { engineerId: number | null; name: string; days: { which: 'today' | 'tomorrow'; date: string; calls: UpcomingCall[] }[] }
  export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number;   // pure
  export function suggestNear(call: { customerId: number | null; district: string | null; at: { lat: number; lng: number } | null }, candidates: SuggestionCandidate[], radiusMiles: number, limit?: number): PmSuggestion[];  // pure; default limit 8
  export function loadUpcoming(db: Db, now?: Date): Promise<{ today: string; tomorrow: string; engineers: UpcomingEngineer[] }>;
  ```
  Rules: `boardColumnOf` — `done` (plan row) stays `done` until `doneRetentionDays`, after which the card is dropped from `loadBoard`; `booked` when the machine has an open `pm_actions` booked row not `booked_overdue`, or `result.status === 'booked'`; `to_plan` with reason "Booked visit not seen" when a booked action expired within 14 days and nothing else applies; otherwise the stored column; `askedStale` when `askedDays > askedStaleDays`. Sync: a card on `to_plan`/`asked`/`booked` whose `result.lastQualifying.at` is after `addedAt` is moved to `done` with reason `visit`; a `done` card whose machine is `inPmView(...,'due')` again and `doneAt` older than 1 day is reset to `to_plan`. Leaves-due: machine absent from active-contract rows -> `leftDue: 'left_contract'`; `view === 'dismissed'` -> `'dismissed'`; `otherDealer.dealer` -> `'other_dealer'`; the card keeps its column. County = cache `postcode_districts.county` for the district, else the Vantage `County` text, else `null` (grouped as "Unknown county", listed last); no district -> district `null` ("No postcode"). Patches nest inside a county; a patch spanning counties appears in each with only that county's districts. Suggestion candidates = ours, `inPmView(row,'due')`, not booked, not dismissed; rank priority, then overdue, due soon, when-in-area (a when-in-area non-priority machine ranks below due soon whatever its status), then distance; near = same district OR `haversineMiles <= radius`; same customer = `sameSite`. Call location = customer `raw.Latitude/Longitude` (numbers or numeric strings), else the district centroid from `postcode_districts` (`located: 'district'`), else none (district match only). Calls with `completed_at` set are excluded; `started` = `work_start` set; engineer name from `vantage_engineers`, unknown id -> "Engineer <id>", null -> "Unassigned"; days by `londonDay`; calls ordered by `start`.

- [ ] **Step 1: Failing tests** (`pm-planner.test.ts`):
  `boardColumnOf`: stored `asked` stays `asked`; open booked action -> `booked` with the reference in the reason; Vantage PM job (`status: 'booked'`) -> `booked`; booked action expired 3 days ago, stored `to_plan` -> `to_plan` + "Booked visit not seen"; `done` within retention -> `done`; `askedAt` 9 days ago -> `askedDays 9`, stale true at the default 7.
  `groupCardsByArea`: two districts in one county group under it; a patch holding `GU14`+`GU11` nests both; a patch spanning two counties appears under each with only its districts there; unknown county last, no-postcode district last; counts `due`/`overdue`/`priority`; within a district priority then most overdue first.
  `loadBoard`: card with `plan.priority` of a machine whose customer is now other-dealer keeps its column with `leftDue: 'other_dealer'` (Review Focus 3); a card whose contract ended shows `left_contract` with the equipment's serial from `vantage_equipment`; dismissed -> `dismissed`; a qualifying visit after `addedAt` moves it to `done` with reason `visit` and persists; a `done` older than retention is not returned; a done machine due again is reset to `to_plan`; machines never added are not on the board; a sync write failure is logged and the board still loads.
  `haversineMiles`: Farnborough (51.2933,-0.7556) to Guildford (51.2362,-0.5704) ~ 8.6 miles (±0.3); same point 0.
  `suggestNear`: same district included with no coordinates; 10-mile radius excludes an 11-mile machine and includes a 9-mile one; `sameSite` flagged; ordering priority > overdue > due soon > when-in-area; limit 8; excluded: booked, dismissed, other dealer.
  `loadUpcoming`: units for today and tomorrow in London days — a unit at 23:30Z on 31 Mar (BST) lands on 1 Apr (Review Focus 5); completed unit excluded; unit with `work_start` is `started: true`; two engineers grouped with names; null engineer -> "Unassigned"; call with no machine and no coordinates and no cached district -> `located: null`, still listed, suggestions only by same district (empty when no district); customer lat/lng strings parsed; district centroid fallback -> `located: 'district'`; calls sorted by start.
- [ ] **Step 2: Run** `npx vitest run packages/db/src/queries/pm-planner.test.ts` -> FAIL.
- [ ] **Step 3: Implement** the pure functions first (`boardColumnOf`, `groupCardsByArea`, `haversineMiles`, `suggestNear`), then the loaders. `loadBoard` and `loadUpcoming` call `listPmDue(db, now, { view: 'all', dealer: 'all' })` once; the sync helpers `markDoneByVisit` / `resetStaleDone` live in `pm-plan.ts`.- [ ] **Step 4: Run** `npx vitest run packages/db` -> PASS; `npm run typecheck` -> 0.
- [ ] **Step 5:** no commit — orchestrator commits at end.

### Task 5: Planner page — board (UI)

**Files:**
- Create: `apps/web/src/app/(app)/pm/planner/page.tsx`, `apps/web/src/app/(app)/pm/planner/actions.ts`, `apps/web/src/components/planner-board.tsx`, `apps/web/src/components/planner-card.tsx`, `apps/web/src/lib/planner-form.ts` (+ `.test.ts`)
- Modify: `apps/web/src/lib/device-origin.ts` (+ `device-origin.test.ts`: add origin `'pm-planner': { label: 'PM planner', href: '/pm/planner' }`), `apps/web/src/components/app-sidebar.tsx` (new NavLink "PM planner" under PM due; make the PM due link `exact`), `apps/web/src/app/(app)/pm/page.tsx` (link "PM planner →" in the header actions)
- Test: `apps/web/src/lib/planner-form.test.ts`, `apps/web/src/lib/device-origin.test.ts`

**Interfaces:**
- Consumes: `loadBoard`, `groupCardsByArea`, `BoardCard`, `BoardColumn`, `moveCard`, `removeFromPlan`, `setPriority`, `markPmBooked`, `deviceHref`, `statusLabel`/`statusTone`/`ToneBadge`, the Mark-booked form fields (`parseBookedForm`).
- Produces:
  ```ts
  // planner-form.ts
  export function parseMoveForm(fd: FormData): { vantageEquipmentId: number; to: 'to_plan' | 'asked' | 'done'; note: string | null };   // 'booked' is not postable here
  export function parseRemoveForm(fd: FormData): { vantageEquipmentId: number };
  export function plannerReturnHref(raw: FormDataEntryValue | string | null): string;   // only '/pm/planner' + query; anything else -> '/pm/planner'
  export function reasonBadgeText(card: Pick<BoardCard, 'leftDue' | 'reason' | 'askedDays' | 'askedStale'>): string | null;
  // actions.ts ('use server', requireUser() first): moveCardAction, removeCardAction, togglePriorityPlannerAction, bookCardAction
  ```
  `bookCardAction` = `markPmBooked` (via `parseBookedForm`) followed by `moveCard(..., 'to_plan')` so the stored column falls back to To plan if the booking later lapses. Page layout: board left (about two thirds), an `id="upcoming"` slot on the right for Task 6; four columns (stacked on mobile), each grouped county -> patch -> district with a group header "GU14 · 5 due · 2 overdue · 1 priority"; cards show customer, serial/model, status chip, "overdue 18m" (red) , priority star, muted style when-in-area, reason badge, note, a *Move to…* menu (To plan, Asked engineer, Booked -> opens the Mark-booked form inline, Done) and *Remove* (visible on leaves-due cards, available on all). Drag-and-drop is not required.

- [ ] **Step 1: Failing tests.** `planner-form.test.ts`: `parseMoveForm` accepts `to_plan|asked|done`, rejects `booked`/unknown/blank id with `SettingsError`; `plannerReturnHref('/pm/planner?x=1') === '/pm/planner?x=1'`, `'https://evil'`, `'//evil'`, `'/pm'`, `'/pm/planner/../x'`, `null` -> `'/pm/planner'`; `reasonBadgeText`: leftDue `other_dealer` -> "Other dealer — no longer ours", `dismissed` -> "Dismissed", `left_contract` -> "No longer on an active contract"; asked 9 days stale -> "Asked 9 days ago"; plain card -> reason or null. `device-origin.test.ts`: `deviceHref('d1', 'pm-planner', '/pm/planner?x=1')` keeps the back and `resolveDeviceOrigin('pm-planner', back)` returns it; `/pm/planner` is not accepted as a `back` for `'pm'`.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/lib/planner-form.test.ts apps/web/src/lib/device-origin.test.ts` -> FAIL.
- [ ] **Step 3: Implement** the helpers, actions, page and components. The page is a server component (`requireUser()` first) calling `loadBoard(getDb(), new Date())`; empty board shows "Nothing on the plan yet — add machines from PM due"; Done column footer notes the retention days from settings.
- [ ] **Step 4: Run** `npx vitest run apps/web` -> PASS; `npm run typecheck`; `npx eslint apps/web/src` -> clean.
- [ ] **Step 5:** no commit — orchestrator commits at end.

### Task 6: Upcoming jobs panel and nearby suggestions (UI)

**Files:**
- Create: `apps/web/src/components/planner-upcoming.tsx`, `apps/web/src/lib/planner-upcoming.ts` (+ `.test.ts`)
- Modify: `apps/web/src/app/(app)/pm/planner/page.tsx` (fill the `#upcoming` slot), `apps/web/src/app/(app)/pm/planner/actions.ts` (`askEngineerAction`, `addSuggestionToPlanAction`)
- Test: `apps/web/src/lib/planner-upcoming.test.ts`

**Interfaces:**
- Consumes: `loadUpcoming`, `UpcomingEngineer`, `UpcomingCall`, `PmSuggestion`, `moveCard`, `addToPlan`, `plannerReturnHref`.
- Produces:
  ```ts
  export function callTimeText(start: Date): string;                 // "09:30" in Europe/London
  export function suggestionDistanceText(s: Pick<PmSuggestion, 'sameSite' | 'sameDistrict' | 'distanceMiles'>): string;  // "Same site" | "Same district (GU14)" is built by caller | "6.4 mi"
  export function askNote(engineerName: string, callStart: Date): string;          // "Asked <name> for <dd Mon>"
  // actions: askEngineerAction(formData: vantageEquipmentId, engineerName, callStart ISO, return) -> moveCard 'asked' with askNote (adds the machine to the plan first when it is not on it); addSuggestionToPlanAction -> addToPlan
  ```
  Panel: per engineer, "Today <date>" / "Tomorrow <date>" with calls in order; each call shows time, customer, category, machine (if any), "started" tag, "no location" muted note when `located === null`; under it up to 8 suggestions (status chip, overdue months, priority star, distance text, "On board: To plan"), each with **Asked engineer** and **Add to plan** buttons. Empty states: "No booked calls today" / "Engineers' diary hasn't refreshed yet" when `vantage_scheduled_units` is empty and the last `vantage-schedule` run is older than 2 hours (read `sync_runs` through the existing job-status helper; do not add a new query if one exists — `grep -rn "syncRuns" packages/db/src/queries/admin.ts`).

- [ ] **Step 1: Failing tests.** `callTimeText(new Date('2026-03-31T22:30:00Z')) === '23:30'` (BST) and `callTimeText(new Date('2026-12-01T09:00:00Z')) === '09:00'` (GMT); `suggestionDistanceText` returns "Same site" when `sameSite`, `"6.4 mi"` for 6.43, "Same district" when only `sameDistrict` and no distance, `''` when none; `askNote('Dave', new Date('2026-11-24T08:00:00Z')) === 'Asked Dave for 24 Nov'`; form parse for the ask action rejects a missing engineer name and a non-ISO date.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/lib/planner-upcoming.test.ts` -> FAIL.
- [ ] **Step 3: Implement** helpers, actions (each `requireUser()` first; both revalidate `/pm/planner`), the panel and its wiring in the page. Moving a suggestion to Asked updates the board card in the same request.
- [ ] **Step 4: Run** `npx vitest run apps/web` -> PASS; `npm run typecheck`; `npx eslint apps/web/src` -> clean.
- [ ] **Step 5:** no commit — orchestrator commits at end.

### Task 7: Customers other-dealer badge and toggle, planner settings form (UI)

**Files:**
- Create: `apps/web/src/components/other-dealer-badge.tsx`, `apps/web/src/components/other-dealer-control.tsx` (client dialog like `self-managed-switch.tsx`), `apps/web/src/lib/other-dealer-form.ts` (+ `.test.ts`), `apps/web/src/lib/planner-settings-form.ts` (+ `.test.ts`)
- Modify: `packages/db/src/queries/customers.ts` (`CustomerRow.otherDealer`, `CustomerDetail.otherDealer` + `ownOverride`; use `loadDealerResolver`), `packages/db/src/queries/customers.test.ts`, `apps/web/src/app/(app)/customers/page.tsx`, `apps/web/src/app/(app)/customers/[id]/page.tsx`, `apps/web/src/app/(app)/customers/actions.ts` (`setOtherDealerAction`), `apps/web/src/app/(app)/settings/pm/page.tsx`, `apps/web/src/app/(app)/settings/pm/actions.ts` (`savePlannerSettingsAction`)
- Test: files above

**Interfaces:**
- Consumes: Task 1 (`OtherDealerInfo`, `setOtherDealer`, `getPlannerSettings`, `savePlannerSettings`, `PlannerSettings`).
- Produces:
  ```ts
  export function parseOtherDealerForm(fd: FormData): { vantageCustomerId: number; mode: 'default' | 'ours' | 'dealer'; name: string | null };  // dealer requires a name <= 60 chars
  export function otherDealerBadgeText(i: Pick<OtherDealerInfo, 'dealer' | 'source'>): string | null;  // "Other dealer: MJ Flood" (+ " (head office)" / " (by region)" suffix variants)
  export function parsePatches(text: string): PmPatch[];            // lines "Farnborough patch: GU14, GU11, GU51"
  export function formatPatches(p: PmPatch[]): string;              // inverse
  export function parsePlannerSettingsForm(fd: FormData): PlannerSettings;
  ```
  Customers list: under the name, a `ToneBadge` "Other dealer: MJ Flood" when `otherDealer.dealer` (no new column; works unchanged inside the accordion rows if the accordion has landed). Customer page: badge in the header beside Self-managed plus `OtherDealerControl` (Default by region / Ours / Other dealer + name, region dealer names suggested; dialog states what it does: "Removes this site's machines from PM due and the planner. Does not affect toner orders"). `/settings/pm`: a "Planner and other dealers" card with Ireland dealer name, Scotland dealer name, near-miles, Done retention days, Asked-stale days, Patches textarea; errors show through the page's existing `settingsErrorMessage` pattern.

- [ ] **Step 1: Failing tests.** `other-dealer-form.test.ts`: dealer mode without name rejected; name over 60 rejected; `default`/`ours` ignore the name; bad id rejected. `otherDealerBadgeText` for site/head-office/region sources and `dealer: null` -> `null`. `planner-settings-form.test.ts`: `parsePatches('Farnborough patch: GU14, gu11 ,GU51\n\nNorth: RG1')` -> two patches, districts uppercased and trimmed, blank lines ignored; a line without a colon or with an invalid district throws `SettingsError`; `formatPatches(parsePatches(x))` round-trips; form parse maps blank dealer names to null and non-numeric miles to an error. `customers.test.ts`: `listCustomers` rows carry `otherDealer` (Irish-postcode site -> `MJ Flood`, source `region`); a site with a manual `ours` row shows `dealer: null`; `getCustomer` returns `ownOverride` (`null | 'ours' | 'dealer'`) so the control preselects correctly.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/lib/other-dealer-form.test.ts apps/web/src/lib/planner-settings-form.test.ts packages/db/src/queries/customers.test.ts` -> FAIL.
- [ ] **Step 3: Implement** helpers, queries, actions (`requireUser()` first; `isFlaggableCustomer` guards the id; revalidate `/customers`, `/customers/[id]`, `/pm`, `/pm/planner`), badge, control and settings card.
- [ ] **Step 4: Run** `npx vitest run apps/web packages/db` -> PASS; `npm run typecheck`; `npx eslint apps/web/src packages/db/src` -> clean.
- [ ] **Step 5:** no commit — orchestrator commits at end.

### Task 8: Final verification and rebuild

- [ ] **Step 1:** `npm test` (full suite, ~13 min) -> all pass; `npm run typecheck` -> 0; `npm run lint` -> clean. `grep -rn "regionOf\|resolveOtherDealer" apps packages --include=*.ts --include=*.tsx` shows no second implementation of either rule outside `region.ts`/`other-dealer.ts` and their tests.
- [ ] **Step 2:** Confirm the other-dealer scope: `grep -rn "otherDealer" packages/db/src apps/web/src` has no hit in replenishment, alerts, reconnect, devices or fleet queries/pages.
- [ ] **Step 3:** `powershell -File scripts/mps.ps1 build` (production build; restarts web and worker, applying any pending migration) then `powershell -File scripts/mps.ps1 status` -> both running.
- [ ] **Step 4:** From Admin -> Jobs press *Run now* once each for `vantage-engineers`, `vantage-schedule`, `postcode-lookup` (all read-only: Vantage GETs and postcodes.io outward-code GETs); confirm each ends `success` or `partial` with a sensible error sample, and the row counts in `vantage_engineers`, `vantage_scheduled_units`, `postcode_districts` are non-zero (use `psql` per CLAUDE.md; report counts only, no personal data).
- [ ] **Step 5:** Manual click-through (report what was seen; fix only what is broken): PM due tabs and counts (Due, When in area, Booked, Dismissed, Other dealer ~ 60+ machines expected, All), Irish and Scottish sites absent from Due and present under Other dealer, *Mark as ours* returns a site, star and When-in-area toggles, Add to plan; `/pm/planner` board grouping, Move to…, Booked via Mark-booked form, Remove on a leaves-due card; Upcoming jobs for today/tomorrow with suggestions and *Asked engineer*; Customers badge and the customer-page control; `/settings/pm` planner card saves; Back links from device pages return to `/pm/planner`.
- [ ] **Step 6:** no commit — orchestrator commits at end.
