# Customers Accordion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/customers` rows expand in place to show each customer's machines (toner bars, PM chip, pending orders, last reading, warnings) with a red **!** on collapsed rows that have a warning; head-office rows expand to their sites, and a site expands to its machines.

**Architecture:** Two new read-only query helpers in `@mps/db`: `listCustomerWarnings` (set-wise counts for only the customers on the current page, so the list stays fast) and `listCustomerMachineStatus` / `listCustomerSiteStatus` (one customer, called lazily). A client `CustomerAccordionRow` calls a server action on first expand and caches the result. All figures reuse existing helpers: `listCustomerDevices` (the Machines-count set), PM state via a new `listPmForEquipment`, `TonerBars`, `statusLabel/statusTone`.

**Tech Stack:** TypeScript, Next.js app router (server components + one client component, server action), Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-customers-accordion-design.md`

## Global Constraints

- NO commits during execution — the "Commit" step is replaced by "no commit — orchestrator commits at end"; the user commits once after final review. No git command that changes HEAD/index/branches. Never print `.env` contents.
- No migration in this plan (read-only queries only). Never write to Vantage or DRMS; nothing here calls either API.
- Machine set = exactly what the Machines count uses: active-linked, not hidden (`listCustomerDevices(...).visible`). A head office's own row counts its sites' machines; its expansion shows its sites (counts + !) and, only if it has any, its own machines.
- Warnings (collapsed row **!**, tooltip lists counts): **no reading** = `lastCounterAt` null or older than 7 days (`NO_READING_DAYS = 7`); **PM overdue** = PM status `overdue` (pages or time) in the machine's PM row; **pending order** = pending proposals (same figure as the Pending column).
- Customer name stays a link to `customerHref(id, back)`; a click anywhere else on the row (except links/buttons) toggles; chevron button + Enter/Space, `aria-expanded`, `aria-controls`. Machine lines link `deviceHref(drmsId, 'customers', back)`; `back` = the current list URL. Footer link "Open customer page →".
- PM **!** on a site row links to `/pm?customer=<name>` (the PM filter is a name match). A head-office row's **!** is not a link (its sites carry the PM link when expanded).
- Lazy: the list page renders no machine rows; the server action returns rows for one customer on first expand only. Expanded state in the URL is not required.
- Reuse, do not rebuild: `TonerBars` (`components/toner-bar.tsx`), `ToneBadge`, `statusLabel`/`statusTone`/`overdueKind` (`components/pm-status.ts`), `OWN_CLICK` row-click guard pattern from `customer-table-row.tsx` / `pm-row.tsx`, `listCustomerDevices`, `customerHref`, `deviceHref`, `listHref`. Styling consistent with the Toner orders accordion (`replenishment-queue.tsx`) and PM rows.
- Tests: `npx vitest run <path>`; `npm run typecheck`; `npx eslint <files>`. The full suite (~13 min) runs only in the last task.

## Review Focus

1. Head office with 3 sites where only one site's machine has a warning → HO row shows **!**, expanding shows **!** on exactly that site only; test in Task 1.
2. Machine with no DRMS reading ever (`lastCounterAt` null) or exactly 7 days old → flagged; 6 days 23 h → not; test in Task 1.
3. A customer on the page with zero machines → no **!**, expansion shows "No machines" and the footer link (no crash, no empty chevron confusion); test in Task 1 (query) and Task 2 (component text helper).
4. Hidden devices and unlinked DRMS devices never appear in the machine lines or the warning counts (they are not in the Machines count); test in Task 1.
5. Clicking the name link, a machine line link, or the footer link navigates and does NOT toggle the row; the second expand of the same row does not refetch; Task 2 (helper test + manual click-through in Task 3).

---

### Task 1: Warning + machine-status queries

**Files:**
- Create: `packages/db/src/queries/customer-status.ts`, `packages/db/src/queries/customer-status.test.ts`
- Modify: `packages/db/src/queries/pm-queries.ts` (export `listPmForEquipment`), `packages/db/src/queries/index.ts` (re-export `./customer-status`)
- Test: `packages/db/src/queries/customer-status.test.ts`, `packages/db/src/queries/pm-queries.test.ts` (one new test)

**Interfaces:**
- Consumes: `listCustomerDevices(db, ids): Promise<{ visible: DeviceRow[]; hidden: DeviceRow[] }>`, `loadCustomerRows` scope logic in `customers.ts` (`headOfficeIdSql`, `CustomerRow`), `buildRows`/`loadMachines` in `pm-queries.ts`, `getPmSettings`.
- Produces:
  ```ts
  export const NO_READING_DAYS = 7;
  export interface CustomerWarnings { noReading: number; pmOverdue: number; pending: number }  // machine counts; pending = proposals
  export function hasWarning(w: CustomerWarnings): boolean;                       // any count > 0
  /** One entry per id in `customerIds`; a head office's counts include its sites'. */
  export function listCustomerWarnings(db: Db, customerIds: number[], now?: Date): Promise<Map<number, CustomerWarnings>>;
  export interface MachineStatusRow {
    device: DeviceRow;                       // feeds TonerBars + names
    location: string | null;                 // vantage_equipment.location
    pm: { status: PmStatus; overdueReason: string | null; bookedOverdue: boolean; view: PmView } | null;  // null = no PM row (no active contract)
    pending: number;                         // pending proposals on this device
    lastReadingAt: Date | null;              // = device.lastCounterAt
    warnings: { noReading: boolean; pmOverdue: boolean; pending: boolean };
  }
  export function listCustomerMachineStatus(db: Db, customerId: number, now?: Date): Promise<MachineStatusRow[]>;
  export interface SiteStatusRow { customer: CustomerRow; warnings: CustomerWarnings }
  export function listCustomerSiteStatus(db: Db, headOfficeId: number, now?: Date): Promise<SiteStatusRow[]>;
  // pm-queries.ts
  export function listPmForEquipment(db: Db, vantageEquipmentIds: number[], now?: Date): Promise<Map<number, PmRow>>;
  ```
  `loadCustomerRows` is currently module-private in `customers.ts`; export it (rename nothing) so `listCustomerSiteStatus` can call it with `{ headOfficeId }`.

- [ ] **Step 1: Failing tests** (`customer-status.test.ts`, fixtures via `createTestDb()`; follow `customers.test.ts` seeding helpers):
  - `listCustomerWarnings counts a no-reading machine only when lastCounterAt is null or >= 7 days old` — machines with readings 6d23h (not), 7d (yes), null (yes) → `noReading === 2`.
  - `listCustomerWarnings rolls a head office up from its sites` and `a warning on one site flags only that site` (Review Focus 1): HO + 3 sites, one site machine overdue → `get(ho).pmOverdue === 1`, `get(siteA).pmOverdue === 1`, `get(siteB).pmOverdue === 0`; `hasWarning(get(siteB)) === false`.
  - `listCustomerWarnings ignores hidden and unlinked devices` (Review Focus 4): hidden device with no reading → `noReading === 0`; unlinked DRMS device not counted.
  - `listCustomerWarnings returns zeros for a customer with no machines` (Review Focus 3): all three counts 0, `hasWarning` false.
  - `listCustomerWarnings pending equals the customer list's Pending figure` — create 2 pending proposals; compare with `listCustomers(...).rows[].pending`.
  - `listCustomerMachineStatus returns the Machines-count set with location, pm and pending` — one row per visible device; `location` from Vantage equipment; `pm.status` matches `getEquipmentPm`; `warnings.pending` true when `pending > 0`.
  - `listCustomerMachineStatus gives pm null for a machine with no active contract`.
  - `listCustomerSiteStatus lists each site with its own counts and warnings`.
  - pm-queries: `listPmForEquipment returns the same PmRow as getEquipmentPm for each id and omits ids with no active contract`.
- [ ] **Step 2: Run** `npx vitest run packages/db/src/queries/customer-status.test.ts packages/db/src/queries/pm-queries.test.ts` → FAIL (symbols missing).
- [ ] **Step 3: Implement** `listPmForEquipment` (wraps `loadMachines(db, ids)` + `buildRows` + `getPmSettings`; empty input → empty map), export `loadCustomerRows`, and the four functions above. `listCustomerWarnings` is set-wise: one query for (customer, scope member) pairs via `headOfficeIdSql`, one for machines (`drmsId`, `vantageEquipmentId`, `vantageCustomerId`, `lastCounterAt`; active link, `notHiddenDevice`), one grouped pending query, then `listPmForEquipment` over the page's machine ids; fold in memory by scope. Do not query per customer.
- [ ] **Step 4: Run** the same command → PASS; `npm run typecheck -w @mps/db` → 0.
- [ ] **Step 5:** no commit — orchestrator commits at end.

### Task 2: Accordion UI — list rows, lazy machine lines, head-office tree (UI)

**Files:**
- Create: `apps/web/src/components/customer-accordion-row.tsx` (client), `apps/web/src/components/customer-machines.tsx` (machine lines + site lines, presentational), `apps/web/src/components/customer-status.ts` (pure helpers), `apps/web/src/components/customer-status.test.ts`
- Modify: `apps/web/src/app/(app)/customers/page.tsx`, `apps/web/src/app/(app)/customers/actions.ts`
- Delete (if unused after wiring): `apps/web/src/components/customer-table-row.tsx`
- Test: `apps/web/src/components/customer-status.test.ts`

**Interfaces:**
- Consumes: Task 1 (`listCustomerWarnings`, `hasWarning`, `listCustomerMachineStatus`, `listCustomerSiteStatus`, `MachineStatusRow`, `SiteStatusRow`, `CustomerWarnings`), `TonerBars`, `ToneBadge`, `statusLabel`, `statusTone`, `overdueKind`, `deviceHref`, `customerHref`, `hrefWith`.
- Produces:
  ```ts
  // customer-status.ts (pure, type-only db imports)
  export function warningTooltip(w: CustomerWarnings): string;     // "2 machines no reading 7+ days · 1 PM overdue · 3 pending orders"; '' when none
  export function pmWarningHref(customerName: string | null, isHeadOffice: boolean): string | null; // `/pm?customer=<name>`; null for head office or no name
  export function machinesEmptyText(): string;                      // 'No machines'
  export function parseCustomerIdArg(v: unknown): number | null;    // /^\d{1,9}$/ → number
  export function machineLineWarnings(m: MachineStatusRow): string[]; // ['No reading 9 days', 'PM overdue', '2 pending'] for the line's inline text
  // actions.ts ('use server'; requireUser() first)
  export async function loadCustomerMachinesAction(customerId: unknown): Promise<MachineStatusRow[] | { error: string }>;
  export async function loadCustomerSitesAction(headOfficeId: unknown): Promise<SiteStatusRow[] | { error: string }>;
  // customer-accordion-row.tsx ('use client')
  export function CustomerAccordionRow(props: { row: CustomerRow; warnings: CustomerWarnings; back: string; columns: number; showSites: boolean; children: ReactNode /* the existing <td> cells */ }): JSX.Element;
  ```
- The page computes `listCustomerWarnings(db, rows.map(r => r.vantageId))` after `listCustomers` (one call for the page) and passes each row's warnings. A head-office row on the Head offices tab (`r.sites > 0`) loads sites via `loadCustomerSitesAction`; each site renders as a nested expandable line using the same machines action; every other row loads machines.

- [ ] **Step 1: Failing tests** (`customer-status.test.ts`): `warningTooltip` all three, singular/plural (`1 machine`, `1 PM overdue`, `1 pending order`), only one non-zero, none → `''`; `pmWarningHref('Acme & Sons Ltd', false) === '/pm?customer=Acme%20%26%20Sons%20Ltd'`, head office → `null`, `null` name → `null`; `parseCustomerIdArg('42') === 42`, `'4x'`/`''`/`'-1'`/`'1234567890'`/`42` (number)/`undefined` → `null` (Review Focus: no injection through the action); `machineLineWarnings` for a machine with `lastReadingAt` 9 days old, `pm.status` overdue, `pending` 2 → three entries, none for a clean machine; `machinesEmptyText() === 'No machines'` used when the result is `[]` (Review Focus 3).
- [ ] **Step 2: Run** `npx vitest run apps/web/src/components/customer-status.test.ts` → FAIL.
- [ ] **Step 3: Implement** the helpers and actions (action: `requireUser()` first, `parseCustomerIdArg`, `getDb()`, call the Task 1 query; any thrown error is logged and returned as `{ error: "Couldn't load machines — try again" }`). Implement `CustomerAccordionRow`: renders the `<tr>` with the chevron button in the Name cell (the name stays a `Link`), a red **!** (`lucide` `AlertCircle`, `title` = `warningTooltip`, wrapped in a `Link` to `pmWarningHref` only when that warning is the PM one and href non-null) in the Name cell, and a second `<tr><td colSpan={columns}>` panel rendered on first open and kept mounted (as `pm-row.tsx` does). Panel: loading text, error text with a "Try again" button, machine lines (`customer-machines.tsx`: model, serial, location, `<TonerBars row={m.device} />`, PM chip via `ToneBadge tone={statusTone(m.pm.status)}` + "Overdue by pages/time" from `overdueKind`, pending count, last reading date via `formatDate`, inline warnings text in the warn/critical tone), each machine line a `Link` to `deviceHref(m.device.drmsId, 'customers', back)`; footer `Open customer page →` = `customerHref(row.vantageId, back)`. Row-click toggles unless the click is inside `a, button, input, select, textarea, label, [data-no-row-nav]` or ends a text selection; Enter/Space on the chevron button. Fetch once per row (state holds the result).
- [ ] **Step 4:** Wire `customers/page.tsx`: replace `CustomerTableRow` with `CustomerAccordionRow` (keep every existing `<td>`, sort headers, pager, tabs untouched; `columns` = the header cell count: 8, or 9 with Sites), pass `back` (already computed). Delete `customer-table-row.tsx` if nothing else imports it (`grep -rn customer-table-row apps/web/src`).
- [ ] **Step 5: Run** `npx vitest run apps/web` → PASS; `npm run typecheck`; `npx eslint apps/web/src/components apps/web/src/app/\(app\)/customers` → clean.
- [ ] **Step 6:** no commit — orchestrator commits at end.

### Task 3: Final verification and rebuild

- [ ] **Step 1:** `npm test` (full suite, ~13 min) → all pass; `npm run typecheck` → 0; `npm run lint` → clean.
- [ ] **Step 2:** `powershell -File scripts/mps.ps1 build` (production build; restarts web and worker) then `powershell -File scripts/mps.ps1 status` → both running.
- [ ] **Step 3:** Manual click-through on `/customers` (report what was seen; no code changes unless broken): expand a customer with machines (bars, chip, pending, last reading, warnings render; machine line opens the device page and Back returns to the same list view incl. page/sort/tab), expand a customer with no machines, Head offices tab (HO → sites → machines), name link does not toggle, keyboard Enter/Space on the chevron, a customer whose collapsed **!** links to `/pm?customer=...`.
- [ ] **Step 4:** Time `/customers` before/after on the default tab with rows=200 (note the figures in the final report; if `listCustomerWarnings` adds more than ~1 s, report it rather than silently changing scope).
- [ ] **Step 5:** no commit — orchestrator commits at end.
