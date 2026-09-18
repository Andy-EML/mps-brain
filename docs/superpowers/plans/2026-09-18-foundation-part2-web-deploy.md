# MPS Brain Foundation — Part 2 (Web + Deploy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Foundation a web app: login, Fleet overview, Device detail, Link issues queue, Alerts (including the new offline alert) and Admin (users, counter names, manual job runs) — then ship the whole stack as a Docker/Portainer deployment.

**Architecture:** `apps/web` is a Next.js App Router app in the existing monorepo. It reads Postgres directly through `@mps/db` (server components, no API layer) and writes through server actions. Job triggering goes through pg-boss with `createBoss(url, 'client')`. The worker gains an offline-alert evaluation and an hourly `drms-pull`. Authentication is a cookie session (iron-session) over the existing `users` table.

**Tech Stack:** Next.js 16 (App Router, React 19), Tailwind CSS v4, shadcn/ui, iron-session 8, Drizzle (existing), Vitest (existing), Docker + Portainer.

**Spec:** `docs/superpowers/specs/2026-09-17-mps-foundation-design.md` — read "Added requirements" (offline alert), "Meter mapping", "Scope notes" and the Phase 0 findings.

**Design source:** `mockups of dashboard/Fleet overview@2x.png`, `Device detail@2x.png` (`Toner ordering@2x.png` is sub-project 3, not this plan). Match layout, sidebar, cards, toner bars and the green accent.

## Global Constraints

- Repo root `C:\dev\mps-brain`, branch off `main` (currently at the Part 1 merge). Windows 10, Node 24, Git Bash.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Stage explicit paths only; the untracked `mockups of dashboard/` folder is not yours.
- Never read or print `.env`. Secrets come from env only. Never log tokens.
- The web app is **read-only against DRMS and Vantage** — it never calls those APIs directly. All external I/O stays in the worker.
- Postgres is the only data source for pages. Query through `@mps/db` (Drizzle), never raw SQL strings except where the plan gives one.
- Every page requires a logged-in user. Admin-only: users, counter names, manual job runs.
- Timezone for display: **Europe/London**, dates as `d MMM yyyy HH:mm` (use `Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London' })`). Data stays UTC in the DB.
- Tests: Vitest, PGlite for anything touching the DB. Test query helpers, domain logic and server actions. No DOM/browser tests in this plan.
- Colours (from the mockups): accent `#0F6B5C`, page background `#F7F8F8`, card `#FFFFFF`, border `#E7E9E9`, text `#1A1D1D`, muted `#6B7280`; toner: cyan `#29ABE2`, magenta `#E5177B`, yellow `#F5C400`, black `#111111`, waste `#9AA0A6`; status: ok `#16A34A`, warn `#D97706`, critical `#DC2626`.
- Thresholds for display: toner **critical < 5%**, **low < 20%** (the spec's per-customer thresholds arrive in sub-project 3).
- Don't build order **creation**, auto-reorder, uptime or "book an engineer" (order history is read-only in Task 3B; creating orders belongs to sub-project 3) — no data or not wanted. Jams and service-code events are pulled and stored (Task 3A) but hidden from the UI by default. Drums, imaging units, waste bottles and filters appear only as PartsLife/waste **alarms**, never as percentages — DRMS has no counters for them.

## File Map

```
packages/db/src/schema.ts                  Task 1  + deviceAlerts table
packages/db/drizzle/0001_*.sql             Task 1  generated migration
packages/db/src/queries/                   Task 2  fleet.ts, device.ts, issues.ts, alerts.ts, admin.ts (+ tests)
apps/worker/src/jobs/alerts-evaluate.ts    Task 3  offline alert evaluation (+ test)
packages/db/src/schema.ts                  Task 3A + deviceAlarms table (+ migration 0002)
packages/drms/src/client.ts                Task 3A listAlarms (+ schema, tests)
apps/worker/src/jobs/drms-alarms.ts        Task 3A alarm pull job (+ test)
apps/worker/src/jobs/drms-pull.ts          Task 3  (unchanged) — main.ts gains the hourly schedule
apps/web/                                  Task 4+ Next.js app
  src/app/layout.tsx, globals.css          Task 4  shell, sidebar, theme tokens
  src/app/login/page.tsx                   Task 4  login
  src/lib/session.ts, auth.ts              Task 4  iron-session, requireUser/requireAdmin
  src/components/ui/*                      Task 4  shadcn primitives
  src/components/{TonerBar,StatCard,StatusDot,DataTable,PageHeader}.tsx   Task 5
  src/app/(app)/page.tsx                   Task 5  Fleet overview
  src/app/(app)/devices/[id]/page.tsx      Task 6  Device detail
  src/app/(app)/issues/page.tsx + actions  Task 7  Link issues queue
  src/app/(app)/alerts/page.tsx + actions  Task 8  Alerts
  src/app/(app)/admin/**                   Task 9  users, counter names, jobs
Dockerfile.web, Dockerfile.worker          Task 10
docker-compose.yml, .dockerignore          Task 10
docs/DEPLOY.md                             Task 10
```

---

### Task 1: `device_alerts` table + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Generated: `packages/db/drizzle/0001_alerts.sql` + meta (commit it)
- Test: `packages/db/src/schema.test.ts` (add cases)

**Interfaces:**
- Produces: table `deviceAlerts` with columns — `id serial pk`, `drmsEquipmentId text not null references drms_equipment(drms_id)`, `type text not null` (`offline` for now), `firstDetectedAt ts not null`, `lastSeenReportAt ts` (the device's last counter time when the alert opened), `clearedAt ts`, `acknowledgedBy int references users(id)`, `acknowledgedAt ts`, `details jsonb not null default {}`.
- Unique partial index `device_alerts_open_uq` on `(drmsEquipmentId, type)` **where `cleared_at is null`** — one open alert per device per type.
- Index on `(type, clearedAt)`.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/schema.test.ts`:
```ts
  it('allows one open alert per device and type, but history after clearing', async () => {
    await t.db.insert(deviceAlerts).values({ drmsEquipmentId: 'd1', type: 'offline', firstDetectedAt: new Date(), clearedAt: new Date() });
    await t.db.insert(deviceAlerts).values({ drmsEquipmentId: 'd1', type: 'offline', firstDetectedAt: new Date() });
    await expect(
      t.db.insert(deviceAlerts).values({ drmsEquipmentId: 'd1', type: 'offline', firstDetectedAt: new Date() }),
    ).rejects.toThrow();
  });
```
Import `deviceAlerts` in that test file.

- [ ] **Step 2: Run it, see it fail**

Run: `npx vitest run packages/db/src/schema.test.ts`
Expected: FAIL — `deviceAlerts` is not exported.

- [ ] **Step 3: Add the table**

In `packages/db/src/schema.ts`, after `counterNames`:
```ts
export const deviceAlerts = pgTable(
  'device_alerts',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    type: text('type').notNull(),
    firstDetectedAt: ts('first_detected_at').notNull().defaultNow(),
    lastSeenReportAt: ts('last_seen_report_at'),
    clearedAt: ts('cleared_at'),
    acknowledgedBy: integer('acknowledged_by').references(() => users.id),
    acknowledgedAt: ts('acknowledged_at'),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [
    uniqueIndex('device_alerts_open_uq').on(t.drmsEquipmentId, t.type).where(sql`cleared_at is null`),
    index('device_alerts_type_cleared_idx').on(t.type, t.clearedAt),
  ],
);
```

- [ ] **Step 4: Generate the migration**

Run: `cd packages/db && npx drizzle-kit generate --name alerts && cd ../..`
Expected: `packages/db/drizzle/0001_alerts.sql` created. Open it and confirm the partial unique index ends with `WHERE cleared_at is null`.

- [ ] **Step 5: Run tests, commit**

Run: `npx vitest run packages/db && npm run typecheck`
Then commit `packages/db/src/schema.ts`, `packages/db/src/schema.test.ts`, `packages/db/drizzle/`.

---

### Task 2: Query layer (`packages/db/src/queries/*`)

All pages read through these. Pure SQL/Drizzle, no React. Every function takes `db: Db` first.

**Files:**
- Create: `packages/db/src/queries/fleet.ts`, `device.ts`, `issues.ts`, `alerts.ts`, `admin.ts`, `index.ts`
- Modify: `packages/db/package.json` (add `"./queries": "./src/queries/index.ts"` to exports)
- Test: `packages/db/src/queries/queries.test.ts`

**Interfaces (exact signatures — later tasks import these):**
```ts
// fleet.ts
export interface FleetSummary { devices: number; monitored: number; linked: number; needsToner: number; criticalToner: number; lowToner: number; offline: number; openIssues: number; lastSyncAt: Date | null }
export function getFleetSummary(db: Db): Promise<FleetSummary>
export interface DeviceRow {
  drmsId: string; serial: string | null; name: string | null; model: string | null; status: string | null;
  customerName: string | null; vantageCustomerName: string | null; vantageEquipmentId: number | null; linkMethod: string | null;
  lastCounterAt: Date | null; offline: boolean;
  toner: { black: number | null; cyan: number | null; magenta: number | null; yellow: number | null };
  meters: { black: number | null; colour: number | null; scan: number | null };
}
export interface DeviceListOptions { search?: string; filter?: 'all' | 'needs-toner' | 'offline' | 'unlinked'; limit?: number; offset?: number }
export function listDevices(db: Db, o?: DeviceListOptions): Promise<{ rows: DeviceRow[]; total: number }>

// device.ts
export interface DeviceDetail { device: DeviceRow; drmsRaw: unknown; vantageRaw: unknown; latestSnapshotAt: Date | null; contractRef: string | null }
export function getDevice(db: Db, drmsId: string): Promise<DeviceDetail | null>
export interface CounterPoint { at: Date; value: number }
export function getCounterHistory(db: Db, drmsId: string, names: string[], days?: number): Promise<Record<string, CounterPoint[]>>
export function getLatestCounters(db: Db, drmsId: string): Promise<{ name: string; value: number | null; category: string | null }[]>

// issues.ts
export interface IssueRow { id: number; type: string; status: string; drmsId: string | null; drmsName: string | null; drmsSerial: string | null; vantageId: number | null; vantageSerial: string | null; vantageCustomerName: string | null; details: unknown; firstSeen: Date; lastSeen: Date }
export function listIssues(db: Db, o?: { type?: string; status?: string; limit?: number; offset?: number }): Promise<{ rows: IssueRow[]; total: number; countsByType: Record<string, number> }>
export function searchVantageEquipment(db: Db, q: string, limit?: number): Promise<{ vantageId: number; serial: string | null; assetNumber: string | null; customerName: string | null; linkedToDrmsId: string | null }[]>

// alerts.ts
export interface AlertRow { id: number; drmsId: string; deviceName: string | null; serial: string | null; customerName: string | null; type: string; firstDetectedAt: Date; lastSeenReportAt: Date | null; acknowledgedAt: Date | null; acknowledgedByName: string | null }
export function listAlerts(db: Db, o?: { includeCleared?: boolean; limit?: number }): Promise<AlertRow[]>

// admin.ts
export function listUsers(db: Db): Promise<{ id: number; username: string; role: string; active: boolean; createdAt: Date }[]>
export function listCounterNames(db: Db): Promise<{ name: string; category: string | null; sampleValue: number | null; firstSeen: Date }[]>
export function listSyncRuns(db: Db, limit?: number): Promise<{ id: number; job: string; startedAt: Date; finishedAt: Date | null; status: string; stats: unknown; errorSample: string | null }[]>
export function getAppStateValue<T>(db: Db, key: string): Promise<T | null>   // re-export of getAppState
```

**Rules the queries must follow:**
- "Monitored" = `drms_equipment` rows whose `missing_since is null` and status is not `Deleted`.
- "Linked" = an active row in `device_links` (`unlinked_at is null`).
- Toner and meter values come from the **latest** `counter_snapshots` row per device (highest `received_time`, tie-broken by `id`), joined to `counter_values` filtered by name: toner `BlackTonerLevel` / `CyanTonerLevel` / `MagentaTonerLevel` / `YellowTonerLevel`; meters `Black:Total` / `Full Color:Total` / `Scanner/FAX:Scan`.
- `offline` = the device has a `last_counter_received_time` (it reported once) **and** that time is older than `OFFLINE_ALERT_HOURS` (default 24) — pass the threshold in as an option with a default so tests can set it.
- `needsToner` = any toner value < 20; `criticalToner` = any < 5.
- `lastSyncAt` = the most recent successful `sync_runs.finished_at`.
- `listDevices` search matches serial, DRMS name, DRMS customer name or Vantage customer name, case-insensitive (`ilike '%q%'`).
- Every list function returns at most `limit` rows (default 50) and a total count.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/queries/queries.test.ts` seeds a small fixture through `createTestDb()` — 3 DRMS devices (one linked with fresh counters, one linked and stale/offline, one unlinked), 2 Vantage equipment rows, a snapshot with counter values, 2 issues, 1 alert, 1 user, 2 sync runs — then asserts:
- `getFleetSummary` counts (devices, monitored, linked, needsToner, criticalToner, offline, openIssues, lastSyncAt)
- `listDevices` returns toner and meter values on the right device; `filter: 'needs-toner'`, `'offline'` and `'unlinked'` each return only the matching device; `search` matches serial and customer; `total` is the unfiltered-by-paging count
- `getDevice` returns the joined detail, `getLatestCounters` returns names with categories, `getCounterHistory` returns points in ascending date order for the requested names
- `listIssues` returns rows with joined names plus `countsByType`; `searchVantageEquipment` finds by serial and marks an already-linked record
- `listAlerts` returns open alerts with the device name, and `includeCleared` adds cleared ones
- `listUsers`, `listCounterNames`, `listSyncRuns` return what was seeded

Write helper `seedFixture(db)` in the test file. Keep the fixture in one place: later tasks reuse it by importing from `packages/db/src/queries/queries.test.ts`? No — instead put it in `packages/db/src/testing.ts` as `seedDemoFixture(db)` so the web tests can reuse it.

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run packages/db/src/queries`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the queries**

Guidance for the trickiest one — the latest snapshot per device. Use a lateral-free approach that PGlite supports:
```ts
// latest snapshot id per device
const latest = db
  .select({ drmsId: counterSnapshots.drmsEquipmentId, snapshotId: sql<number>`max(${counterSnapshots.id})`.as('snapshot_id') })
  .from(counterSnapshots)
  .groupBy(counterSnapshots.drmsEquipmentId)
  .as('latest');
```
(`max(id)` is correct because ids increase with insertion and a device's newest collection is always inserted last.)
Then join `counter_values` on `snapshot_id` and pivot with conditional aggregates:
```ts
const val = (name: string) =>
  sql<number | null>`max(case when ${counterValues.name} = ${name} then ${counterValues.value} end)`;
```
Group by device. Use `leftJoin` everywhere so devices without snapshots still appear.

Keep each query file under ~150 lines. If one grows past that, split by concern rather than adding branches.

- [ ] **Step 4: Run tests, typecheck, lint, commit**

---

### Task 3: Offline alerts in the worker + hourly DRMS pull

**Files:**
- Create: `apps/worker/src/jobs/alerts-evaluate.ts` + `alerts-evaluate.test.ts`
- Modify: `apps/worker/src/jobs/drms-pull.ts` (call the evaluation at the end), `apps/worker/src/env.ts` (`OFFLINE_ALERT_HOURS`, default 24; `DRMS_PULL_CRON`, default `15 * * * *`), `apps/worker/src/main.ts` (use `DRMS_PULL_CRON`), `.env.example`

**Interfaces:**
```ts
export interface AlertEvaluation { opened: number; cleared: number; open: number }
export function evaluateOfflineAlerts(db: Db, opts: { now: Date; thresholdHours: number }): Promise<AlertEvaluation>
```

**Behaviour:**
- Candidates: `drms_equipment` rows with `missing_since is null`, `upper(status) <> 'DELETED'`, and `last_counter_received_time is not null` (they reported at least once).
- **Open** an alert when `last_counter_received_time < now - thresholdHours` and there's no open `offline` alert for that device: insert with `firstDetectedAt = now`, `lastSeenReportAt = last_counter_received_time`, `details = { thresholdHours }`.
- **Clear** an open alert when the device's `last_counter_received_time >= now - thresholdHours`: set `clearedAt = now`.
- A device that has gone missing (`missing_since is not null`) or been deleted keeps its open alert — don't clear it — because it's still not reporting.
- Return the counts. `runDrmsPull` includes them in its stats as `alertsOpened` / `alertsCleared` and leaves its own status logic unchanged.

- [ ] **Step 1: Write the failing test**

`alerts-evaluate.test.ts` with PGlite and `seedDrms`:
- a device reporting 2 h ago → no alert
- a device reporting 30 h ago → one open alert with `lastSeenReportAt` set
- running twice doesn't open a second alert (`opened` is 0 the second time)
- when that device reports again (update `last_counter_received_time` to now), the alert is cleared and `cleared` is 1
- after clearing, a later lapse opens a **new** alert (history preserved: 2 rows)
- a device that never reported (`last_counter_received_time is null`) never alerts
- a missing device with an open alert keeps it open

- [ ] **Step 2–4:** run (RED) → implement → run (GREEN).

- [ ] **Step 5: Wire it in**

In `drms-pull.ts`, after the missing-marking update and before the customers block:
```ts
  const alerts = await evaluateOfflineAlerts(db, { now: seenAt, thresholdHours });
```
Take `thresholdHours` from a new `DrmsPullDeps` field with a default of 24, so the test can inject it. Add `alertsOpened: alerts.opened, alertsCleared: alerts.cleared` to the stats. Update the existing drms-pull tests' stat assertions only where needed (they use `toMatchObject`, so most won't change).

In `env.ts` add:
```ts
  OFFLINE_ALERT_HOURS: z.coerce.number().int().positive().default(24),
  DRMS_PULL_CRON: z.string().min(1).default('15 * * * *'),
```
In `main.ts` use `env.DRMS_PULL_CRON` for the drms-pull schedule and pass `thresholdHours: env.OFFLINE_ALERT_HOURS` into the handler's `runDrmsPull` call. Update `.env.example`.

**Note:** hourly drms-pull also queues `link-run` hourly (that's the existing behaviour). That's acceptable: link-run is a single transaction over ~850 devices.

- [ ] **Step 6:** `npm test`, typecheck, lint, commit.

---

### Task 3A: DRMS alarm pull (waste toner, drums, imaging units)

**Why:** DRMS has no counters for waste toner, drums, imaging units, ITB or fuser. Those only arrive as **alarms** (`TO-00` waste bottle almost full/full, `TR-00` waste bottle delivery, `TP-00`/`TP-01` PartsLife 1st/2nd call for IU/DC/filter, `TN-00` toner near empty/empty, `TS-00` toner delivery). Verified live on 2026-09-18: 299 alarms over 3 days across the fleet. Sub-project 3 needs this data too, and the dashboard shows it per device.

**Files:**
- Modify: `packages/db/src/schema.ts` (+ `deviceAlarms`), generated `packages/db/drizzle/0002_alarms.sql`
- Modify: `packages/drms/src/schemas.ts`, `packages/drms/src/client.ts` (+ `listAlarms`), `packages/drms/src/client.test.ts`
- Create: `apps/worker/src/jobs/drms-alarms.ts` + test
- Modify: `apps/worker/src/env.ts` (`ALARMS_CRON`, default `*/30 * * * *`), `main.ts` (queue + schedule + handler), `packages/queue/src/index.ts` (`QUEUES.drmsAlarms = 'drms-alarms'`), `apps/worker/src/queue-options.ts`
- Modify: `packages/db/src/queries/device.ts` (+ `listDeviceAlarms`), `queries/fleet.ts` (+ consumable warning counts)

**Schema — `device_alarms`:**
- `alarmId text primary key` (DRMS `AlarmId` Guid — natural dedupe key)
- `drmsEquipmentId text not null references drms_equipment(drms_id)`
- `receivedTime ts not null`, `fcCode text`, `scCode text`, `description text`, `status text`, `totalCount bigint`, `totalColorCount bigint`, `raw jsonb not null`, `fetchedAt ts not null default now()`
- `category text` — derived on insert by `classifyAlarm()` (below), so the UI can filter without parsing descriptions
- Indexes: `(drmsEquipmentId, receivedTime desc)`, `(category, receivedTime desc)`, `(status)`

**`classifyAlarm(fcCode, description)` → `'toner' | 'waste' | 'parts' | 'service' | 'jam' | 'other'`** (pure, in `@mps/core`, tested):
- `TN-*`, `TS-*` → `toner`
- `TO-*`, `TR-*` → `waste`
- `TP-*` → `parts` (imaging units, drums, filters — the description carries which, e.g. `PartsLife(IU_M) 2nd Call`)
- `SC-*`, `SR-*`, `TV-*` → `service`
- `JF-*`, `FW-*` → `jam`
- anything else → `other`

**DRMS client — `listAlarms({ dateFrom, dateTo, pageNo })`:**
- `GET Equipment/Alarms?dateFrom=&dateTo=&pageNo=`, dates formatted `YYYY-MM-DD HH:mm:ss` UTC.
- **The API rejects a range longer than 1 day** (verified: HTTP 400 `difference between dateFrom and dateTo exceeded - maximum allowed is 1 day(s)`). The client takes one range and validates it's ≤ 24 h, throwing `HttpError` otherwise; the **job** splits longer catch-ups into per-day calls.
- Response shape: an array of `{ Id, Alarms: [{ AlarmId, ReceivedTime, FcCode, ScCode, Description, Status, TotalCount, TotalColorCount }] }` — one entry per equipment. Flatten it, keeping the equipment `Id`.
- Method key for the limiter: `Equipment/Alarms`. Paging is the usual 1,000-per-page rule.
- Test with fake fetch: the date format sent, flattening, the 1-day guard, paging, 429 behaviour.

**Job `runDrmsAlarms(deps)`:**
- Window: from the last successful `drms-alarms` run's `startedAt` minus 30 min (overlap), to `now`. First run: last 24 h.
- Split the window into ≤ 24 h chunks, oldest first, max 7 chunks per run (a longer gap catches up over several runs).
- Insert with `onConflictDoNothing` on `alarmId`, in chunks of 500. Skip alarms whose equipment isn't in `drms_equipment` (log the count) — the FK would otherwise fail.
- Stats: `fetched`, `inserted`, `skippedUnknownDevice`, `windows`, and a per-category breakdown.
- `RateLimitError`/`AuthError` → stop, return `partial` (never retry a 429).

**Queries:**
- `listDeviceAlarms(db, drmsId, opts?: { limit?: number; categories?: string[] })` → recent alarms for a device, newest first.
- `getConsumableWarnings(db)` → per device, the latest open-ish `waste` and `parts` alarms in the last 30 days, for the fleet page count "N devices with waste/parts warnings".

**Note on status:** most alarms currently come back as `EquipmentDiscovered` (DRMS won't deliver them to an ERP because the device isn't registered). Store every alarm regardless of status; the UI filters. `ReadyForErpDelivery` is what sub-project 3 will act on.

- [ ] **Step 1:** schema + migration (`drizzle-kit generate --name alarms`), with a test that the same `alarmId` inserted twice doesn't duplicate.
- [ ] **Step 2:** `classifyAlarm` in `@mps/core` (RED → GREEN, table-driven test over the real codes above).
- [ ] **Step 3:** DRMS client `listAlarms` with fake-fetch tests (RED → GREEN).
- [ ] **Step 4:** the job with PGlite tests: window calculation from the last run, day-splitting, dedupe on rerun, unknown-device skip, partial on rate limit.
- [ ] **Step 5:** wire the queue, schedule (`ALARMS_CRON`, default every 30 min — DRMS refreshes about every 27), queue options (expire 1800 s), handler.
- [ ] **Step 6:** the two queries + tests.
- [ ] **Step 7: Manual check** (read-only, real API): run the job once via the send-job script; confirm rows land, categories look right, and a second run inserts 0 new rows.
- [ ] **Step 8:** `npm test`, typecheck, lint, commit.


---

### Task 3B: Vantage sales order pull (what toner was sent, and when)

**Why:** operators need to see, on the device, whether a toner has already gone out and when the last one went — before anyone orders another. Sub-project 3's duplicate check will use the same tables. This task is **read-only**: no order is ever created here.

**Files:**
- Create: `apps/web/src/components/colour-chip.tsx` (+ test for its label/ordering helper)
- Modify: `packages/db/src/schema.ts` (+ `vantageSalesOrders`, `vantageSalesOrderLines`), generated migration
- Modify: `packages/vantage/src/client.ts` (+ `listSalesOrders`), `client.test.ts`
- Create: `apps/worker/src/jobs/vantage-orders.ts` + test
- Modify: `apps/worker/src/{env,main,handlers,queue-options}.ts`, `packages/queue/src/index.ts` (`QUEUES.vantageOrders = 'vantage-orders'`), `.env.example`
- Modify: `packages/db/src/queries/device.ts` (+ `listDeviceOrders`), `queries.test.ts`
- Modify: `apps/web/src/app/(app)/devices/[id]/page.tsx` (+ an orders card)

**Schema (mirrors the existing vantage_* tables — keep `raw jsonb`, `modified_date`, `deleted_date`, `synced_at`):**
- `vantage_sales_orders`: `vantageId int pk`, `reference`, `orderDate date`, `completedDate date`, `isOnHold bool`, `isNonStock bool`, `typeId int`, `typeName text`, `createdByMps bool not null default false`, `vantageEquipmentId int`, `contractId int`, `customerSellToId int`, `customerShipToId int`, `raw`, `modifiedDate`, `deletedDate`, `syncedAt`. Index on `(vantageEquipmentId, orderDate desc)`.
- `vantage_sales_order_lines`: `vantageId int pk`, `salesOrderId int not null`, `vantageEquipmentId int`, `itemId int`, `itemPartNumber text`, `itemDescription text`, `quantity numeric`, `returnedDate date`, `comment text`, `raw`, `syncedAt`. Index on `(salesOrderId)` and `(vantageEquipmentId, itemPartNumber)`.
- No foreign key to `vantage_equipment`: an order can reference equipment we haven't synced. Filter by join instead.

**Vantage client — `listSalesOrders({ since?, includeDeleted? })`:**
- Entity `SalesOrder`, `$expand=Lines($expand=Item($select=Id,PartNumber,Description)),Type($select=Id,Name)`.
- The same paging, `deleteddate eq null` guard and incremental filter as `listEquipment` (reuse `odataList` and `listFilters`).
- Test with fake fetch: the expand string, the incremental filter, flattening lines.

**Job `runVantageOrders(deps)`:**
- Same shape as `vantage-pull`: incremental on the last successful run minus the standard overlap; weekly full refresh is unnecessary here (orders are append-mostly) — instead, when there's no previous success, pull the **last 24 months** using `orderdate ge <date>` so the first run doesn't drag in a decade of history.
- Upsert orders and lines in chunks of 500. Lines are replaced per order: delete the order's existing lines, insert the fetched ones, inside the same transaction as that order's upsert.
- Stats: `orders`, `lines`, `full` (1/0). `RateLimitError`/`AuthError` → `partial`, never retried.
- Schedule `ORDERS_CRON`, default `40 2 * * *` (after the nightly Vantage pull), queue options expiry 3600 s.

**Colour of an order line (`classifyOrderLine`, pure, in `@mps/core`, tested):**
- Line `Details` is filled in even for `MISC` parts (the user's case: a machine another reseller supplies, ordered as MISC). Real examples: `"Xerox B310 Black Toner"`, `"Konica Minolta C3351i Black Toner - CMYK"`, `"Olivetti MF304 Magenta Toner"`, `"Konica Minolta C3351i Waste Toner"`.
- `classifyOrderLine({ details, itemDescription, partNumber })` → `{ colour: 'black' | 'cyan' | 'magenta' | 'yellow' | 'waste' | 'unknown'; source: 'details' | 'item' | 'none' }`.
- Rule order: match `Details` first (case-insensitive, whole words), then the item description, then give up. Colour detection is a convenience for the per-colour summary and sub-project 3's duplicate check; the line text is always shown as-is, so an unrecognised line is never hidden. `waste` wins over a colour when both appear (e.g. "Waste Toner"). `Black` also matches a standalone `K`/`BK`. A line like "Black Toner - CMYK" is `black` (the leading colour word wins over the trailing `CMYK`).
- Store the result on `vantage_sales_order_lines` as `colour text` and `colour_source text`, computed on insert, so queries can filter without re-parsing.
- Test it with the exact strings above plus a few awkward ones (no colour at all, two colours, "Magenta/Yellow").

**Query `listDeviceOrders(db, vantageEquipmentId, opts?: { limit?: number })`:**
- Orders for that equipment, newest first, each with its lines; also match lines whose own `vantageEquipmentId` is the device even when the order header points elsewhere (both link paths exist in Vantage).
- Return `{ orders: [...], lastByColour: Record<colour, { partNumber, description, quantity, orderDate, reference, orderOpen: boolean }> }` — the most recent non-returned line per colour, so the device page can answer "when did black last go out, and is it still open?". Include `waste` as a colour.

**Order status (confirmed against live data 2026-09-18):** `CompletedDate` is the open/closed flag — null = **Open**, set = **Completed**; `IsOnHold` is separate. `Type.Name` is either `Consumable order` or `Equipment deal`, so toner orders filter on the former. There are ~164 open orders today. Some orders have a null `EquipmentId` and generic parts (e.g. `MISC`), so every display path must tolerate that.

**Decision (user, 2026-09-18):** sub-project 3 will create **real** Vantage sales orders (not provisional ones). Nothing extra is needed here: an order created by the app appears through this same pull and shows as **Open** until it's completed in Vantage. Add a `created_by_mps boolean not null default false` column to `vantage_sales_orders` now, so sub-project 3 can mark the orders it raises and the dashboard can badge them as "raised here".

**Device page — "Consumable orders" card (place it under the alarms card):**
- The same chip component is reused in the per-colour headline. Headline: one small row per colour (K/C/M/Y and waste) showing the last date sent, quantity and order reference, with an "Open" badge when that order is still open. Colours with no history show "—".
- Table of the last 10 orders: date, reference, type, status (Open / Completed / On hold, derived from `completedDate`/`isOnHold`), and a "returned" marker where set.
- **Colour chips per order row.** Beside the reference, render one small chip per line, in line order: a filled dot in the toner colour (cyan `#29ABE2`, magenta `#E5177B`, yellow `#F5C400`, black `#111111`) with the quantity next to it when it's more than 1 — so a black+magenta order shows two chips, and "black ×2" shows `●2`. Waste uses the grey waste colour with a hollow ring so it doesn't read as black. A line whose colour can't be determined gets a grey outline chip marked `?`. Every chip carries the line's full text as its `title`, and the chips have text labels for screen readers (`Black ×2`), so colour isn't the only signal.
- **Each line shows its `Details` text verbatim** (e.g. "Xerox B310 Black Toner", "Konica Minolta C3351i Waste Toner") with the part number and quantity beside it — this is what makes `MISC` lines readable, since those are machines another reseller supplies. Fall back to the item description when `Details` is empty.
- Status badges: **Open** (amber) when `completedDate` is null, **Completed** (green) when set, **On hold** (grey) when `isOnHold`. Orders with `createdByMps` get a small "raised here" tag.
- Devices with no orders show a single muted line, like the other cards.

- [ ] **Step 1:** schema + migration, with a test that lines are replaced (not duplicated) when an order is re-pulled.
- [ ] **Step 2:** client method + fake-fetch tests (RED → GREEN).
- [ ] **Step 3:** job + PGlite tests: first run's 24-month window, incremental window, line replacement, partial on rate limit.
- [ ] **Step 4:** wiring (queue, schedule, handler, env).
- [ ] **Step 5:** `listDeviceOrders` + tests.
- [ ] **Step 6:** the device-page card.
- [ ] **Step 7: Manual check** (read-only, real API): run the job once; report counts only (orders, lines, devices with orders) — no customer names; open a device that has orders and confirm the card matches the database.
- [ ] **Step 8:** `npm test`, typecheck, lint, `next build`, commit.


---

### Task 4: Web app scaffold, theme, session auth, login

**Files:**
- Create: `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `components.json`
- Create: `apps/web/src/app/layout.tsx`, `globals.css`, `src/app/login/page.tsx`, `src/app/login/actions.ts`, `src/app/(app)/layout.tsx`
- Create: `apps/web/src/lib/session.ts`, `auth.ts`, `db.ts`, `format.ts`
- Test: `apps/web/src/lib/auth.test.ts`
- Modify: root `vitest.config.ts` (add `apps/web/src/**/*.test.ts`)

**Setup commands:**
```bash
cd /c/dev/mps-brain
npx create-next-app@latest apps/web --ts --app --tailwind --eslint --src-dir --import-alias "@/*" --no-turbopack --use-npm --skip-install
npm install
npm i --workspace=apps/web iron-session@^8 @mps/db@* @mps/queue@* @mps/core@*
npm i --workspace=apps/web -D @types/node
cd apps/web && npx shadcn@latest init -d && npx shadcn@latest add button input label card table badge select dialog dropdown-menu sonner switch && cd ../..
```
If `create-next-app` asks anything interactively, answer with the flags above; if a flag is rejected by the installed version, adapt and note it.

`apps/web/next.config.ts` must transpile the workspace packages and keep native deps external:
```ts
import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  transpilePackages: ['@mps/db', '@mps/core', '@mps/queue', '@mps/drms', '@mps/vantage'],
  serverExternalPackages: ['@node-rs/argon2', 'pg', 'pg-boss'],
  output: 'standalone',
};
export default nextConfig;
```

**Theme:** in `globals.css`, define the palette from Global Constraints as CSS variables on `:root` and map Tailwind v4 tokens with `@theme inline`. Light mode only (the mockups are light). Set `body { background: var(--page); color: var(--text); }`.

**Session:**
```ts
// src/lib/session.ts
import { getIronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';

export interface SessionData { userId?: number; username?: string; role?: 'admin' | 'operator' }
const options: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: 'mps_session',
  cookieOptions: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 12 },
};
export const getSession = async () => getIronSession<SessionData>(await cookies(), options);
```
```ts
// src/lib/auth.ts
export async function requireUser(): Promise<SessionData & { userId: number }>   // redirect('/login') when missing
export async function requireAdmin(): Promise<SessionData & { userId: number }>  // redirect('/') when not admin
export async function authenticate(db: Db, username: string, password: string): Promise<{ id: number; username: string; role: 'admin'|'operator' } | null>
```
`authenticate` looks the user up by username, requires `active`, and uses `verifyPassword` from `@mps/db`. It must take the same time for a missing user as a wrong password (verify against a dummy hash when the user doesn't exist).

**Login page:** centred card, "MPS Dashboard" wordmark, username and password fields, a server action that calls `authenticate`, sets the session and redirects to `/`. On failure it re-renders with "Incorrect username or password" (never say which part was wrong).

**App shell** (`src/app/(app)/layout.tsx`): the mockup's sidebar — wordmark with a printer icon; nav items Fleet overview, Devices, Alerts (with a count badge), Link issues (count badge), Admin; the signed-in user at the bottom with a sign-out button. Main area has a light background and a max width of ~1400px.

- [ ] **Step 1:** scaffold with the commands above, add the config, theme and shell.
- [ ] **Step 2: Write the failing test** for `authenticate` (`apps/web/src/lib/auth.test.ts`, PGlite + a seeded user): correct password → user; wrong password → null; unknown user → null; inactive user → null.
- [ ] **Step 3:** run (RED) → implement → run (GREEN).
- [ ] **Step 4: Manual check:** `npm run dev -w @mps/web`, open `http://localhost:3000`, confirm you're redirected to `/login`, log in with the seeded admin from `.env`, and land on an empty shell. Sign out works.
- [ ] **Step 5:** `npm test`, typecheck, lint, commit.

---

### Task 5: Fleet overview page + shared components

**Files:**
- Create: `apps/web/src/components/{StatCard,TonerBar,StatusDot,PageHeader,SearchInput,Pagination}.tsx`
- Create: `apps/web/src/app/(app)/page.tsx`, `apps/web/src/app/(app)/devices/page.tsx`
- Test: `apps/web/src/components/toner.test.ts` (pure helpers only)

**Interfaces:**
```ts
export type TonerState = 'ok' | 'low' | 'critical' | 'unknown';
export function tonerState(pct: number | null): TonerState   // null → unknown, <5 critical, <20 low, else ok
export function deviceStatusLabel(row: DeviceRow): { text: string; tone: 'ok' | 'warn' | 'critical' | 'muted' }
```
`deviceStatusLabel` rules, in order: not linked → "Not linked" (muted); `offline` → "Offline · Nh" (critical); any toner critical → "Toner critical" (critical); any toner low → "Toner low" (warn); no counters yet → "No counters" (muted); else "Online" (ok).

**Fleet overview** mirrors the mockup:
- Header: "Fleet overview", subtitle "N devices · M customers · synced <relative time>", a search box (submits to `/devices?search=`).
- Four stat cards (plus a fifth once Task 3A lands: **Consumable warnings** — devices with a waste-bottle or parts-life alarm in the last 30 days): **Total devices** (with "X monitored · Y linked" underneath), **Needs toner** (with "A critical · B low"), **Offline** (with "not reported in 24h"), **Open link issues** (with the top type).
- "Fleet toner health" bar: one stacked bar of healthy/low/critical cartridge counts with a legend, exactly like the mockup.
- Device table (first 8 rows, "View all devices" link): device name with customer underneath, model with the status line under it, five toner bars (C/M/Y/K and waste-if-present — waste isn't in DRMS, so render the four colours and leave the waste column out), and pages/month (leave "—" for now; volume history arrives with sub-project 2's meter sync).
- `/devices` is the same table, full width, with search, filter tabs (All / Needs toner / Offline / Not linked) and pagination.

Both pages are server components: `const db = getDb()` then the Task 2 queries. No client state except the search box and filter links.

- [ ] **Step 1:** write `toner.test.ts` for `tonerState` and `deviceStatusLabel` (including the ordering rules), see it fail, implement the helpers, see it pass.
- [ ] **Step 2:** build the components and both pages.
- [ ] **Step 3: Manual check** against real data: `npm run dev -w @mps/web` → the overview shows ~836 devices, ~830 linked, the offline count, and 1,001 open issues; the table renders toner bars for devices that have snapshots and "No counters" for the rest; search finds a device by serial; each filter tab changes the rows.
- [ ] **Step 4:** `npm test`, typecheck, lint, commit.

---

### Task 6: Device detail page

**Files:**
- Create: `apps/web/src/app/(app)/devices/[id]/page.tsx`, `apps/web/src/components/{CounterTable,ToneBadge}.tsx`
- Modify: device rows in the fleet table link to `/devices/<drmsId>`

**Layout, following the mockup:**
- Breadcrumb `Fleet overview / <customer> / <device>`; title = DRMS name with a status badge; subtitle `<model> · Serial <serial> · <DRMS status> · COM <server>`.
- **Toner levels card:** one tile per colour with the percentage, a bar and the state label; "Read <relative time>" from the snapshot's `received_time`. No days-left forecast yet (needs usage history — sub-project 2/3); leave the space for it.
- **Meters card:** Black, Colour and Scan readings from the latest snapshot, plus the reading date.
- **Counter history:** a table of the last 30 snapshots for the three meter counters (date, black, colour, scan, plus deltas). A chart can come later; the mockup's bar chart needs monthly aggregates from sub-project 2.
- **Right column:** "Links" card (Vantage equipment id, asset number, customer, contract ref, link method, linked date, with a link to the issues queue if unlinked); "Record" card (DRMS id, ERP id, CSRC id, communication type, registration and initial connection times, last counter time); "Raw data" collapsible showing the DRMS and Vantage `raw` JSON (admins only).
- **Consumables & alarms card:** the device's recent alarms from `listDeviceAlarms` (Task 3A), grouped by category with the newest first — waste toner bottle, parts life (imaging unit, drum, filter) and toner events. Show code, description, date and status. Hide `jam` and `service` categories behind a "Show all" toggle (the user doesn't want them by default).
- If the device has an open offline alert, show a banner at the top with "Not reported since …" and an acknowledge button (the action lives in Task 8; import it).

- [ ] **Step 1:** build the page from the Task 2 queries (`getDevice`, `getLatestCounters`, `getCounterHistory`).
- [ ] **Step 2: Manual check:** open a device that has counters (for example serial `A93E021244196`) and confirm toner percentages and meter totals match the values in the counter table; open one without counters and confirm it degrades gracefully.
- [ ] **Step 3:** typecheck, lint, commit.

---

### Task 7: Link issues queue

**Files:**
- Create: `apps/web/src/app/(app)/issues/page.tsx`, `actions.ts`, `apps/web/src/components/LinkPicker.tsx`
- Create: `packages/db/src/queries/issue-actions.ts` (the write logic, so it can be tested without React)
- Test: `packages/db/src/queries/issue-actions.test.ts`

**Interfaces:**
```ts
export function manualLink(db: Db, args: { drmsId: string; vantageId: number; userId: number; now?: Date }): Promise<void>
export function unlinkDevice(db: Db, args: { drmsId: string; userId: number; reason?: string; now?: Date }): Promise<void>
export function setIssueStatus(db: Db, args: { issueId: number; status: 'open' | 'ignored' | 'resolved'; userId: number; now?: Date }): Promise<void>
```
**Rules:**
- `manualLink` runs in a transaction: close any active link for that DRMS device **and** any active link pointing at that Vantage equipment (`unlinkedReason: 'manual_relink'`), then insert the new link with `method: 'manual'` and `linkedBy: userId`. It must respect both partial unique indexes, so close before inserting.
- After a manual link, resolve any open issue whose `drmsEquipmentId` or `vantageEquipmentId` matches and whose type is `no_match_drms`, `no_match_vantage`, `serial_ambiguous`, `duplicate_target` or `erp_serial_disagree` (set `status: 'resolved'`, `resolvedBy`, `resolvedAt`).
- `unlinkDevice` closes the active link with the given reason and leaves issues alone.
- `setIssueStatus` sets the status, plus `resolvedBy`/`resolvedAt` when resolving.
- Manual links must survive `link-run` — that's already true (`computeLinks` keeps `manual`), and the test proves it by running `runLinkRun` after a manual link.

**Page:** filter tabs by issue type with counts (from `countsByType`), a table of issues (type badge, device, Vantage record, details, first/last seen), and per-row actions: **Link to…** (opens `LinkPicker`, a dialog with a search box that calls a server action to search Vantage equipment, then submits the chosen id), **Ignore**, **Unlink** (only for `link_broken` / `customer_mismatch` rows that still have a link). `no_match_vantage` rows are filtered out by default — there are ~1,000 of them and they're expected — with a tab to show them.

- [ ] **Step 1:** write `issue-actions.test.ts` (PGlite): manual link closes the old link and creates a manual one; linking a Vantage record that another device holds closes that link too; open issues resolve; `runLinkRun` afterwards keeps the manual link; unlink sets the reason; ignore/resolve set status.
- [ ] **Step 2:** RED → implement → GREEN.
- [ ] **Step 3:** build the page and actions (`'use server'`, `revalidatePath('/issues')`, `requireUser()` in every action).
- [ ] **Step 4: Manual check:** with real data, resolve one `no_match_drms` issue by linking it to the right Vantage equipment; confirm the device page shows the manual link, and that triggering `link-run` (Admin, Task 9) leaves it alone.
- [ ] **Step 5:** `npm test`, typecheck, lint, commit.

---

### Task 8: Alerts page

**Files:**
- Create: `apps/web/src/app/(app)/alerts/page.tsx`, `actions.ts`
- Create: `packages/db/src/queries/alert-actions.ts` + test

**Interfaces:**
```ts
export function acknowledgeAlert(db: Db, args: { alertId: number; userId: number; now?: Date }): Promise<void>
```
Acknowledging sets `acknowledgedBy`/`acknowledgedAt` and doesn't clear the alert (only the device reporting again does that, via the worker).

**Page:** "Alerts" with tabs Open / Acknowledged / Cleared. Each row: device (linking to the detail page), customer, "Not reported since <date>" with the gap in hours or days, when it was first detected, and an Acknowledge button. An explanatory line at the top: "A device alerts when it has reported counters before but hasn't for more than 24 hours. DRMS collects counters once a day, so a device that misses one collection can show as 24–48 hours stale."

- [ ] **Step 1:** test `acknowledgeAlert` (PGlite): sets the fields, doesn't clear; acknowledging twice is harmless.
- [ ] **Step 2:** RED → implement → GREEN → build the page.
- [ ] **Step 3: Manual check:** with real data the page lists devices whose last counter time is old (several exist, e.g. one last reporting in March). Acknowledge one and confirm it moves tab.
- [ ] **Step 4:** `npm test`, typecheck, lint, commit.

---

### Task 9: Admin — users, counter names, job runs

**Files:**
- Create: `apps/web/src/app/(app)/admin/{page,users/page,counters/page,jobs/page}.tsx` + `actions.ts`
- Create: `packages/db/src/queries/admin-actions.ts` + test
- Modify: `packages/queue/src/index.ts` if a helper is needed to send a job by name

**Interfaces:**
```ts
export function createUser(db: Db, args: { username: string; password: string; role: 'admin' | 'operator' }): Promise<number>
export function setUserActive(db: Db, args: { userId: number; active: boolean }): Promise<void>
export function resetPassword(db: Db, args: { userId: number; password: string }): Promise<void>
export function setCounterCategory(db: Db, args: { name: string; category: 'meter' | 'supply' | 'other' | null }): Promise<void>
```
Password rules: at least 12 characters; hash with `hashPassword` from `@mps/db`; usernames are unique and stored lower-case.

**Pages:**
- **Users:** table (username, role, active, created), "Add user" dialog, activate/deactivate, reset password. Admin only. A user can't deactivate themselves.
- **Counter names:** table of all 83 names with sample value, first seen and a category dropdown (meter / supply / other / unset). Pre-set the three meter counters and four toner levels via a "Set defaults" button that applies the spec's mapping.
- **Jobs:** the last 20 `sync_runs` (job, started, duration, status, stats summary, error) plus buttons to trigger each job. Triggering uses `createBoss(process.env.DATABASE_URL!, 'client')`, `boss.start()`, `boss.send(queue, {})`, `boss.stop()` inside the server action. Also show the DRMS token expiry from `app_state.drms_token_expiry`, with a warning when it's within 14 days.

- [ ] **Step 1:** test `admin-actions` (PGlite): create user (hash stored, not the password; duplicate username rejected), deactivate, reset password (the old one stops working, the new one works), set/clear counter category.
- [ ] **Step 2:** RED → implement → GREEN → build the pages.
- [ ] **Step 3: Manual check:** create an operator, log in as them, confirm the admin pages are not reachable; set a counter category and see it on the device page; trigger `link-run` and watch a new row appear in the runs table.
- [ ] **Step 4:** `npm test`, typecheck, lint, commit.

---

### Task 9A: Follow-ups from the task reviews (aggregates, alarm codes, unlink audit)

Small, independent fixes collected from earlier reviews. Each has its own test.

**Files:**
- Modify: `packages/db/src/queries/fleet.ts` (+ `getTonerHealth`, `getCustomerCount`), `issues.ts` (+ `getIssueCounts`), `packages/db/src/queries/queries.test.ts`
- Modify: `apps/web/src/app/(app)/page.tsx` (use the aggregates; drop the 5,000-row scan)
- Modify: `packages/core/src/alarms.ts` + test (add the `TQ` prefix)
- Modify: `packages/db/src/schema.ts` (+ `device_links.unlinked_by`), generated migration, `packages/db/src/queries/issue-actions.ts` (+ test)
- Modify: `apps/web/src/components/search-input.tsx`

**1. Overview aggregates (Important, from the Task 5 review).** The fleet page reads up to 5,000 device rows to tally cartridges, count customers and order its preview. Past that cap it would silently truncate.
- `getTonerHealth(db)` → `{ healthy: number; low: number; critical: number; cartridges: number; devices: number }`, computed in SQL from the latest snapshot per device, using the same 5%/20% thresholds.
- `getCustomerCount(db)` → the number of distinct linked Vantage customers among monitored devices.
- `getIssueCounts(db)` → `countsByType` without fetching any issue rows.
- The overview then calls these three plus `listDevices` with a small limit for its 8-row preview. Keep the preview's "most urgent first" ordering correct — do the ordering in SQL, not in JS over a large array.
- Tests: assert the same numbers the current page produces for the shared fixture.

**2. `TQ-*` alarm prefix (from the Task 6 review).** A real drum alarm (`TQ-10 PartsLife(DC_K)`) currently classifies as `other`. Add `TQ` to the `parts` prefixes in `classifyAlarm`, with a test case using that exact code.

**3. `unlinked_by` (from the Task 7 review).** `unlinkDevice` takes a `userId` but can't store it. Add `unlinkedBy: integer('unlinked_by').references(() => users.id)` to `device_links`, generate an additive migration, and persist it in `unlinkDevice`. Test that a manual unlink records who did it, and that the worker's automatic unlinks leave it null.

**4. Clear-search link (Minor, Task 5 review).** `SearchInput`'s "Clear search" link drops the active filter tab. Make it keep the other query parameters.

- [ ] **Step 1:** TDD each item in order (1 → 4), each with its failing test first.
- [ ] **Step 2:** `npm test`, `npm run typecheck`, `npm run lint`, `next build`.
- [ ] **Step 3: Manual check:** the fleet overview shows the same numbers as before the change (836 devices, the same toner health split and customer count), with no full scan.
- [ ] **Step 4:** commit.


---

### Task 9C: "Offline" means "no meter reading" — outage awareness

**Why (user, 2026-09-18):** the dashboard showed 35 devices as **Offline** while CSRC showed them online. Our signal is `LastCounterReceivedTime` older than 24 h, which means "DRMS collected no meter reading", not "the device is unreachable". DRMS collects counters about once a day, and collection had not run at all since 17 Sep 12:01 UTC — so every device that ever reported looked offline at once. The user approved all three changes below; the 35 open alerts were deleted so they can be re-evaluated.

**Files:** `packages/db/src/queries/{fleet,devices,device,alerts}.ts`, `packages/core` (a small pure helper), `apps/worker/src/jobs/alerts-evaluate.ts` (+ tests), `apps/web/src/components/toner.ts` + the pages that use the label, `apps/web/src/app/(app)/{page,alerts/page,devices/[id]/page}.tsx`.

**1. Rename the concept.** Everywhere a user can see it, "Offline" becomes **"No meter reading"** (stat card: *No meter reading · in the last 24h*; device status line: *No meter reading · 31h*; alerts page title and row text). The query field names may stay as they are, but add a doc comment on each saying what it really means. Keep the URL filter value `offline` so existing links work, and label the tab "No meter reading".

**2. Detect a fleet-wide collection outage.**
- New query `getCollectionStatus(db)` → `{ newestReadingAt: Date | null; devicesExpectingReadings: number; devicesStale: number; outage: boolean }`. `outage` is true when **every** device that has ever reported is stale (`devicesStale === devicesExpectingReadings && devicesExpectingReadings > 0`).
- Fleet overview: when `outage`, show a full-width amber banner above the cards — "No meter readings received since {date}. DRMS collects counters about once a day; this affects every device, so it looks like a collection problem rather than a device problem." The "No meter reading" stat card then shows "— (collection stopped)" instead of a count of devices.
- Alerts page: the same banner, above the tabs.
- **The worker must not open per-device alerts during an outage.** In `evaluateOfflineAlerts`, compute the same outage condition first; when it holds, skip opening (still clear alerts for devices that reported). Return `skippedDueToOutage: true` in the evaluation, and include it in the job stats. Existing open alerts are left alone.
- Tests: an all-stale fleet opens nothing and reports the outage; a mixed fleet (some fresh, some stale) opens alerts as before; the transition from outage to normal opens the genuinely stale ones on the next run.

**3. Last alarm as a second signal of life.**
- `DeviceRow`/`DeviceDetail` gain `lastAlarmAt` (max `device_alarms.received_time` per device — the alarm feed refreshes every ~27 minutes, so a recent alarm proves the device is talking to CSRC even with no meter reading).
- Device page: show "Last alarm: {relative time}" in the record card, and in the offline banner add "but an alarm arrived {relative time}, so the device is reaching CSRC" when `lastAlarmAt` is within 24 h.
- Devices list: when a device has no recent meter reading **but** a recent alarm, the status line reads "No meter reading · reaching CSRC" in amber rather than red.
- Keep it cheap: one grouped aggregate joined like the snapshot pivot, not a per-row query.

- [ ] **Step 1:** `getCollectionStatus` + the outage rule in `evaluateOfflineAlerts` (TDD, both directions of the transition).
- [ ] **Step 2:** `lastAlarmAt` in the queries (TDD).
- [ ] **Step 3:** the renames and the banner across the pages.
- [ ] **Step 4:** `npm test`, typecheck, lint, `next build`.
- [ ] **Step 5: Manual check** against the live DB — today the fleet is in a genuine outage, so the banner must appear, the stat card must not claim 35 devices are offline, and a worker run must open **no** alerts. Report what you saw.
- [ ] **Step 6:** commit.


---

### Task 9B: Full test pass before deploy

Nothing new is built here. This is a deliberate, written-up test of the whole Foundation against real data, run before the stack is containerised. Two parts, both required by the user.

**Output:** `docs/TEST-REPORT-2026-09-18.md`, committed. Every check gets a line: what was run, what was expected, what happened, pass/fail. Failures become findings for the controller to rule on, not silent fixes — fix only what is clearly broken and small, and list anything larger.

**Part A — end-to-end worker run (real APIs, read-only against DRMS/Vantage)**
1. Start the worker (`npm run dev -w @mps/worker`). Confirm it migrates, marks stale runs, seeds nothing unexpected, and logs `[worker] ready`.
2. Trigger each job once via `apps/worker/scripts/send-job.ts`, in this order, waiting for each: `vantage-pull` (full), `drms-pull`, `link-run`, `drms-alarms`, `drms-snapshot`.
3. For each: record `sync_runs.status`, duration and `stats`. Nothing may be `failed`. Explain every `partial`.
4. Verify afterwards with SQL counts only (no customer names in the report): devices by DRMS status, Vantage equipment, active links by method, open issues by type, snapshots, counter names, alarms by category, open/cleared alerts.
5. Re-run `drms-pull` and `drms-alarms` a second time and confirm they're idempotent (no duplicate alarms; `markedMissing` stays 0; alert counts stable).
6. Confirm the queue schedules exist with the expected crons and timezone, then **stop the worker** and confirm no node process is left listening.

**Part B — page-by-page UI walkthrough (real data)**
Run `npm run dev -w @mps/web`. Sign in as admin. Walk every page and every action, recording what you saw:
- Login: wrong password rejected; signed-out access to each route redirects; sign-out works.
- Fleet overview: every number cross-checked against a direct SQL count. The toner health bar adds up. The preview's ordering is sensible.
- Devices: search by serial, by customer, and a term with no matches; each filter tab; pagination including the last page and an out-of-range page.
- Device detail: one device with counters (cross-check toner and meters against SQL), one without, one with alarms of several categories, one offline, one unlinked, one with a customer mismatch. The alarms toggle. The raw-data block as admin.
- Link issues: each tab and its count; search in the link picker; ignore then reopen one issue; link a device by hand **only if a genuinely correct pairing exists** — otherwise use a deliberately wrong pair, verify, then undo it and say so.
- Alerts: with at least one alert present (insert one if the worker hasn't opened any, then remove it); acknowledge it; check the tab counts.
- Admin: create an operator; **sign in as that operator in a separate browser context** and confirm every admin page redirects and a direct action POST is refused; set a counter category; "Set defaults"; trigger `link-run` and see the run appear. Delete the test user afterwards.
- Check the browser console on every page: no errors.
4. Note anything that looks wrong, ugly or confusing against the mockups, even if it isn't a bug.

**Rules:** never read or print `.env`; no customer names in the report (counts, serials and DRMS ids are fine); leave the database as you found it apart from changes that are genuinely correct (say which); never call DRMS `EquipmentRequest/*`.

- [ ] **Step 1:** Part A, writing results as you go.
- [ ] **Step 2:** Part B, same.
- [ ] **Step 3:** summarise: what works, what's broken, what's ugly. Commit the report.


---

### Task 10: Docker images, compose stack, Portainer deploy

> **Deferred (user, 2026-09-18):** the deploy now happens **after** the remaining sub-projects, not at the end of Part 2. Finish Part 2 (9C, 9B), then sub-project 3 (replenishment and real Vantage orders), then the rest, and deploy when the app is doing what the user wants.

**Files:**
- Create: `Dockerfile.web`, `Dockerfile.worker`, `.dockerignore`, `docker-compose.yml`, `docs/DEPLOY.md`
- Modify: `docs/HANDOFF.md` (point at DEPLOY.md), `.env.example`

**Constraints from the Part 1 final review — the plan must honour all of these:**
- **`worker` runs exactly one replica.** The DRMS rate limiter and its 429 cooldown live in process memory, and `failStaleRuns` marks every `running` row failed at startup. Two replicas would double the request rate and fail each other's runs. Document this in `docs/DEPLOY.md` and set `deploy.replicas: 1`.
- **Only the worker runs migrations.** The web image must not run them (no advisory lock).
- **`stop_grace_period: 45s`** on the worker, because `boss.stop` waits up to 30 s.
- The images must include `packages/*/src`, `packages/db/drizzle` (the migrations folder is resolved relative to the source file) and `tsx` at runtime for the worker.
- Postgres data lives in a named volume. Don't publish 5432 outside the stack.

**`docker-compose.yml`** (three services):
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-mps}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set in stack env}
      POSTGRES_DB: ${POSTGRES_DB:-mps}
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-mps}']
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
  worker:
    build: { context: ., dockerfile: Dockerfile.worker }
    environment: [ DATABASE_URL, DRMS_BASE_URL, DRMS_TOKEN, VANTAGE_BASE_URL, VANTAGE_USER, VANTAGE_PASS, VANTAGE_API_VERSION, LINK_ERP_ID_FIELD, LINK_CUSTOMER_ERP_FIELD, SNAPSHOT_CRON, DRMS_PULL_CRON, OFFLINE_ALERT_HOURS, TZ_SCHEDULE, ADMIN_USERNAME, ADMIN_PASSWORD ]
    depends_on: { postgres: { condition: service_healthy } }
    stop_grace_period: 45s
    deploy: { replicas: 1 }
    restart: unless-stopped
  web:
    build: { context: ., dockerfile: Dockerfile.web }
    environment: [ DATABASE_URL, SESSION_SECRET, OFFLINE_ALERT_HOURS ]
    depends_on: { postgres: { condition: service_healthy }, worker: { condition: service_started } }
    ports: ['3000:3000']
    restart: unless-stopped
volumes: { pgdata: {} }
```
**`Dockerfile.worker`:** `node:24-slim` (not alpine — `@node-rs/argon2` prebuilds are glibc), copy the root manifests and every workspace `package.json`, `npm ci`, copy `packages/`, `apps/worker/`, `tsconfig.base.json`, then `CMD ["npx", "tsx", "apps/worker/src/main.ts"]`.
**`Dockerfile.web`:** multi-stage — build with `npm ci` plus `npm run build -w @mps/web` (Next standalone output), then a runtime stage copying `.next/standalone`, `.next/static` and `public`. `CMD ["node", "apps/web/server.js"]`.

**`docs/DEPLOY.md`:** prerequisites, the stack env vars (with the note that `SESSION_SECRET` must be at least 32 characters and `ADMIN_PASSWORD` seeds the first login), Portainer steps (Stacks → Add stack → Git repository or the pasted compose file → set env vars → deploy), first-run checks (worker logs show `[worker] ready`, the web app loads and login works), how to trigger the first sync from Admin → Jobs, the one-replica rule, backups (`pg_dump` from the postgres service) and upgrades (`git pull` then redeploy the stack).

- [ ] **Step 1:** write the Dockerfiles, `.dockerignore` (node_modules, .next, .git, .env, fixtures/raw, .superpowers, mockups), compose file and DEPLOY.md.
- [ ] **Step 2: Local check without Docker:** `npm run build -w @mps/web` must succeed and produce `.next/standalone`. Docker isn't installed on this machine, so **don't try to build images here** — state in the report that the images are untested and must be built on the server.
- [ ] **Step 3:** typecheck, lint, commit.

---

## Verification (end state of Part 2)

1. `npm test` green (Part 1's 100 plus the new query, alert, issue-action and admin-action tests); typecheck and lint clean.
2. `npm run dev -w @mps/web` with the real local database:
   - `/login` rejects a wrong password and accepts the seeded admin
   - Fleet overview matches the real numbers (about 836 devices, 830 linked, 1,001 open issues) and the toner bars look like the mockup
   - `/devices` search and each filter tab work; a device page shows toner levels, meters and counter history matching the database
   - `/issues`: linking one device by hand resolves its issue, and a later `link-run` doesn't undo it
   - `/alerts` lists devices that have stopped reporting, and acknowledging one moves it
   - `/admin`: create an operator, set a counter category, trigger a job and see the run appear
3. Worker: `evaluateOfflineAlerts` runs as part of drms-pull, which is now hourly. `drms-alarms` runs every 30 min, dedupes on rerun, and the device page shows waste/parts/toner alarms. `sync_runs.stats` shows `alertsOpened` / `alertsCleared`.
4. `npm run build -w @mps/web` succeeds.
5. Deploy on the server through Portainer using `docs/DEPLOY.md`; the first sync is triggered from Admin → Jobs.

---

### Task 9D: Mono devices have no colour cartridges

**Why:** the fleet is roughly half mono. A `bizhub 301i` currently renders three empty
Cyan/Magenta/Yellow bars, is counted in "Needs toner", and contributes phantom cartridges
to the fleet toner health bar. Left alone, sub-project 3 would propose colour toner for a
machine that has none.

**The rule** (recorded in the spec under "Added requirements — 2026-09-18"): a device is
colour when its model name carries `C` in front of the model number (`bizhub C3350i`,
`C458`), a `+` after the range name (`ineo+308` — how Develop marks colour), or `MF`.
Everything else is mono. An unknown or empty model name counts as mono.

Verified against the live fleet: every model that has ever reported a Cyan, Magenta or
Yellow toner level matches a marker, and no model without one ever has. `bizhub 4050i`,
`bizhub 301i` and `bizhub 4701i` have counter snapshots with no CMY levels at all.

**Already done (uncommitted, do not rewrite):** `packages/core/src/models.ts` with
`isColourModel` / `isMonoModel`, its test file, and the export from
`packages/core/src/index.ts`. That helper is the single source of truth for the rule — do
not re-express it as a regex anywhere else in TypeScript.

**Files:**
- Modify: `packages/db/src/schema.ts` — add `isColour` to `drmsEquipment`
- Create: a drizzle migration adding the column, with a one-time backfill
- Modify: `apps/worker/src/jobs/drms-pull.ts` — set `isColour` on upsert from `isColourModel(modelName)`
- Modify: `packages/db/src/queries/shared.ts` — `counterPivotSubquery` nulls CMY for mono devices
- Modify: `apps/web/src/components/toner.ts` — channels per device
- Modify: `apps/web/src/components/device-table.tsx`, `toner-tile.tsx`, `toner-bar.tsx`, the device detail page — render only the channels a device has
- Test: alongside each

**Steps:**

- [ ] **Step 1: `is_colour` column.** Add `isColour: boolean('is_colour').notNull().default(false)`
  to `drmsEquipment` in `packages/db/src/schema.ts`. Generate the migration with
  `npm run db:generate -w @mps/db` (check the script name in `packages/db/package.json`).
  Hand-add a one-time backfill statement to the generated SQL so the 836 existing rows are
  correct before the next pull:
  ```sql
  UPDATE "drms_equipment" SET "is_colour" = true
  WHERE "model_name" ~ '(\+|MF|(^|[^A-Za-z])C[[:space:]]*[0-9])';
  ```
  This SQL is a one-off backfill, not a second source of truth: every later write comes
  from `isColourModel`.

- [ ] **Step 2: set it on pull.** In `apps/worker/src/jobs/drms-pull.ts`, map
  `isColour: isColourModel(<the model name being upserted>)` in the same place the other
  columns are mapped, and include it in the upsert's update set so a model-name correction
  in DRMS flows through. Add a test: pulling a device named `bizhub 301i` stores
  `isColour` false, `bizhub C301i` stores true, and re-pulling a device whose model name
  changed from mono to colour updates the flag.

- [ ] **Step 3: mono devices have no CMY in SQL.** In `packages/db/src/queries/shared.ts`,
  `counterPivotSubquery` currently reads only the counter tables. Join `drms_equipment` on
  the device id and wrap the three colour pivots so they return null for a mono device —
  e.g. `case when <is_colour> then <pivot> end` — leaving `black` and the three meters
  untouched. Everything downstream (`getFleetSummary`'s needsToner/criticalToner,
  `getTonerHealth`, the devices list) then fixes itself with no further change; confirm by
  reading those call sites that none of them reach past the pivot for a colour level.
  Tests (PGlite): a mono device with a CyanTonerLevel row in its snapshot contributes
  nothing to `getTonerHealth`'s cartridge count and is not in `getFleetSummary().needsToner`
  even at 0% cyan; the same device at 4% black still counts as critical; a colour device is
  unaffected.

- [ ] **Step 4: render only the channels a device has.** `apps/web/src/components/toner.ts:21`
  exports `TONER_CHANNELS` (cyan, magenta, yellow, black) and `tonerLevels(row)` at `:28`.
  Add `tonerChannels(row)` returning all four for a colour device and black only for a
  mono one, and make `tonerLevels` use it — that alone fixes `deviceStatusLabel` (`:102`),
  `tonerHealth` (`:121`) and `attentionRank` (`:140`).
  Then switch each render site that maps `TONER_CHANNELS` for one device:
  - `apps/web/src/components/toner-bar.tsx:47` `TonerBars` — hardcoded `grid-cols-4`; a mono
    row must render one black bar, and the black bar must stay in the same column position
    it occupies today so the table still reads straight down the page. Decide how (keep the
    4-column grid and place black in the last cell, or pass the channel list) and say why in
    a comment.
  - `apps/web/src/components/toner-bar.tsx:58` `TonerLegend` — the C/M/Y/K key above the
    table is fleet-wide, not per device, so leave it alone. Note that in a comment so the
    next reader doesn't "fix" it.
  - `apps/web/src/app/(app)/devices/[id]/page.tsx:188` `hasCounters` and `:227` the
    `lg:grid-cols-4` tile grid — a mono device shows one tile, and `hasCounters` must not
    look at CMY or a mono device with healthy black would fall into the empty state.
  The row types need the flag: add `isColour: boolean` to `DeviceRow`
  (`packages/db/src/queries/devices.ts:6`, selected at `:51-75`, mapped at `:113`) and to
  the detail row (`packages/db/src/queries/device.ts:55,115`).
  Tests: `tonerChannels` returns 1 channel vs 4; `deviceStatusLabel` for a mono device with
  null cyan and healthy black says "Online", not "No counters"; `tonerHealth` counts one
  cartridge for a mono device.

- [ ] **Step 4B: hide the Colour meter column on mono devices.** A mono device has no
  `Full Color:Total`, so the device page's Colour meter and its history column render as em
  dashes for ever. In `apps/web/src/components/device-detail.ts:131` the `CHANNELS` tuple
  binds `black`/`colour`/`scan`; `counterHistoryRows()` (`:145`) merges the three series,
  `apps/web/src/components/counter-table.tsx:44` renders the headers and `:67` the cells,
  and `apps/web/src/app/(app)/devices/[id]/page.tsx:252` renders the three Meter tiles.
  Drop the colour channel — tile, table column and delta — for a mono device. Keep Black and
  Scan. Test: `counterHistoryRows` for a mono device has no colour column, and the colour
  delta is not computed.

- [ ] **Step 5: verify against real data.** `npm test`, `npx tsc --noEmit`, `npm run lint`.
  Then report (do not run yourself — the controller has the credentials): the SQL to
  confirm no mono device appears in the needs-toner set.

- [ ] **Step 6: commit** each step separately, conventional commits.

**Out of scope:** per-device threshold settings, the `auto_replenish` flag and a manual
mono/colour override all belong to sub-project 3. Do not add a settings table here.
