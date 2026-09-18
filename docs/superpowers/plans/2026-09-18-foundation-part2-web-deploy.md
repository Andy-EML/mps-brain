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
- Don't build ordering, auto-reorder, jams/error events, drums/imaging units, uptime or "book an engineer" — no data or not wanted.

## File Map

```
packages/db/src/schema.ts                  Task 1  + deviceAlerts table
packages/db/drizzle/0001_*.sql             Task 1  generated migration
packages/db/src/queries/                   Task 2  fleet.ts, device.ts, issues.ts, alerts.ts, admin.ts (+ tests)
apps/worker/src/jobs/alerts-evaluate.ts    Task 3  offline alert evaluation (+ test)
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
- Four stat cards: **Total devices** (with "X monitored · Y linked" underneath), **Needs toner** (with "A critical · B low"), **Offline** (with "not reported in 24h"), **Open link issues** (with the top type).
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

### Task 10: Docker images, compose stack, Portainer deploy

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
3. Worker: `evaluateOfflineAlerts` runs as part of drms-pull, which is now hourly. `sync_runs.stats` shows `alertsOpened` / `alertsCleared`.
4. `npm run build -w @mps/web` succeeds.
5. Deploy on the server through Portainer using `docs/DEPLOY.md`; the first sync is triggered from Admin → Jobs.
