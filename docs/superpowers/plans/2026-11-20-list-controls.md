# List controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vantage-style pager (first/prev/numbers/next/last + rows per page 10/20/50/100/200) above and below every list, server-side sortable column headers on every list, and list → detail → Back returning to the exact list view.

**Architecture:** Pure URL-state helpers (`lib/list-state.ts`) parse/emit `page`, `rows`, `sort`, `dir`; a shared server `ListControls` bar and `SortHeader` link render from that state; a tiny client `RowsPicker` writes a per-list cookie and navigates. Each list query gains an optional `sort: { key, dir }` (whitelisted keys → SQL or JS comparator, default = today's order, id tiebreak) and limit/offset/total where missing. Detail pages accept a validated `back`.

**Tech Stack:** TypeScript, Next.js app router (server components + one client component), Drizzle/Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-list-controls-design.md`

## Global Constraints

- Do NOT commit during execution (user OKs commit at the end). No git command that changes HEAD/index/branches. Never print `.env` contents.
- URL params: `page` (1-based), `rows` ∈ {10, 20, 50, 100, 200}, `sort` = list-specific key, `dir` ∈ {asc, desc}. Unknown/invalid values fall back silently (rows → cookie → list default; sort → list default order).
- Cookie: `lc_rows_<listKey>`, path `/`, max-age 1 year, SameSite=Lax. Precedence: URL `rows` > cookie > list default. Changing rows or sort resets to page 1 (page param dropped).
- Default rows per list = today's page size (Devices 50, Customers 50, PM 100, Reconnect 50, Registrations 100, Issues 50) ; newly paginated lists: Alerts 50, Site stock 50, Toner orders 50, Toner yield 50, Hidden devices 50.
- Sort header: first click asc, clicking the active column toggles dir; arrow icon (lucide `ArrowUp`/`ArrowDown`, muted `ArrowUpDown` when inactive); `aria-sort` on the `<th>`. Every sort has a final stable tiebreak on the row id.
- No sort given → exactly today's order (existing tests must keep passing unchanged).
- Bar layout: `« ‹ [up to 5 page numbers centred on current] › »  Rows [n ▾]  Showing a–b of n <noun>`; disabled ends greyed (aria-disabled); one page → numbers hidden but rows picker + count still shown. Rendered above AND below each list. Replaces `components/pagination.tsx` everywhere (delete it when unused).
- `back` param: validated by `safeBackPath` (relative, ≤1000 chars, no `//`, `\`, control chars, other origin; pathname must equal the allowed base or a registered sub-page). Detail pages fall back to their section base.
- Tests: `npx vitest run <path>` from repo root; `npm run typecheck`; `npx eslint apps packages`. Rebuild live only in Task 7: `powershell -File scripts/mps.ps1 build` then `status`.

## Review Focus

1. `?rows=999` / `?rows=abc` / `?page=0` / `?page=99999` / `?sort=__proto__` → falls back, never throws or 500s; page past the end redirects or clamps to last page; test in Task 1 (parser) and Task 4 (page).
2. Sort changes total order but not filters: Devices filtered to one customer, sorted by model desc, still shows only that customer and correct total; test in Task 2.
3. Back from device opened on Devices page 3 (rows 20, sort model desc, filter colour) returns to that exact URL; same for customer and shelf detail; test in Task 6.
4. Accordion lists (PM `?open=`, Toner orders) keep the open row and tab when paging/sorting; test in Task 5.
5. Rows cookie for one list does not change another list's rows; test in Task 1.

---

### Task 1: Shared list state + controls components

**Files:**
- Create: `apps/web/src/lib/list-state.ts` (+ `list-state.test.ts`)
- Create: `apps/web/src/components/list-controls.tsx` (server), `apps/web/src/components/rows-picker.tsx` (client), `apps/web/src/components/sort-header.tsx` (server)
- Test: `apps/web/src/lib/list-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ROWS_OPTIONS = [10, 20, 50, 100, 200] as const;
  export type SortDir = 'asc' | 'desc';
  export interface ListState<K extends string> { page: number; rows: number; sort: K | null; dir: SortDir }
  export function rowsCookieName(listKey: string): string; // `lc_rows_${listKey}`
  export function parseListState<K extends string>(
    get: (name: string) => string | undefined,
    opts: { listKey: string; defaultRows: number; sortKeys: readonly K[]; cookieRows?: string | undefined },
  ): ListState<K>;
  /** URL for this list with state overrides; drops page when rows/sort change; omits defaults. */
  export function listHref<K extends string>(basePath: string, keep: Record<string, string | number | null | undefined>, state: ListState<K>, change: Partial<ListState<K>>, opts: { defaultRows: number }): string;
  export function pageWindow(page: number, lastPage: number, size?: number): number[]; // up to 5 numbers centred
  export function nextSort<K extends string>(state: ListState<K>, key: K): { sort: K; dir: SortDir };
  // list-controls.tsx
  export function ListControls(props: { basePath: string; keep: Record<string, string | number | null | undefined>; state: ListState<string>; total: number; noun?: string; listKey: string; defaultRows: number; className?: string }): JSX.Element;
  // sort-header.tsx
  export function SortHeader(props: { label: string; sortKey: string; basePath: string; keep: Record<string, string | number | null | undefined>; state: ListState<string>; defaultRows: number; align?: 'left' | 'right'; className?: string }): JSX.Element; // renders <th aria-sort> with a Link
  // rows-picker.tsx ('use client')
  export function RowsPicker(props: { listKey: string; value: number; hrefFor: Record<number, string> }): JSX.Element; // <select>; onChange sets cookie then router.push(hrefFor[n])
  ```
- Page reads the cookie with `cookies()` from `next/headers` and passes `cookieRows` to `parseListState`.

- [ ] **Step 1: Failing tests** (`list-state.test.ts`): rows precedence (URL 20 > cookie 100 > default 50); invalid URL rows `999`/`abc` → cookie/default; invalid cookie → default; page `0`/`-3`/`abc`/`2.7` → 1/1/1/2; huge page capped at 1_000_000; `sort=__proto__` / unknown → null; `dir` other than desc → asc; `rowsCookieName('devices') === 'lc_rows_devices'` and a different list key gives a different name (Review Focus 5); `listHref` drops `page` when rows or sort change, omits `rows` equal to default, keeps `keep` params, omits `dir=asc`; `pageWindow(1,3)` → [1,2,3], `pageWindow(10,20)` → [8,9,10,11,12], `pageWindow(20,20)` → [16..20]; `nextSort` new key → asc, same key asc → desc, desc → asc.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/lib/list-state.test.ts` → FAIL.
- [ ] **Step 3: Implement** helpers + the three components (follow styling of existing `components/pagination.tsx`, `filter-tabs.tsx`; `STEP` button class reused).
- [ ] **Step 4: Run** → PASS; `npm run typecheck -w @mps/web` → 0.

### Task 2: Sortable SQL list queries (+ offset/total where missing)

**Files:**
- Modify: `packages/db/src/queries/devices.ts` (`listDevices`, `deviceListOrder`), `hidden-devices.ts` (`listHiddenDevices`), `reconnect.ts` (`listReconnect`), `registrations.ts` (`listRegistrations`), `issues.ts` (`listIssues`), `alerts.ts` (`listAlerts` → add `offset` and return `{ rows, total }` via a new `listAlertsPage`, keep `listAlerts` signature for other callers)
- Test: `queries.test.ts`, `hidden-devices.test.ts`, `reconnect.test.ts`, `registrations.test.ts`, issues/alerts tests (existing files)

**Interfaces:**
- Produces, for each list `X`: `export const X_SORT_KEYS = [...] as const; export type XSortKey = typeof X_SORT_KEYS[number];` and option `sort?: { key: XSortKey; dir: 'asc' | 'desc' }`. Keys (one per visible sortable column; map to SQL, nulls last both directions, final id tiebreak):
  - Devices (`DEVICE_SORT_KEYS`): `device` (display name), `customer`, `model`, `serial`, `toner` (lowest current toner level of tracked colours), `pages` (pages/mo expression already shown).
  - Hidden devices: `device`, `hidden` (hiddenAt), `reason`.
  - Reconnect: `customer`, `location`, `device`, `serial`, `status`, `lastContact`, `firstConnected`, `lastAlarm`.
  - Registrations: `machine`, `customer`, `created`, `finished`, `decided` (only those whose column the tab shows; header decides).
  - Issues: `issue` (type), `device`, `vantage`, `seen` (lastSeen).
  - Alerts: `device`, `customer`, `alert` (type), `detected`.
- `listAlertsPage(db, { status?, includeCleared?, sort?, limit, offset }): Promise<{ rows: AlertRow[]; total: number }>`.

- [ ] **Step 1: Failing tests** per query: default order unchanged when `sort` absent (existing tests); each key asc vs desc reverses order on a 3-row fixture; nulls last in both directions; Devices filtered to one customer + `sort: model desc` keeps filter and total (Review Focus 2); `listAlertsPage` offset/total.
- [ ] **Step 2: Run** the touched test files → FAIL.
- [ ] **Step 3: Implement** (one `orderBy` builder per list from a key→SQL map; keep existing default order function as the no-sort path).
- [ ] **Step 4: Run** → PASS; `npx vitest run packages/db` → PASS; `npm run typecheck` → 0.

### Task 3: Sortable in-memory lists (+ paging)

**Files:**
- Modify: `packages/db/src/queries/customers.ts` (`listCustomers`), `pm-queries.ts` (`listPmDue` — add optional sort applied after filtering), `site-stock.ts` (`listShelves` → add `sort`, `limit`, `offset`, return `{ rows, total }` via new `listShelvesPage`; keep `listShelves`), `replenishment.ts` (`listReplenishmentQueue` → add `sort`, `offset`, and a `total` via new `listReplenishmentQueuePage`; keep old), `toner-yield.ts` (`listUnderYielding` → add sort)
- Test: matching `.test.ts` files

**Interfaces:**
- Keys:
  - Customers (`CUSTOMER_SORT_KEYS`): `name`, `ref`, `town`, `machines`, `pending`, `shelves`, `sites`, `stock`.
  - PM (`PM_SORT_KEYS`): `customer`, `serial`, `model`, `status`, `pages` (pagesSince), `pct`, `lastVisit`, `due` (est. due date), `town`.
  - Shelves (`SHELF_SORT_KEYS`): `site`, `family`, `machines`, `used`, `status`.
  - Toner orders queue (`QUEUE_SORT_KEYS`): `urgency` (today's review default), `recent` (today's other-tab default), `customer`, `device`. No header row: rendered as a "Sort by" control (Task 5).
  - Toner yield (`YIELD_SORT_KEYS`): `customer`, `serial`, `model`, `family`, `colour`, `achieved`, `cartridges`, `lastOrder`.
- Comparators: strings `localeCompare(undefined, { sensitivity: 'base' })`, numbers/dates numeric, nulls last both directions, final id tiebreak.

- [ ] **Step 1: Failing tests** per list: absent sort = today's order; each key asc/desc; nulls last; paged variants return correct `total` and slice.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (one shared `compareBy` helper in `packages/db/src/queries/shared.ts` for nulls-last + tiebreak).
- [ ] **Step 4: Run** → PASS; `npx vitest run packages/db`, `npm run typecheck` → clean.

### Task 4: Wire controls — Devices, Hidden, Fleet overview, Customers, Link issues

**Files:**
- Modify: `apps/web/src/app/(app)/devices/page.tsx`, `components/device-table.tsx`, `components/hidden-device-table.tsx`, `app/(app)/page.tsx` (Fleet: sort headers only, 8-row preview, "View all" link carries sort), `app/(app)/customers/page.tsx`, `app/(app)/issues/page.tsx`, `components/issue-table.tsx`

**Interfaces:**
- Consumes: Task 1 helpers/components; Task 2/3 sort keys and paged queries.
- Each page: `const state = parseListState(get, { listKey, defaultRows, sortKeys, cookieRows })`; pass `limit: state.rows`, `offset: (state.page-1)*state.rows`, `sort` to the query; `<ListControls>` above and below the table; header `<th>` → `<SortHeader>` for sortable columns; page past the end → `redirect(listHref(... { page: lastPage }))`; `back` built with `listHref` of the CURRENT state so it includes rows/sort.
- listKeys: `devices`, `hidden`, `customers`, `issues` (Fleet has no pager).

- [ ] **Step 1:** Implement; keep existing filter/tab/search params in `keep`.
- [ ] **Step 2:** `npx vitest run apps/web` → PASS; `npm run typecheck`, `npx eslint apps` → clean.

### Task 5: Wire controls — PM due, Reconnect, Registrations, Alerts, Site stock, Toner orders, Toner yield

**Files:**
- Modify: `app/(app)/pm/page.tsx`, `components/pm-row.tsx`, `app/(app)/reconnect/page.tsx`, `app/(app)/registrations/page.tsx`, `components/registration-queue.tsx`, `app/(app)/alerts/page.tsx`, `components/alert-table.tsx`, `app/(app)/site-stock/page.tsx`, `app/(app)/orders/page.tsx`, `components/replenishment-queue.tsx`, `app/(app)/orders/yield/page.tsx`

**Interfaces:**
- As Task 4. listKeys: `pm`, `reconnect`, `registrations`, `alerts`, `site-stock`, `orders`, `toner-yield`.
- PM keeps `open` in `keep` (Review Focus 4). Toner orders: `tab` in `keep`; "Sort by" select (urgency / most recent / customer / device; default per tab as today) rendered as links via `listHref` beside the top bar; pending-count badges unchanged. Alerts: drop the "Showing the 200 most recent" note (now paginated).
- Review/on-site rows and Toner yield links now pass `back` (`deviceHref(id, 'orders' | 'toner-yield', back)`).

- [ ] **Step 1: Failing test** (Review Focus 4): pure helper test that `listHref` for PM with `keep: { open: '123', ... }` keeps `open` on page/sort links; and for orders keeps `tab`.
- [ ] **Step 2:** Implement pages.
- [ ] **Step 3:** `npx vitest run apps/web` → PASS; typecheck + eslint clean.

### Task 6: Back keeps place — customer and shelf detail pages; verify device

**Files:**
- Modify: `apps/web/src/lib/device-origin.ts` (generalise: export `safeReturnPath(back, allowedBases: string[])`; keep `safeBackPath` behaviour), `app/(app)/customers/[id]/page.tsx` (read `back`, Back link + breadcrumb root use `safeReturnPath(back, ['/customers'])` else `/customers`), `components/customers.ts` (`customerHref(id, back?)`), `app/(app)/customers/page.tsx` + `components/customer-table-row.tsx` (pass back), `app/(app)/site-stock/[id]/page.tsx` (read `back`; breadcrumb root uses `safeReturnPath(back, ['/site-stock', '/customers' + sub-page])`), every `/site-stock/${id}` literal → `shelfHref(id, back?)` (new, in `components/shelf.ts`), shelf/site-stock actions that redirect to a shelf page keep `back`.
- Test: `device-origin.test.ts`, `customers.test.ts`, `shelf.test.ts`

- [ ] **Step 1: Failing tests:** `deviceHref('d1','devices', '/devices?page=3&rows=20&sort=model&dir=desc&colour=colour')` keeps the full back and `resolveDeviceOrigin('devices', thatBack).href` equals it (Review Focus 3; if it already passes, trace why the user saw page 1 — check `device-table-row.tsx` row click, device-page actions' redirects (`devices/[id]/actions.ts:136`), and the breadcrumb — and add a failing test for the real cause); `customerHref(5, '/customers?tab=all&page=2')` → `/customers/5?back=...`; `safeReturnPath` rejects `//evil`, `https://x`, `/devicesX`, over-long; `shelfHref(9, '/site-stock?page=2&sort=site')`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run apps/web` → PASS.

### Task 7: Remove old pager, full verification, rebuild

- [ ] **Step 1:** `grep -rn "components/pagination" apps/web/src` → no hits; delete `components/pagination.tsx`.
- [ ] **Step 2:** `npx vitest run` → all pass; `npm run typecheck` → 0; `npx eslint apps packages` → 0.
- [ ] **Step 3:** `powershell -File scripts/mps.ps1 build`, then `status`; curl each list URL with odd params (`/devices?rows=999&page=0&sort=__proto__`, `/pm?rows=10&sort=due&dir=desc`, `/orders?tab=in-progress&sort=customer`, `/alerts?page=99999`) → 307/200 never 500; web log clean.
