# Customers section + self-managed stock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/customers` section (list + page per customer: settings, machines, toner orders, shelves, sites) and an absolute "Self-managed stock" flag on a site or head office that stops every proposal type for that customer's machines.

**Architecture:** New table `customer_flags` (migration 0020). One SQL helper resolves "self-managed" (site flag OR head-office flag, one hop) and is exposed as `selfManaged` on `effectiveSettingsSubquery`, so worker, queue and pages read one answer. One action `setSelfManaged` flips the flag, audits, and supersedes pending proposals straight away; the worker repeats the supersede every run as a safety net and skips self-managed devices/shelves. Web pages reuse existing settings dialogs, device rows, `OrderHistory` and shelf forms.

**Tech Stack:** TypeScript, Drizzle (Postgres 17), Vitest, Next.js app router (`apps/web`), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-20-customers-design.md`

## Global Constraints

- Read-only towards Vantage and DRMS. No writes to either.
- Do NOT commit. No `git commit` in any task (user rule: commits only with the user's OK). Leave changes in the working tree.
- Never print `DATABASE_URL` or any credential; never read `.env` contents into output.
- Supersede note text, exactly: `customer self-managed`. Spare-black ineligible reason, exactly: `self_managed`.
- Audit actions, exactly: `customer.self_managed.on` / `customer.self_managed.off`, details `{ note, supersededProposalIds }`.
- Self-managed = the device's **active** link's Vantage equipment customer has `self_managed = true`, OR that customer's head office (`vantage_customers.raw->>'HeadOfficeId'`, one hop only) has it. Unlinked devices are never self-managed.
- Approved / In progress proposals and queued orders are never touched by the flag.
- Cartridge changes and shelf uses are still recorded while self-managed; only proposals stop.
- Any signed-in user (`requireUser`) may flip the flag and edit shelves; no `requireAdmin`.
- Town = `nullif(btrim(vantage_customers.raw->>'Town'), '')` (as `pm-queries.ts` does).
- Customer page orders window: last **12 months** on `vantage_sales_orders.order_date`.
- "With machines" = at least one active linked, not-hidden DRMS device (same rule as `searchVantageCustomers`).
- **Migration order:** generate 0020, then stop the worker, restart it (it applies migrations on boot) BEFORE any web code that queries `customer_flags` is loaded by the running web app. Use `scripts/mps.ps1 restart -Only worker`.
- Tests: `npx vitest run <path>` from `C:\dev\mps-brain-replenishment`; typecheck `npm run typecheck`; lint `npm run lint`. DB tests use `createTestDb` / `seedDemoFixture` from `packages/db/src/testing`.

## Review Focus

1. Site under a flagged head office whose own flag row says `false` → still self-managed (head office wins; no per-branch exceptions); test in Task 1.
2. Flag turned on for a head office → pending proposals on devices of **all its sites** are superseded, including a shelf top-up whose `drms_equipment_id` is a device now at another customer but whose `shelf_id` belongs to the head office's site; test in Task 2.
3. Pending `spare_used` proposal referenced by `cartridge_changes.proposal_id` → superseded too, the `cartridge_changes` row kept with its `proposal_id`; test in Task 2.
4. Flag turned off → no back-fill; next `runReplenishEvaluate` proposes from current levels normally; test in Task 3.
5. Device re-linked from a self-managed customer to a normal one → not self-managed (active link only); test in Task 1.

---

### Task 1: `customer_flags` table + self-managed resolution

**Files:**
- Modify: `packages/db/src/schema.ts` (add `customerFlags` after `replenishmentSettings`)
- Create: `packages/db/drizzle/0020_customer_flags.sql` (+ snapshot) via `npm run generate -w @mps/db`
- Modify: `packages/db/src/queries/settings.ts` (`effectiveSettingsSubquery`)
- Create: `packages/db/src/queries/customer-flags.ts` (helper only in this task)
- Modify: `packages/db/src/queries/index.ts` (export)
- Test: `packages/db/src/queries/customer-flags.test.ts`, `packages/db/src/queries/settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // schema.ts
  export const customerFlags = pgTable('customer_flags', {
    vantageCustomerId: integer('vantage_customer_id').primaryKey(),
    selfManaged: boolean('self_managed').notNull().default(false),
    selfManagedNote: text('self_managed_note'),
    updatedBy: integer('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  });
  // customer-flags.ts
  export const SELF_MANAGED_NOTE = 'customer self-managed';
  export type SelfManagedSource = 'site' | 'head_office';
  /** SQL: 'site' | 'head_office' | null for a Vantage customer id column. Site flag wins over head office when both. */
  export function selfManagedSourceSql(customerId: AnyPgColumn | SQL): SQL<SelfManagedSource | null>;
  export function headOfficeIdSql(customersTable?: typeof vantageCustomers): SQL<number | null>; // (raw->>'HeadOfficeId')::int, null when absent or = own id
  // effectiveSettingsSubquery gains: selfManaged: boolean ('eff_self_managed'), selfManagedSource: SelfManagedSource | null ('eff_self_managed_source')
  ```

- [ ] **Step 1: Write failing tests** in `customer-flags.test.ts` (`describe('selfManagedSourceSql')`) using a seeded test DB with customers A (site, HeadOfficeId = H), H (head office), B (no head office), and devices linked to A, H, B:
  - no flags → all devices `selfManaged false`, source null.
  - flag on H → device at A `selfManaged true`, source `'head_office'`; device at H source `'site'`; device at B false.
  - flag on A only → A true `'site'`, H false.
  - flag row on A with `self_managed = false` and flag on H → A still true `'head_office'` (Review Focus 1).
  - device whose active link moved from A (unlinked_at set) to B → follows B (Review Focus 5).
  - unlinked device → false.
  - customer whose `raw` has `HeadOfficeId` equal to its own id → treated as no head office.
- [ ] **Step 2: Run** `npx vitest run packages/db/src/queries/customer-flags.test.ts` → FAIL (`customerFlags` / helper not defined).
- [ ] **Step 3: Add the table, generate migration** `npm run generate -w @mps/db` → new `0020_*.sql`; rename to `0020_customer_flags.sql` only if the repo's journal convention allows (follow what 0019 did). Implement the helper with two correlated `exists` subqueries on `customer_flags` (site, then head office via `vantage_customers.raw`). Add the two columns to `effectiveSettingsSubquery` (join path already reaches `vantageEquipment.vantageCustomerId`).
- [ ] **Step 4: Run** the test file and `npx vitest run packages/db/src/queries/settings.test.ts` → PASS.
- [ ] **Step 5: Apply live:** `powershell -File scripts/mps.ps1 restart -Only worker`, then `powershell -File scripts/mps.ps1 logs -Only worker` shows `ready` and no migration error. (Web keeps running; nothing in web queries the table yet.)

### Task 2: `setSelfManaged` action + supersede helpers

**Files:**
- Modify: `packages/db/src/queries/customer-flags.ts`
- Test: `packages/db/src/queries/customer-flags.test.ts`

**Interfaces:**
- Consumes: Task 1 helper, `SELF_MANAGED_NOTE`.
- Produces:
  ```ts
  export interface SelfManagedInfo { selfManaged: boolean; source: SelfManagedSource | null; note: string | null; updatedAt: Date | null; updatedBy: string | null; headOffice: { vantageId: number; name: string | null } | null }
  export async function getSelfManaged(db: Db, vantageCustomerId: number): Promise<SelfManagedInfo>; // note/updated* from the row that sets it (site row, else head office row)
  /** Customer ids the flag on `vantageCustomerId` reaches: itself + sites whose HeadOfficeId = it. */
  export async function customerScopeIds(db: Db, vantageCustomerId: number): Promise<number[]>;
  /** Pending proposals the switch would clear, for the confirm dialog. */
  export async function previewSelfManaged(db: Db, vantageCustomerId: number): Promise<{ pending: number; devices: number; sites: number }>;
  export async function setSelfManaged(db: Db, args: { vantageCustomerId: number; on: boolean; note?: string | null; userId: number; now?: Date }): Promise<{ superseded: number }>;
  /** Worker safety net: supersedes every pending proposal on a self-managed device or a self-managed customer's shelf. Returns ids. */
  export async function supersedeSelfManagedProposals(db: Db, now: Date): Promise<number[]>;
  ```
- Rules: "pending to clear" = `status = 'pending'` AND (`drms_equipment_id` on a device whose effective `selfManaged` is true, OR `shelf_id` on a shelf whose `vantage_customer_id` is self-managed by `selfManagedSourceSql`). Includes `spare_used` proposals referenced by `cartridge_changes.proposal_id`. Update sets `status 'superseded'`, `decidedAt now`, `note SELF_MANAGED_NOTE`. `setSelfManaged` upserts the row, runs `supersedeSelfManagedProposals` in the same transaction when `on`, and writes the audit row (reuse the `audit_log` insert shape used in `site-stock-actions.ts`). Turning off supersedes nothing.

- [ ] **Step 1: Write failing tests:**
  - `setSelfManaged on` for H → pending threshold proposal on device at A superseded with note `customer self-managed`; approved proposal on same device untouched; returns `{ superseded: 1 }`; audit row `customer.self_managed.on` with `supersededProposalIds`.
  - top-up proposal with `shelf_id` = shelf of A but `drms_equipment_id` = device at B → superseded (Review Focus 2).
  - pending `spare_used` proposal referenced by a `cartridge_changes` row → superseded; `cartridge_changes.proposal_id` unchanged (Review Focus 3).
  - `previewSelfManaged(H)` before the switch → `{ pending: 3, devices: 2, sites: 2 }` for that fixture.
  - `setSelfManaged off` → flag false, supersedes nothing, audit `customer.self_managed.off`.
  - `getSelfManaged(A)` with flag on H → `{ selfManaged: true, source: 'head_office', headOffice: { vantageId: H } }`.
- [ ] **Step 2: Run** `npx vitest run packages/db/src/queries/customer-flags.test.ts` → FAIL.
- [ ] **Step 3: Implement** the five functions.
- [ ] **Step 4: Run** → PASS.

### Task 3: Worker — skip self-managed in all three proposal jobs

**Files:**
- Modify: `apps/worker/src/jobs/replenish-evaluate.ts`, `apps/worker/src/jobs/spare-black.ts`, `apps/worker/src/jobs/site-stock-evaluate.ts`
- Test: `apps/worker/src/jobs/replenish-evaluate.test.ts`, `spare-black.test.ts`, `site-stock-evaluate.test.ts`

**Interfaces:**
- Consumes: `eff.selfManaged`, `selfManagedSourceSql`, `supersedeSelfManagedProposals`, `SELF_MANAGED_NOTE`.
- Produces: replenish-evaluate stats gain `selfManaged: number` (devices skipped) and `selfManagedSuperseded: number`.

- [ ] **Step 1: Write failing tests:**
  - replenish-evaluate: self-managed device below threshold with a Ready Near Empty alarm → no proposal, `stats.selfManaged === 1`; a device with a device-level `autoReplenish = true` override at a self-managed customer → still no proposal.
  - replenish-evaluate: after flag turned off (row `self_managed = false`), next run proposes normally (Review Focus 4).
  - spare-black: detected black change on a self-managed device → `cartridge_changes` row with `outcome 'ineligible'`, `reason 'self_managed'` (checked before `spare_off`); no proposal.
  - site-stock-evaluate: shelf of a self-managed customer whose last spare is used → use counted (`used_*` incremented), no top-up proposal; pending top-up on it superseded with `customer self-managed`.
- [ ] **Step 2: Run** the three test files → FAIL.
- [ ] **Step 3: Implement:** replenish-evaluate calls `supersedeSelfManagedProposals` right after `supersedeHiddenProposals`, selects `eff.selfManaged`, and `continue`s for self-managed devices before evaluation (counting `stats.selfManaged`). spare-black adds `selfManaged: eff.selfManaged` and the `self_managed` reason first in the `ineligible` chain. site-stock-evaluate: select `selfManagedSourceSql(siteStockShelves.vantageCustomerId)` in `freshRows`, skip top-up for those shelves (counting continues above), and supersede their pending top-ups with `SELF_MANAGED_NOTE` in the existing pending-top-up loop.
- [ ] **Step 4: Run** the three files → PASS; then `npx vitest run apps/worker` → PASS.
- [ ] **Step 5:** `powershell -File scripts/mps.ps1 restart -Only worker` (worker code changed).

### Task 4: Customer read queries

**Files:**
- Modify: `packages/db/src/queries/customers.ts`
- Test: `packages/db/src/queries/customers.test.ts`

**Interfaces:**
- Consumes: Task 1/2 helpers, `notHiddenDevice`, `listShelves`/`ShelfSummary` (site-stock.ts), `listDevices` row shape `DeviceRow`.
- Produces:
  ```ts
  export type CustomerTab = 'with-machines' | 'self-managed' | 'head-offices' | 'all';
  export interface CustomerRow { vantageId: number; name: string | null; reference: string | null; town: string | null; machines: number; pending: number; shelves: number; sites: number; selfManaged: SelfManagedSource | null }
  export async function listCustomers(db: Db, o: { tab?: CustomerTab; search?: string; limit?: number; offset?: number }): Promise<{ rows: CustomerRow[]; total: number; counts: Record<CustomerTab, number> }>;
  export interface CustomerDetail { vantageId: number; name: string | null; reference: string | null; town: string | null; postCode: string | null; isOnStop: boolean | null; headOffice: { vantageId: number; name: string | null } | null; selfManaged: SelfManagedInfo; sites: CustomerRow[] }
  export async function getCustomer(db: Db, vantageId: number): Promise<CustomerDetail | null>; // null when not found or deleted
  export async function listCustomerDevices(db: Db, customerIds: number[]): Promise<{ visible: DeviceRow[]; hidden: DeviceRow[] }>;
  export async function listCustomerOrders(db: Db, customerIds: number[], since: Date): Promise<CustomerOrder[]>; // toner sales-order lines, newest first, with device display name
  export async function listCustomerShelves(db: Db, customerIds: number[]): Promise<ShelfSummary[]>;
  ```
- `machines` = active linked, not hidden DRMS devices across the customer (and, for a head office row, its sites); `pending` = pending proposals on those devices; `shelves` on those customer ids; `sites` = count of customers with HeadOfficeId = it (0 for sites). Search: name, reference, town (ilike, escape `%`/`_` as `containsPattern` does). Sort: name A–Z. `CustomerOrder` reuses the shape `OrderHistory` takes (check `listDeviceOrders` in `device.ts` and match it, adding `deviceName`).

- [ ] **Step 1: Write failing tests:** tab counts on the fixture (with-machines excludes a customer with only a hidden device); `self-managed` tab lists the head office and its sites (source `head_office`); search by town; head-office row `machines` includes its sites; `getCustomer` of a site returns `headOffice`, of a head office returns `sites`; `listCustomerOrders` excludes an order 13 months old; `listCustomerDevices` splits hidden.
- [ ] **Step 2: Run** `npx vitest run packages/db/src/queries/customers.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → 0 errors.

### Task 5: `/customers` list + sidebar

**Files:**
- Create: `apps/web/src/app/(app)/customers/page.tsx`
- Modify: `apps/web/src/components/app-sidebar.tsx` (NavLink "Customers", icon `Building2` from lucide-react, between Devices and Toner orders)
- Test: `apps/web/src/components/customers.test.ts` (pure helpers only, if any: tab parsing / search params)

**Interfaces:**
- Consumes: `listCustomers`, `CustomerTab`; existing `PageHeader`, `FilterTabs`, `SearchInput`, `Pagination`, `ToneBadge`.

- [ ] **Step 1:** Write failing test for `parseCustomerSearchParams(sp): { tab: CustomerTab; search: string; page: number }` (unknown tab → `'with-machines'`, page < 1 → 1). Run → FAIL.
- [ ] **Step 2:** Implement helper (in `apps/web/src/components/customers.ts`) and the page: tabs With machines / Self-managed / Head offices / All with counts; columns Name, Ref, Town, Machines, Pending, Shelves, (Sites on Head offices tab), Stock (badge "Self-managed" or "via head office"); row click → `/customers/[id]`; 50 per page like Devices.
- [ ] **Step 3:** Run test → PASS; `npm run typecheck -w @mps/web` → 0.

### Task 6: `/customers/[id]` page + self-managed switch

**Files:**
- Create: `apps/web/src/app/(app)/customers/[id]/page.tsx`, `apps/web/src/app/(app)/customers/actions.ts`, `apps/web/src/components/self-managed-switch.tsx`
- Modify: `apps/web/src/components/customer-override-dialogs.tsx` / `settings-dialog.tsx` only if a customer-scoped "Edit settings" entry point for a known customer does not already exist (add a `vantageCustomerId` prop rather than a picker)

**Interfaces:**
- Consumes: `getCustomer`, `listCustomerDevices`, `listCustomerOrders`, `listCustomerShelves`, `previewSelfManaged`, `setSelfManaged`, existing `DeviceTable`, `OrderHistory`, `HoldingsForm`, `NewShelfDialog` (pre-select this customer), `DeleteShelfDialog`, customer settings dialog + `ResetCustomerDialog`, `Breadcrumb`.
- Produces: server actions `setSelfManagedAction(formData)` (fields `vantageCustomerId`, `on`, `note`) → `requireUser()`, calls `setSelfManaged`, `revalidatePath('/customers')`, `revalidatePath('/customers/[id]', 'page')`, `revalidatePath('/orders')`.

- [ ] **Step 1:** Page layout per spec sketch: header (name, ref, town, head office link), Self-managed switch, banner when on ("Self-managed stock — no toner proposals for this customer's machines", who/when/note, or "via head office <link>"), Settings card (customer-level values + Edit + Reset), Sites (head office only), Machines (visible rows; collapsed "Hidden (n)"), Toner orders (12 months), Shelves (holdings inline edit, delete, New shelf pre-filled). 404 via `notFound()` when `getCustomer` is null or id not an integer.
- [ ] **Step 2:** `SelfManagedSwitch`: off→on opens confirm dialog showing `previewSelfManaged` counts ("Clears 3 pending proposals on 2 machines across 2 sites") and an optional note; on→off plain confirm; disabled with link when `source === 'head_office'` and viewing a site.
- [ ] **Step 3:** `npm run typecheck -w @mps/web` and `npm run lint` → clean.
- [ ] **Step 4:** Restart web (`scripts/mps.ps1 build` then `restart -Only web`); `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/customers` → 307 (login redirect) or 200, no 500 in `scripts/mps.ps1 logs -Only web`.

### Task 7: Self-managed visible elsewhere

**Files:**
- Modify: `packages/db/src/queries/devices.ts` (`replenish` option gains `'self-managed'`; `DeviceRow` gains `selfManaged: boolean`), `apps/web/src/components/device-filter-bar.tsx`, `apps/web/src/lib/device-filters.ts`, `apps/web/src/components/device-table-row.tsx` (badge → customer page), `apps/web/src/components/replenishment-card.tsx` ("Customer manages its own stock" + link, no proposal controls), `apps/web/src/app/(app)/devices/[id]/page.tsx` (badge), `apps/web/src/app/(app)/site-stock/[id]/page.tsx` (banner + customer link), `apps/web/src/app/(app)/settings/replenishment/page.tsx` (customer names link to `/customers/[id]`), Fleet overview filter if it shares `device-filters.ts`
- Test: `packages/db/src/queries/queries.test.ts` (devices list), `apps/web/src/lib/device-filters` test if present

- [ ] **Step 1:** Failing test: `listDevices(db, { replenish: 'self-managed' })` returns only self-managed devices; rows carry `selfManaged`. Run → FAIL.
- [ ] **Step 2:** Implement query + UI edits.
- [ ] **Step 3:** Run test → PASS; `npm run typecheck`, `npm run lint` → clean.

### Task 8: Full verification

- [ ] **Step 1:** `npm test` → all pass (note known flaky-under-load hook timeouts; rerun those files alone).
- [ ] **Step 2:** `npm run typecheck` → 0; `npm run lint` → 0 errors.
- [ ] **Step 3:** `powershell -File scripts/mps.ps1 build` then `restart`; `status` shows worker + web running; trigger replenish-evaluate from `/admin/jobs` (or wait for the schedule) and check its stats include `selfManaged`.
- [ ] **Step 4:** Read-only sanity SQL: `select count(*) from customer_flags;` (0 until the user flips one) and that no pending proposal exists on a self-managed device: join from Task 2's rule returns 0.
- [ ] **Step 5:** Hand to user for click-through; Opus final whole-branch review; commit only with user OK.
