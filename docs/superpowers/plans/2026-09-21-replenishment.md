# MPS Brain Sub-project 3 — Replenishment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn low toner (our cascaded thresholds) and DRMS consumable alarms into operator-approved, real Vantage consumable orders, with per-device / per-customer / default settings editable in bulk.

**Architecture:** Settings live in one `replenishment_settings` table (scopes default / customer / device) and are resolved **once, in SQL** (`effectiveSettingsSubquery`), so every count, filter and the engine agree. A pure engine in `@mps/core` turns a device's levels, alarms and order history into proposal candidates; a worker job (`replenish-evaluate`) persists them. The web app's review queue approves proposals into `replenishment_orders` rows and queues `vantage-order-submit`, the **only** code that writes to Vantage — one POST per order, never retried, behind a kill switch that defaults off.

**Tech Stack:** Existing monorepo — TypeScript/ESM, Drizzle + Postgres (PGlite in tests), pg-boss, Next.js 16 App Router + React 19 + Tailwind v4 + shadcn/ui, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-replenishment-design.md` (read it first). Background: `docs/superpowers/specs/2026-09-17-mps-foundation-design.md` → "Replenishment settings", "Bulk settings", "Mono vs colour devices", "Needs toner tile destination". Design source: `mockups of dashboard/Toner ordering@2x.png` (visual style only; the left "New order" panel is out of scope).

## Global Constraints

- Repo `C:\dev\mps-brain`. Branch **`feat/replenishment` off `feat/foundation-web`** (Foundation Part 2 is not merged to `main` yet). Windows 10, Node 24, Git Bash.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Stage explicit paths only. Commit per task; **push only when the user says** (they batch pushes).
- Never read or print `.env` or `F:\dev\API Docs Etc\API Keys.txt`. Secrets come from env only. Never log tokens.
- **Stop the dev worker before editing `apps/worker`** (tsx watch restarts it mid-job).
- The **only** Vantage write in the codebase is `createConsumableOrder`, called **only** by the `vantage-order-submit` job. The web app never calls Vantage or DRMS. DRMS stays read-only (no `EquipmentRequest/*` from app code).
- **Never retry a Vantage POST.** A timeout, network error or 5xx means "uncertain": record it and stop. A 401 before processing may be re-sent once after re-login (the request was not accepted).
- `VANTAGE_ORDERS_ENABLED` defaults to **false**. Only the user turns it on.
- Defaults (seeded, editable): black **15**, cyan/magenta/yellow **10**, auto-replenish **on**, alerts **on**. Threshold rule: `level < threshold` (strictly below). Thresholds are integers 0–100.
- Engine constants (in `packages/core/src/replenishment.ts`): alarm window **7 days**, completed-order suppression **14 days**, rejection suppression **7 days**, alarm status **`ReadyForErpDelivery`**.
- Vantage consumable `Type`: black 1, cyan 2, magenta 3, yellow 4, waste 5 (staples 6 unused).
- Mono devices (`drms_equipment.is_colour = false`) never get cyan/magenta/yellow proposals, and the UI never shows CMY thresholds for them.
- Display: Europe/London; reuse `apps/web/src/lib/format.ts`. Toner bar colours stay 5% / 20% (display scale, not the ordering rule).
- Tests: Vitest; PGlite (`createTestDb()`) for anything touching the DB; fake clients, never live APIs. No DOM tests. Run the affected package's tests, then `npm run typecheck` and `npm run lint` before every commit.
- Every server action calls `requireUser()` first and takes the user id **from the session**, never from the form. Any signed-in user may change settings and decide proposals.
- UI tasks (10–13) use **opus**; match the existing components (`Card`, `PageHeader`, `FilterTabs`, `StatCard`, `ToneBadge`, `ui/*`) and the mockup's look.

## File Map

```
packages/core/src/errors.ts                         T1  + UncertainWriteError
packages/vantage/src/client.ts (+test)              T1  post(), createConsumableOrder()
apps/worker/scripts/probe-consumable-order.ts       T1  one live order, user-gated
packages/db/src/schema.ts, drizzle/0007_*.sql       T2  4 tables + default row
packages/db/src/queries/settings.ts (+test)         T3  cascade subquery, reads, writes, audit
packages/core/src/replenishment.ts (+test)          T4  engine (pure)
packages/db/src/queries/order-state.ts (+test)      T5  per equipment+colour order state
apps/worker/src/jobs/replenish-evaluate.ts (+test)  T6  proposals job
packages/queue/src/index.ts                         T6/T8 new queue names
apps/worker/src/handlers.ts, main.ts, queue-options T6/T8 wiring
packages/db/src/queries/replenishment.ts (+test)    T7  queue reads + approve/reject/resolve actions
apps/worker/src/jobs/vantage-order-submit.ts (+test) T8 the one Vantage writer, kill switch
apps/worker/src/jobs/vantage-orders.ts              T8  mark created_by_mps
packages/db/src/queries/fleet.ts, devices.ts        T9  cascade-based needs-toner, manual filter
apps/worker/src/jobs/alerts-evaluate.ts             T9  honour alerts_enabled
apps/web/src/app/(app)/orders/*                     T10 review queue page + actions
apps/web/src/components/replenishment-*.tsx         T10–T13
apps/web/src/app/(app)/devices/[id]/page.tsx        T11 Replenishment card
apps/web/src/app/(app)/devices/*                    T12 selection + bulk bar
apps/web/src/app/(app)/settings/replenishment/*     T13 default + customer overrides
docs/TEST-REPORT-*.md, docs/HANDOFF.md, spec        T14
```

---

### Task 1: Vantage `createConsumableOrder` + the first live order (user-gated)

**Files:**
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/vantage/src/client.ts`
- Test: `packages/vantage/src/client.test.ts`
- Create: `apps/worker/scripts/probe-consumable-order.ts`
- Modify: `docs/superpowers/specs/2026-09-21-replenishment-design.md` (the "to be confirmed live" section)

**Interfaces:**
- Produces: `class UncertainWriteError extends ApiError` (`@mps/core`); `VantageClient.createConsumableOrder(equipmentId: number, components: ConsumableComponent[]): Promise<ConsumableOrderResponse>`; types `ConsumableType = 1|2|3|4|5|6`, `ConsumableComponent { Type: ConsumableType; RequestedPartNumber?: string | null; RequestedQuantity?: number | null }`, `ConsumableOrderResponse { status: number; body: unknown }`; constant `CONSUMABLE_ORDER_PATH(id)`.

- [ ] **Step 1: Add the error type**

Append to `packages/core/src/errors.ts`:

```ts
/**
 * A write whose outcome is unknown: the request may or may not have been applied (timeout,
 * dropped connection, 5xx). Never retry one — a person has to look at the other system first.
 */
export class UncertainWriteError extends ApiError {}
```

- [ ] **Step 2: Write the failing client tests**

In `packages/vantage/src/client.test.ts`, extend `fakeFetch`'s `Req` with `body?: string` (set `body: init?.body as string | undefined`) and add:

```ts
describe('createConsumableOrder', () => {
  const login = (req: Req) => req.url.pathname.endsWith('/application/loginsingle');

  it('POSTs the components with api-version and a bearer token, and returns status + body', async () => {
    const { client, calls } = make((req) =>
      login(req) ? session('t1', '2026-09-17T11:00:00Z') : json({ Id: 991, Reference: 'SO991' }, 201),
    );
    const res = await client.createConsumableOrder(42, [{ Type: 1, RequestedQuantity: 2 }]);
    expect(res).toEqual({ status: 201, body: { Id: 991, Reference: 'SO991' } });
    const post = calls.find((c) => c.method === 'POST' && !login(c))!;
    expect(post.url.pathname).toBe('/Equipment(42)/CreateConsumableOrder');
    expect(post.headers['api-version']).toBe('1.22');
    expect(post.headers.authorization).toBe('Bearer t1');
    expect(JSON.parse(post.body!)).toEqual({ components: [{ Type: 1, RequestedQuantity: 2 }] });
  });

  it('accepts a 204 with no body', async () => {
    const { client } = make((req) => (login(req) ? session('t1', '2026-09-17T11:00:00Z') : new Response(null, { status: 204 })));
    expect(await client.createConsumableOrder(42, [{ Type: 5 }])).toEqual({ status: 204, body: null });
  });

  it('throws HttpError on a 4xx and sends exactly one POST', async () => {
    const { client, calls } = make((req) => (login(req) ? session('t1', '2026-09-17T11:00:00Z') : json({ Message: 'no compatible toner' }, 400)));
    await expect(client.createConsumableOrder(42, [{ Type: 2 }])).rejects.toMatchObject({ name: 'HttpError', status: 400 });
    expect(calls.filter((c) => c.method === 'POST' && !login(c))).toHaveLength(1);
  });

  it('treats a 5xx as uncertain and never re-sends', async () => {
    const { client, calls } = make((req) => (login(req) ? session('t1', '2026-09-17T11:00:00Z') : json({}, 502)));
    await expect(client.createConsumableOrder(42, [{ Type: 1 }])).rejects.toMatchObject({ name: 'UncertainWriteError' });
    expect(calls.filter((c) => c.method === 'POST' && !login(c))).toHaveLength(1);
  });

  it('treats a network failure as uncertain and never re-sends', async () => {
    let posts = 0;
    const { client } = make((req) => {
      if (login(req)) return session('t1', '2026-09-17T11:00:00Z');
      posts++;
      throw new TypeError('fetch failed');
    });
    await expect(client.createConsumableOrder(42, [{ Type: 1 }])).rejects.toMatchObject({ name: 'UncertainWriteError' });
    expect(posts).toBe(1);
  });

  it('re-logs in and re-sends once after a 401 (the order was not accepted)', async () => {
    let posts = 0;
    const { client } = make((req) => {
      if (login(req)) return session(`t${posts}`, '2026-09-17T11:00:00Z');
      posts++;
      return posts === 1 ? json({}, 401) : json({ Id: 5 }, 201);
    });
    expect(await client.createConsumableOrder(42, [{ Type: 1 }])).toEqual({ status: 201, body: { Id: 5 } });
    expect(posts).toBe(2);
  });
});
```

(`fakeFetch`'s handler may throw; wrap `handler(req)` so a thrown error rejects the fetch promise — it already does, since the fake is `async`.)

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run packages/vantage`
Expected: FAIL — `client.createConsumableOrder is not a function`.

- [ ] **Step 4: Implement**

In `packages/vantage/src/client.ts`:

```ts
import { AuthError, HttpError, ParseError, UncertainWriteError, errorMessage, getField, getNumber, getString, parseApiDate } from '@mps/core';

/** Vantage consumable ENUM: 1 Black, 2 Cyan, 3 Magenta, 4 Yellow, 5 Waste, 6 Staples. */
export type ConsumableType = 1 | 2 | 3 | 4 | 5 | 6;

export interface ConsumableComponent {
  Type: ConsumableType;
  /** Omitted: Vantage picks the first compatible consumable of that type. */
  RequestedPartNumber?: string | null;
  /** Null/omitted means 1. */
  RequestedQuantity?: number | null;
}

export interface ConsumableOrderResponse {
  status: number;
  body: unknown;
}

/** Confirmed live in Task 1 — change here only if the probe says otherwise. */
export const CONSUMABLE_ORDER_PATH = (equipmentId: number) => `Equipment(${equipmentId})/CreateConsumableOrder`;
```

Inside `createVantageClient`, after `get`:

```ts
  /**
   * The only write this project makes to Vantage. Deliberately not retried: a POST that timed out
   * or got a 5xx may already have created an order, so it surfaces as `UncertainWriteError` for a
   * person to check. A 401 is the one exception — Vantage rejected the token before doing anything,
   * so re-logging in and sending again cannot duplicate.
   */
  async function post(path: string, payload: unknown): Promise<ConsumableOrderResponse> {
    const send = async () => {
      try {
        return await doFetch(`${base}/${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'api-version': opts.apiVersion,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new UncertainWriteError(`Vantage POST ${path}: no response (${errorMessage(err)})`, null);
      }
    };
    await ensureToken();
    let res = await send();
    if (res.status === 401) {
      token = null;
      await ensureToken();
      res = await send();
      if (res.status === 401) throw new AuthError(`Vantage POST ${path} unauthorised after re-login`, 401);
    }
    const text = await res.text();
    if (res.status >= 500) {
      throw new UncertainWriteError(`Vantage POST ${path} failed (${res.status})`, res.status, text.slice(0, 500));
    }
    if (!res.ok) throw new HttpError(`Vantage POST ${path} failed (${res.status})`, res.status, text.slice(0, 500));
    return { status: res.status, body: parseJson(text, `POST ${path}`, res.status) };
  }
```

Add to the returned object:

```ts
    /** Raises a real consumable sales order. Only `vantage-order-submit` may call this. */
    createConsumableOrder: (equipmentId: number, components: ConsumableComponent[]) =>
      post(CONSUMABLE_ORDER_PATH(equipmentId), { components }),
```

Fix the old comment on `listSalesOrders` ("this project never creates…") to "Read-only."

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/vantage packages/core` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 6: Write the probe script**

Create `apps/worker/scripts/probe-consumable-order.ts`:

```ts
/**
 * Raises ONE real consumable order in live Vantage, to learn the exact path and response shape.
 * Usage (repo root):  npx tsx --env-file=.env apps/worker/scripts/probe-consumable-order.ts <vantageEquipmentId> <type 1-5> [qty]
 * Only run with the user present, on a device they chose because it genuinely needs that toner.
 * Prints status and body; never retries (an uncertain result must be checked in Vantage by hand).
 */
import { createVantageClient, type ConsumableType } from '@mps/vantage';

const [idArg, typeArg, qtyArg] = process.argv.slice(2);
const equipmentId = Number(idArg);
const type = Number(typeArg) as ConsumableType;
if (!Number.isInteger(equipmentId) || ![1, 2, 3, 4, 5].includes(type)) {
  console.error('usage: probe-consumable-order.ts <vantageEquipmentId> <type 1-5> [qty]');
  process.exit(2);
}
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k}`);
  return v;
};
const vantage = createVantageClient({
  baseUrl: env('VANTAGE_BASE_URL'),
  username: env('VANTAGE_USER'),
  password: env('VANTAGE_PASS'),
  apiVersion: process.env.VANTAGE_API_VERSION ?? '1.22',
});
const res = await vantage.createConsumableOrder(equipmentId, [
  { Type: type, RequestedQuantity: qtyArg ? Number(qtyArg) : null },
]);
console.log(JSON.stringify(res, null, 2));
```

Run `npm run typecheck`, then commit Steps 1–6:

```bash
git add packages/core/src/errors.ts packages/vantage/src/client.ts packages/vantage/src/client.test.ts apps/worker/scripts/probe-consumable-order.ts
git commit -m "feat(vantage): add createConsumableOrder, the one Vantage write, never retried"
```

- [ ] **Step 7: STOP — live order with the user**

Do not continue until the user is present. Ask them for **one device that genuinely needs a toner now** (its Vantage equipment id and the colour). Run the probe once. If it returns 404, report it — do **not** try another path without the user's OK (a 404 was not processed, so trying `Equipment(id)CreateConsumableOrder` without the slash is safe, but it is their call). Then check the order in Vantage with them and record in the spec's "Vantage API — to be confirmed live" section: the working path, status code, the response body's fields (is there `Id`? `Reference`? `IsOnHold`?), whether `Type` as a number was accepted, and what the order looks like in Vantage (type name, lines, `Details` text). Commit the spec edit:

```bash
git add docs/superpowers/specs/2026-09-21-replenishment-design.md
git commit -m "docs(spec): record the live CreateConsumableOrder findings"
```

If the response has **no order id**, Task 8's "Response parsing" step must be adjusted before it is built (flag it to the controller).

---

### Task 2: Schema — settings, audit log, proposals, orders

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0007_replenishment.sql` (generated, then the seed appended)
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Produces tables `replenishmentSettings`, `auditLog`, `replenishmentProposals`, `replenishmentOrders`; types `SettingScope = 'default'|'customer'|'device'`, `ReplenishColour = 'black'|'cyan'|'magenta'|'yellow'|'waste'`, `ProposalStatus`, `ProposalTrigger`, `OrderStatus` exported from `schema.ts`.

- [ ] **Step 1: Write the failing schema test**

Add to `packages/db/src/schema.test.ts` (reuse its `createTestDb` setup):

```ts
describe('replenishment schema', () => {
  it('seeds exactly one default settings row with the agreed defaults', async () => {
    const rows = await t.db.select().from(replenishmentSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'default', thresholdBlack: 15, thresholdCyan: 10, thresholdMagenta: 10, thresholdYellow: 10,
      autoReplenish: true, alertsEnabled: true, drmsEquipmentId: null, vantageCustomerId: null,
    });
  });

  it('allows one settings row per device and per customer', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd1', raw: {} });
    await t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'd1', thresholdBlack: 20 });
    await expect(
      t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'd1', thresholdBlack: 30 }),
    ).rejects.toThrow();
    await t.db.insert(replenishmentSettings).values({ scope: 'customer', vantageCustomerId: 7, autoReplenish: false });
    await expect(t.db.insert(replenishmentSettings).values({ scope: 'customer', vantageCustomerId: 7 })).rejects.toThrow();
    await expect(t.db.insert(replenishmentSettings).values({ scope: 'default' })).rejects.toThrow();
  });

  it('rejects a device row without a device id and a threshold outside 0-100', async () => {
    await expect(t.db.insert(replenishmentSettings).values({ scope: 'device' })).rejects.toThrow();
    await t.db.insert(drmsEquipment).values({ drmsId: 'd2', raw: {} });
    await expect(
      t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'd2', thresholdCyan: 101 }),
    ).rejects.toThrow();
  });

  it('allows only one live proposal per device and colour', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd3', raw: {} });
    const base = { drmsEquipmentId: 'd3', colour: 'cyan', trigger: 'threshold' } as const;
    await t.db.insert(replenishmentProposals).values({ ...base, status: 'pending' });
    await expect(t.db.insert(replenishmentProposals).values({ ...base, status: 'approved' })).rejects.toThrow();
    await t.db.insert(replenishmentProposals).values({ ...base, status: 'rejected' });
    await t.db.insert(replenishmentProposals).values({ ...base, colour: 'black', status: 'pending' });
  });
});
```

Import `drmsEquipment, replenishmentProposals, replenishmentSettings` from `./schema`.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run packages/db/src/schema.test.ts` → FAIL (no such exports).

- [ ] **Step 3: Add the tables**

In `packages/db/src/schema.ts` add `check` to the `drizzle-orm/pg-core` import, then append:

```ts
export type SettingScope = 'default' | 'customer' | 'device';
export type ReplenishColour = 'black' | 'cyan' | 'magenta' | 'yellow' | 'waste';
export type ProposalTrigger = 'threshold' | 'alarm';
export type ProposalStatus = 'pending' | 'approved' | 'ordered' | 'failed' | 'rejected' | 'superseded';
export type OrderStatus = 'queued' | 'submitting' | 'submitted' | 'failed' | 'uncertain';

/**
 * Replenishment settings, cascading default → customer → device. A null column means "inherit";
 * the single `default` row (seeded by migration 0007) has no nulls. The cascade is resolved in one
 * place, `effectiveSettingsSubquery` (queries/settings.ts), never re-expressed elsewhere.
 *
 * A device's customer is the **Vantage** customer of its linked equipment, so `vantage_customer_id`
 * is the customer key; an unlinked device skips the customer level.
 */
export const replenishmentSettings = pgTable(
  'replenishment_settings',
  {
    id: serial('id').primaryKey(),
    scope: text('scope', { enum: ['default', 'customer', 'device'] }).notNull(),
    vantageCustomerId: integer('vantage_customer_id'),
    drmsEquipmentId: text('drms_equipment_id').references(() => drmsEquipment.drmsId),
    thresholdBlack: integer('threshold_black'),
    thresholdCyan: integer('threshold_cyan'),
    thresholdMagenta: integer('threshold_magenta'),
    thresholdYellow: integer('threshold_yellow'),
    autoReplenish: boolean('auto_replenish'),
    alertsEnabled: boolean('alerts_enabled'),
    updatedBy: integer('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('replenishment_settings_default_uq').on(t.scope).where(sql`scope = 'default'`),
    uniqueIndex('replenishment_settings_customer_uq').on(t.vantageCustomerId).where(sql`scope = 'customer'`),
    uniqueIndex('replenishment_settings_device_uq').on(t.drmsEquipmentId).where(sql`scope = 'device'`),
    check(
      'replenishment_settings_scope_key',
      sql`(scope = 'default' and vantage_customer_id is null and drms_equipment_id is null)
       or (scope = 'customer' and vantage_customer_id is not null and drms_equipment_id is null)
       or (scope = 'device' and drms_equipment_id is not null and vantage_customer_id is null)`,
    ),
    check(
      'replenishment_settings_threshold_range',
      sql`coalesce(threshold_black, 0) between 0 and 100 and coalesce(threshold_cyan, 0) between 0 and 100
       and coalesce(threshold_magenta, 0) between 0 and 100 and coalesce(threshold_yellow, 0) between 0 and 100`,
    ),
  ],
);

/** Who changed what. One row per write — a bulk edit of 400 devices is one row listing 400 ids. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    at: ts('at').notNull().defaultNow(),
    userId: integer('user_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityIds: jsonb('entity_ids').notNull().default([]),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [index('audit_log_entity_at_idx').on(t.entity, t.at)],
);

/** Sent (or to be sent) to Vantage as one CreateConsumableOrder call: one device, 1..n components. */
export const replenishmentOrders = pgTable(
  'replenishment_orders',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    vantageEquipmentId: integer('vantage_equipment_id').notNull(),
    status: text('status', { enum: ['queued', 'submitting', 'submitted', 'failed', 'uncertain'] }).notNull(),
    /** Exactly the body POSTed (or about to be). */
    request: jsonb('request').notNull(),
    response: jsonb('response'),
    vantageSalesOrderId: integer('vantage_sales_order_id'),
    vantageReference: text('vantage_reference'),
    isOnHold: boolean('is_on_hold'),
    error: text('error'),
    createdBy: integer('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    submittedAt: ts('submitted_at'),
    /** Set when an operator settles an `uncertain` order by hand. */
    resolvedBy: integer('resolved_by').references(() => users.id),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    index('replenishment_orders_status_idx').on(t.status),
    index('replenishment_orders_device_idx').on(t.drmsEquipmentId, t.createdAt),
  ],
);

/** One per device + colour per episode; see the status table in the spec. */
export const replenishmentProposals = pgTable(
  'replenishment_proposals',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    vantageEquipmentId: integer('vantage_equipment_id'),
    colour: text('colour', { enum: ['black', 'cyan', 'magenta', 'yellow', 'waste'] }).notNull(),
    trigger: text('trigger', { enum: ['threshold', 'alarm'] }).notNull(),
    /** Toner % when proposed; null for waste (DRMS has no waste counter). */
    level: doublePrecision('level'),
    threshold: integer('threshold'),
    alarmId: text('alarm_id'),
    alarmDescription: text('alarm_description'),
    quantity: integer('quantity').notNull().default(1),
    status: text('status', {
      enum: ['pending', 'approved', 'ordered', 'failed', 'rejected', 'superseded'],
    }).notNull(),
    orderId: integer('order_id').references(() => replenishmentOrders.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    decidedBy: integer('decided_by').references(() => users.id),
    decidedAt: ts('decided_at'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('replenishment_proposals_live_uq')
      .on(t.drmsEquipmentId, t.colour)
      .where(sql`status in ('pending', 'approved')`),
    index('replenishment_proposals_status_idx').on(t.status, t.createdAt),
    check('replenishment_proposals_quantity', sql`quantity between 1 and 20`),
  ],
);
```

- [ ] **Step 4: Generate the migration and append the seed**

Run: `cd packages/db && npx drizzle-kit generate --name replenishment`
Rename the output to `drizzle/0007_replenishment.sql` if drizzle picked a different suffix **and** update the tag in `drizzle/meta/_journal.json` to match. Append to the SQL file:

```sql
--> statement-breakpoint
-- The one default row. Every threshold here is the agreed starting point (spec 2026-09-21):
-- black 15%, cyan/magenta/yellow 10%, auto-replenish and alerts on. Editable from the UI.
INSERT INTO "replenishment_settings" ("scope", "threshold_black", "threshold_cyan", "threshold_magenta", "threshold_yellow", "auto_replenish", "alerts_enabled")
VALUES ('default', 15, 10, 10, 10, true, true);
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/db` → PASS (the existing tests still pass: the seed only adds a row to a new table). Then `npm run typecheck && npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/drizzle/0007_replenishment.sql packages/db/drizzle/meta
git commit -m "feat(db): replenishment settings, proposals, orders and audit log"
```

---

### Task 3: Settings cascade and settings writes

**Files:**
- Create: `packages/db/src/queries/settings.ts`
- Modify: `packages/db/src/queries/index.ts` (add `export * from './settings';`)
- Test: `packages/db/src/queries/settings.test.ts`

**Interfaces:**
- Consumes: T2 tables.
- Produces:
  - `type SettingSource = 'device' | 'customer' | 'default'`
  - `effectiveSettingsSubquery(db)` — aliased subquery `effective_settings` with columns `drmsId, vantageEquipmentId: number|null, vantageCustomerId: number|null, thresholdBlack, thresholdCyan, thresholdMagenta, thresholdYellow: number, thresholdBlackSource … thresholdYellowSource: SettingSource, autoReplenish: boolean, autoReplenishSource: SettingSource, alertsEnabled: boolean, alertsEnabledSource: SettingSource`
  - `interface EffectiveSettings { thresholds: Record<'black'|'cyan'|'magenta'|'yellow', { value: number; source: SettingSource }>; autoReplenish: { value: boolean; source: SettingSource }; alertsEnabled: { value: boolean; source: SettingSource }; deviceRow: SettingsRowMeta | null; customerRow: SettingsRowMeta | null }`, `interface SettingsRowMeta { updatedAt: Date; updatedBy: string | null }`
  - `getDeviceSettings(db, drmsId): Promise<EffectiveSettings | null>`
  - `interface SettingsPatch { thresholdBlack?: number|null; thresholdCyan?: number|null; thresholdMagenta?: number|null; thresholdYellow?: number|null; autoReplenish?: boolean|null; alertsEnabled?: boolean|null }` — key absent = leave alone, `null` = inherit
  - `updateDeviceSettings(db, { drmsIds: string[]; patch: SettingsPatch; userId: number; now?: Date }): Promise<{ updated: number }>`
  - `updateCustomerSettings(db, { vantageCustomerId: number; patch: SettingsPatch; userId: number; now?: Date }): Promise<void>`
  - `updateDefaultSettings(db, { patch: SettingsPatch; userId: number; now?: Date }): Promise<void>` (rejects `null`s)
  - `listCustomerSettings(db): Promise<CustomerSettingsRow[]>` where `CustomerSettingsRow { vantageCustomerId: number; customerName: string|null; reference: string|null; deviceCount: number; thresholdBlack…thresholdYellow: number|null; autoReplenish: boolean|null; alertsEnabled: boolean|null; updatedAt: Date; updatedBy: string|null }`
  - `class SettingsError extends Error { code: 'invalid_threshold'|'empty_patch'|'default_null'|'no_devices' }`

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/queries/settings.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, deviceLinks, drmsEquipment, replenishmentSettings, users, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import {
  SettingsError,
  effectiveSettingsSubquery,
  getDeviceSettings,
  listCustomerSettings,
  updateCustomerSettings,
  updateDefaultSettings,
  updateDeviceSettings,
} from './settings';

describe('replenishment settings', () => {
  let t: TestDb;
  let userId: number;
  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'linked', raw: {} },
      { drmsId: 'other', raw: {} },
      { drmsId: 'unlinked', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 100, vantageCustomerId: 7, customerName: 'Acme', raw: {} },
      { vantageId: 101, vantageCustomerId: 7, customerName: 'Acme', raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'linked', vantageEquipmentId: 100, method: 'serial' },
      { drmsEquipmentId: 'other', vantageEquipmentId: 101, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  async function effective() {
    const eff = effectiveSettingsSubquery(t.db);
    const rows = await t.db.select().from(eff);
    return Object.fromEntries(rows.map((r) => [r.drmsId, r]));
  }

  it('gives every device the defaults, sourced from default', async () => {
    const e = await effective();
    expect(e.unlinked).toMatchObject({
      thresholdBlack: 15, thresholdBlackSource: 'default', thresholdCyan: 10, autoReplenish: true,
      alertsEnabled: true, vantageCustomerId: null,
    });
    expect(e.linked).toMatchObject({ vantageEquipmentId: 100, vantageCustomerId: 7 });
  });

  it('cascades device over customer over default, per field', async () => {
    await updateCustomerSettings(t.db, { vantageCustomerId: 7, patch: { thresholdCyan: 25, autoReplenish: false }, userId });
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdCyan: 30 }, userId });
    const e = await effective();
    expect(e.linked).toMatchObject({ thresholdCyan: 30, thresholdCyanSource: 'device', autoReplenish: false, autoReplenishSource: 'customer', thresholdBlackSource: 'default' });
    expect(e.other).toMatchObject({ thresholdCyan: 25, thresholdCyanSource: 'customer' });
    expect(e.unlinked).toMatchObject({ thresholdCyan: 10, autoReplenish: true });
  });

  it('null resets a device field to inherited and deletes an all-null device row', async () => {
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: 40, alertsEnabled: false }, userId });
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: null }, userId });
    let e = await effective();
    expect(e.linked).toMatchObject({ thresholdBlack: 15, thresholdBlackSource: 'default', alertsEnabled: false });
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { alertsEnabled: null }, userId });
    const rows = await t.db.select().from(replenishmentSettings).where(eq(replenishmentSettings.scope, 'device'));
    expect(rows).toEqual([]);
    e = await effective();
    expect(e.linked?.alertsEnabledSource).toBe('default');
  });

  it('writes a bulk edit in one transaction with one audit row', async () => {
    const res = await updateDeviceSettings(t.db, { drmsIds: ['linked', 'other', 'unlinked'], patch: { thresholdYellow: 12 }, userId });
    expect(res.updated).toBe(3);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'settings.update', entity: 'device', userId, details: { patch: { thresholdYellow: 12 } } });
    expect(audits[0]!.entityIds).toEqual(['linked', 'other', 'unlinked']);
  });

  it('leaves nothing behind when one device in a bulk edit is invalid', async () => {
    await expect(
      updateDeviceSettings(t.db, { drmsIds: ['linked', 'missing-device'], patch: { thresholdBlack: 20 }, userId }),
    ).rejects.toThrow();
    expect(await t.db.select().from(replenishmentSettings).where(eq(replenishmentSettings.scope, 'device'))).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('validates thresholds and patches', async () => {
    await expect(updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: 101 }, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: 1.5 }, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: {}, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDeviceSettings(t.db, { drmsIds: [], patch: { thresholdBlack: 5 }, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDefaultSettings(t.db, { patch: { thresholdBlack: null }, userId })).rejects.toBeInstanceOf(SettingsError);
  });

  it('updates the default row', async () => {
    await updateDefaultSettings(t.db, { patch: { thresholdBlack: 12 }, userId });
    expect((await effective()).unlinked?.thresholdBlack).toBe(12);
  });

  it('reads one device with row metadata', async () => {
    await updateCustomerSettings(t.db, { vantageCustomerId: 7, patch: { thresholdCyan: 25 }, userId, now: new Date('2026-09-21T10:00:00Z') });
    const s = await getDeviceSettings(t.db, 'linked');
    expect(s?.thresholds.cyan).toEqual({ value: 25, source: 'customer' });
    expect(s?.customerRow).toEqual({ updatedAt: new Date('2026-09-21T10:00:00Z'), updatedBy: 'op' });
    expect(s?.deviceRow).toBeNull();
    expect(await getDeviceSettings(t.db, 'nope')).toBeNull();
  });

  it('lists customer overrides with their device counts', async () => {
    await updateCustomerSettings(t.db, { vantageCustomerId: 7, patch: { autoReplenish: false }, userId });
    const rows = await listCustomerSettings(t.db);
    expect(rows).toEqual([expect.objectContaining({ vantageCustomerId: 7, customerName: 'Acme', deviceCount: 2, autoReplenish: false, updatedBy: 'op' })]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run packages/db/src/queries/settings.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `packages/db/src/queries/settings.ts`**

```ts
import { and, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { auditLog, deviceLinks, drmsEquipment, replenishmentSettings, users, vantageCustomers, vantageEquipment } from '../schema';

export type SettingSource = 'device' | 'customer' | 'default';

export type SettingsErrorCode = 'invalid_threshold' | 'empty_patch' | 'default_null' | 'no_devices';

/** Anything an operator can get wrong from the UI; always safe to show them. */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly code: SettingsErrorCode,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

const THRESHOLD_KEYS = ['thresholdBlack', 'thresholdCyan', 'thresholdMagenta', 'thresholdYellow'] as const;
const FLAG_KEYS = ['autoReplenish', 'alertsEnabled'] as const;
const SETTING_KEYS = [...THRESHOLD_KEYS, ...FLAG_KEYS] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

/** Key absent = leave alone; `null` = inherit from the level above. */
export type SettingsPatch = {
  thresholdBlack?: number | null;
  thresholdCyan?: number | null;
  thresholdMagenta?: number | null;
  thresholdYellow?: number | null;
  autoReplenish?: boolean | null;
  alertsEnabled?: boolean | null;
};

const dev = alias(replenishmentSettings, 'rs_device');
const cus = alias(replenishmentSettings, 'rs_customer');
const def = alias(replenishmentSettings, 'rs_default');

function resolved<T>(key: SettingKey) {
  return sql<T>`coalesce(${dev[key]}, ${cus[key]}, ${def[key]})`;
}
function source(key: SettingKey) {
  return sql<SettingSource>`case when ${dev[key]} is not null then 'device' when ${cus[key]} is not null then 'customer' else 'default' end`;
}

/**
 * One row per DRMS device with every effective setting and where it came from. THE place the
 * cascade is expressed: the engine, fleet counts, devices filters, the queue and the device page
 * all read this, so they cannot disagree. Left-join it (or select from it) on `drmsId`.
 */
export function effectiveSettingsSubquery(db: Db) {
  return db
    .select({
      drmsId: drmsEquipment.drmsId,
      vantageEquipmentId: deviceLinks.vantageEquipmentId,
      vantageCustomerId: vantageEquipment.vantageCustomerId,
      thresholdBlack: resolved<number>('thresholdBlack').as('eff_threshold_black'),
      thresholdBlackSource: source('thresholdBlack').as('eff_threshold_black_source'),
      thresholdCyan: resolved<number>('thresholdCyan').as('eff_threshold_cyan'),
      thresholdCyanSource: source('thresholdCyan').as('eff_threshold_cyan_source'),
      thresholdMagenta: resolved<number>('thresholdMagenta').as('eff_threshold_magenta'),
      thresholdMagentaSource: source('thresholdMagenta').as('eff_threshold_magenta_source'),
      thresholdYellow: resolved<number>('thresholdYellow').as('eff_threshold_yellow'),
      thresholdYellowSource: source('thresholdYellow').as('eff_threshold_yellow_source'),
      autoReplenish: resolved<boolean>('autoReplenish').as('eff_auto_replenish'),
      autoReplenishSource: source('autoReplenish').as('eff_auto_replenish_source'),
      alertsEnabled: resolved<boolean>('alertsEnabled').as('eff_alerts_enabled'),
      alertsEnabledSource: source('alertsEnabled').as('eff_alerts_enabled_source'),
    })
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(dev, and(eq(dev.scope, 'device'), eq(dev.drmsEquipmentId, drmsEquipment.drmsId)))
    .leftJoin(cus, and(eq(cus.scope, 'customer'), eq(cus.vantageCustomerId, vantageEquipment.vantageCustomerId)))
    // Exactly one default row (unique index + seed), so this is a one-row cross join.
    .innerJoin(def, eq(def.scope, 'default'))
    .as('effective_settings');
}

function validatePatch(patch: SettingsPatch, { allowNull }: { allowNull: boolean }): Partial<Record<SettingKey, unknown>> {
  const out: Partial<Record<SettingKey, unknown>> = {};
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) {
      if (!allowNull) throw new SettingsError('The default settings cannot inherit from anything.', 'default_null');
      out[key] = null;
      continue;
    }
    if ((THRESHOLD_KEYS as readonly string[]).includes(key)) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100) {
        throw new SettingsError('A threshold is a whole percentage from 0 to 100.', 'invalid_threshold');
      }
    }
    out[key] = v;
  }
  if (Object.keys(out).length === 0) throw new SettingsError('Nothing to change.', 'empty_patch');
  return out;
}

/** Delete scoped rows that no longer override anything. */
function allNull(): SQL {
  return and(...SETTING_KEYS.map((k) => isNull(replenishmentSettings[k])))!;
}

async function audit(tx: Db, userId: number, entity: string, ids: (string | number)[], patch: object, now: Date) {
  await tx.insert(auditLog).values({ at: now, userId, action: 'settings.update', entity, entityIds: ids, details: { patch } });
}

export async function updateDeviceSettings(
  db: Db,
  args: { drmsIds: string[]; patch: SettingsPatch; userId: number; now?: Date },
): Promise<{ updated: number }> {
  const now = args.now ?? new Date();
  const ids = [...new Set(args.drmsIds)];
  if (ids.length === 0) throw new SettingsError('Select at least one device.', 'no_devices');
  const values = validatePatch(args.patch, { allowNull: true });

  await db.transaction(async (tx) => {
    for (const drmsEquipmentId of ids) {
      await tx
        .insert(replenishmentSettings)
        .values({ scope: 'device', drmsEquipmentId, ...values, updatedBy: args.userId, updatedAt: now })
        .onConflictDoUpdate({
          target: replenishmentSettings.drmsEquipmentId,
          targetWhere: sql`scope = 'device'`,
          set: { ...values, updatedBy: args.userId, updatedAt: now },
        });
    }
    await tx
      .delete(replenishmentSettings)
      .where(and(eq(replenishmentSettings.scope, 'device'), inArray(replenishmentSettings.drmsEquipmentId, ids), allNull()));
    await audit(tx as unknown as Db, args.userId, 'device', ids, values, now);
  });
  return { updated: ids.length };
}

export async function updateCustomerSettings(
  db: Db,
  args: { vantageCustomerId: number; patch: SettingsPatch; userId: number; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const values = validatePatch(args.patch, { allowNull: true });
  await db.transaction(async (tx) => {
    await tx
      .insert(replenishmentSettings)
      .values({ scope: 'customer', vantageCustomerId: args.vantageCustomerId, ...values, updatedBy: args.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: replenishmentSettings.vantageCustomerId,
        targetWhere: sql`scope = 'customer'`,
        set: { ...values, updatedBy: args.userId, updatedAt: now },
      });
    await tx
      .delete(replenishmentSettings)
      .where(and(eq(replenishmentSettings.scope, 'customer'), eq(replenishmentSettings.vantageCustomerId, args.vantageCustomerId), allNull()));
    await audit(tx as unknown as Db, args.userId, 'customer', [args.vantageCustomerId], values, now);
  });
}

export async function updateDefaultSettings(db: Db, args: { patch: SettingsPatch; userId: number; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const values = validatePatch(args.patch, { allowNull: false });
  await db.transaction(async (tx) => {
    await tx
      .update(replenishmentSettings)
      .set({ ...values, updatedBy: args.userId, updatedAt: now })
      .where(eq(replenishmentSettings.scope, 'default'));
    await audit(tx as unknown as Db, args.userId, 'default', [], values, now);
  });
}

export interface SettingsRowMeta {
  updatedAt: Date;
  updatedBy: string | null;
}

export interface EffectiveSettings {
  thresholds: Record<'black' | 'cyan' | 'magenta' | 'yellow', { value: number; source: SettingSource }>;
  autoReplenish: { value: boolean; source: SettingSource };
  alertsEnabled: { value: boolean; source: SettingSource };
  vantageCustomerId: number | null;
  deviceRow: SettingsRowMeta | null;
  customerRow: SettingsRowMeta | null;
}

async function rowMeta(db: Db, where: SQL): Promise<SettingsRowMeta | null> {
  const [row] = await db
    .select({ updatedAt: replenishmentSettings.updatedAt, updatedBy: users.username })
    .from(replenishmentSettings)
    .leftJoin(users, eq(users.id, replenishmentSettings.updatedBy))
    .where(where);
  return row ?? null;
}

export async function getDeviceSettings(db: Db, drmsId: string): Promise<EffectiveSettings | null> {
  const eff = effectiveSettingsSubquery(db);
  const [r] = await db.select().from(eff).where(eq(eff.drmsId, drmsId));
  if (!r) return null;
  const [deviceRow, customerRow] = await Promise.all([
    rowMeta(db, and(eq(replenishmentSettings.scope, 'device'), eq(replenishmentSettings.drmsEquipmentId, drmsId))!),
    r.vantageCustomerId === null
      ? Promise.resolve(null)
      : rowMeta(db, and(eq(replenishmentSettings.scope, 'customer'), eq(replenishmentSettings.vantageCustomerId, r.vantageCustomerId))!),
  ]);
  return {
    thresholds: {
      black: { value: Number(r.thresholdBlack), source: r.thresholdBlackSource },
      cyan: { value: Number(r.thresholdCyan), source: r.thresholdCyanSource },
      magenta: { value: Number(r.thresholdMagenta), source: r.thresholdMagentaSource },
      yellow: { value: Number(r.thresholdYellow), source: r.thresholdYellowSource },
    },
    autoReplenish: { value: Boolean(r.autoReplenish), source: r.autoReplenishSource },
    alertsEnabled: { value: Boolean(r.alertsEnabled), source: r.alertsEnabledSource },
    vantageCustomerId: r.vantageCustomerId,
    deviceRow,
    customerRow,
  };
}

export interface CustomerSettingsRow {
  vantageCustomerId: number;
  customerName: string | null;
  reference: string | null;
  deviceCount: number;
  thresholdBlack: number | null;
  thresholdCyan: number | null;
  thresholdMagenta: number | null;
  thresholdYellow: number | null;
  autoReplenish: boolean | null;
  alertsEnabled: boolean | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/** Customer overrides, with how many linked DRMS devices each one reaches. */
export async function listCustomerSettings(db: Db): Promise<CustomerSettingsRow[]> {
  const devices = db
    .select({ customerId: vantageEquipment.vantageCustomerId, n: count().as('device_count') })
    .from(deviceLinks)
    .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .where(isNull(deviceLinks.unlinkedAt))
    .groupBy(vantageEquipment.vantageCustomerId)
    .as('customer_devices');

  const rows = await db
    .select({
      vantageCustomerId: replenishmentSettings.vantageCustomerId,
      customerName: vantageCustomers.name,
      reference: vantageCustomers.reference,
      deviceCount: devices.n,
      thresholdBlack: replenishmentSettings.thresholdBlack,
      thresholdCyan: replenishmentSettings.thresholdCyan,
      thresholdMagenta: replenishmentSettings.thresholdMagenta,
      thresholdYellow: replenishmentSettings.thresholdYellow,
      autoReplenish: replenishmentSettings.autoReplenish,
      alertsEnabled: replenishmentSettings.alertsEnabled,
      updatedAt: replenishmentSettings.updatedAt,
      updatedBy: users.username,
    })
    .from(replenishmentSettings)
    .leftJoin(vantageCustomers, eq(vantageCustomers.vantageId, replenishmentSettings.vantageCustomerId))
    .leftJoin(devices, eq(devices.customerId, replenishmentSettings.vantageCustomerId))
    .leftJoin(users, eq(users.id, replenishmentSettings.updatedBy))
    .where(eq(replenishmentSettings.scope, 'customer'))
    .orderBy(vantageCustomers.name);

  return rows.map((r) => ({ ...r, vantageCustomerId: r.vantageCustomerId!, deviceCount: Number(r.deviceCount ?? 0) }));
}
```

The test seeds no `vantage_customers` row, so `customerName` would be null — add to the test's `beforeEach`: `await t.db.insert(vantageCustomers).values({ vantageId: 7, name: 'Acme', raw: {} });` (import `vantageCustomers`).

Note: the "missing-device" test relies on the `drms_equipment_id` foreign key failing inside the transaction, which rolls everything back.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/db` → PASS. `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/queries/settings.ts packages/db/src/queries/settings.test.ts packages/db/src/queries/index.ts
git commit -m "feat(db): resolve replenishment settings in one SQL cascade; audited writes"
```

---

### Task 4: The replenishment engine (pure)

**Files:**
- Create: `packages/core/src/replenishment.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './replenishment';`)
- Test: `packages/core/src/replenishment.test.ts`

**Interfaces:**
- Produces:
  - constants `ALARM_WINDOW_DAYS = 7`, `COMPLETED_SUPPRESS_DAYS = 14`, `REJECTED_SUPPRESS_DAYS = 7`, `READY_FOR_ERP = 'ReadyForErpDelivery'`, `REPLENISH_COLOURS = ['black','cyan','magenta','yellow','waste'] as const`, `TONER_COLOURS = ['black','cyan','magenta','yellow'] as const`, `CONSUMABLE_TYPE: Record<ReplenishColour, 1|2|3|4|5>`
  - `type ReplenishColour`, `type TonerColour`
  - `alarmColour(a: { category: string|null; description: string|null; fcCode?: string|null }): ReplenishColour | null`
  - `interface ConsumableAlarm { alarmId: string; receivedAt: Date; category: string|null; status: string|null; description: string|null; fcCode: string|null }`
  - `interface ColourHistory { liveProposal: boolean; hasOpenOrder: boolean; lastCompletedAt: Date|null; lastRejectedAt: Date|null }`
  - `interface DeviceReplenishInput { vantageEquipmentId: number|null; isColour: boolean; autoReplenish: boolean; thresholds: Record<TonerColour, number>; levels: Record<TonerColour, number|null>; alarms: ConsumableAlarm[]; history: Partial<Record<ReplenishColour, ColourHistory>>; now: Date }`
  - `interface ProposalCandidate { colour: ReplenishColour; trigger: 'threshold'|'alarm'; level: number|null; threshold: number|null; alarmId: string|null; alarmDescription: string|null }`
  - `type SuppressReason = 'live_proposal'|'open_order'|'recently_completed'|'recently_rejected'`
  - `evaluateDevice(input): { candidates: ProposalCandidate[]; suppressed: { colour: ReplenishColour; reason: SuppressReason }[]; skipped: 'auto_off'|'unlinked'|null }`
  - `isRecovered(level: number|null, threshold: number): boolean` — `level !== null && level >= threshold`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/replenishment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { alarmColour, evaluateDevice, isRecovered, type DeviceReplenishInput } from './replenishment';

const NOW = new Date('2026-09-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function input(over: Partial<DeviceReplenishInput> = {}): DeviceReplenishInput {
  return {
    vantageEquipmentId: 100,
    isColour: true,
    autoReplenish: true,
    thresholds: { black: 15, cyan: 10, magenta: 10, yellow: 10 },
    levels: { black: 50, cyan: 50, magenta: 50, yellow: 50 },
    alarms: [],
    history: {},
    now: NOW,
    ...over,
  };
}
const alarm = (description: string, category: string, receivedAt = daysAgo(1), status = 'ReadyForErpDelivery') => ({
  alarmId: `a-${description}`, receivedAt, category, status, description, fcCode: null,
});

describe('alarmColour', () => {
  it('reads the colour from the toner alarm bracket', () => {
    expect(alarmColour({ category: 'toner', description: 'Toner Near Empty(K)' })).toBe('black');
    expect(alarmColour({ category: 'toner', description: 'Toner Empty(BK)' })).toBe('black');
    expect(alarmColour({ category: 'toner', description: 'Toner Delivery(C)' })).toBe('cyan');
    expect(alarmColour({ category: 'toner', description: 'Toner Near Empty(M)' })).toBe('magenta');
    expect(alarmColour({ category: 'toner', description: 'Toner Delivery(Y)' })).toBe('yellow');
  });
  it('maps any waste alarm to waste and never proposes parts', () => {
    expect(alarmColour({ category: 'waste', description: 'Waste Toner Bottle Almost Full' })).toBe('waste');
    expect(alarmColour({ category: 'parts', description: 'TP-01 PartsLife(IU_M) 2nd Call' })).toBeNull();
    expect(alarmColour({ category: 'toner', description: 'Toner Near Empty' })).toBeNull();
  });
});

describe('evaluateDevice', () => {
  it('proposes a colour strictly below its threshold', () => {
    const r = evaluateDevice(input({ levels: { black: 14, cyan: 10, magenta: 9, yellow: 50 } }));
    expect(r.candidates.map((c) => [c.colour, c.trigger, c.level, c.threshold])).toEqual([
      ['black', 'threshold', 14, 15],
      ['magenta', 'threshold', 9, 10],
    ]);
  });

  it('ignores CMY on a mono device, including CMY alarms', () => {
    const r = evaluateDevice(
      input({ isColour: false, levels: { black: 50, cyan: 0, magenta: 0, yellow: 0 }, alarms: [alarm('Toner Near Empty(C)', 'toner')] }),
    );
    expect(r.candidates).toEqual([]);
  });

  it('proposes from a ready alarm inside the window, including waste', () => {
    const r = evaluateDevice(input({ alarms: [alarm('Toner Near Empty(Y)', 'toner'), alarm('Waste Toner Bottle Full', 'waste')] }));
    expect(r.candidates.map((c) => [c.colour, c.trigger])).toEqual([
      ['yellow', 'alarm'],
      ['waste', 'alarm'],
    ]);
    expect(r.candidates[1]).toMatchObject({ level: null, threshold: null, alarmDescription: 'Waste Toner Bottle Full' });
  });

  it('ignores alarms that are old or not ready for ERP delivery', () => {
    const r = evaluateDevice(
      input({ alarms: [alarm('Toner Near Empty(K)', 'toner', daysAgo(8)), alarm('Toner Near Empty(C)', 'toner', daysAgo(1), 'EquipmentDiscovered')] }),
    );
    expect(r.candidates).toEqual([]);
  });

  it('prefers the threshold trigger but keeps the alarm on the candidate', () => {
    const r = evaluateDevice(input({ levels: { black: 3, cyan: 50, magenta: 50, yellow: 50 }, alarms: [alarm('Toner Empty(BK)', 'toner')] }));
    expect(r.candidates).toEqual([
      { colour: 'black', trigger: 'threshold', level: 3, threshold: 15, alarmId: 'a-Toner Empty(BK)', alarmDescription: 'Toner Empty(BK)' },
    ]);
  });

  it('skips a device with auto-replenish off or no Vantage link', () => {
    expect(evaluateDevice(input({ autoReplenish: false, levels: { black: 1, cyan: 1, magenta: 1, yellow: 1 } }))).toMatchObject({ candidates: [], skipped: 'auto_off' });
    expect(evaluateDevice(input({ vantageEquipmentId: null, levels: { black: 1, cyan: 50, magenta: 50, yellow: 50 } }))).toMatchObject({ candidates: [], skipped: 'unlinked' });
  });

  it('suppresses on a live proposal, an open order, a recent completion and a recent rejection', () => {
    const low = { black: 1, cyan: 1, magenta: 1, yellow: 1 };
    const r = evaluateDevice(
      input({
        levels: low,
        history: {
          black: { liveProposal: true, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: null },
          cyan: { liveProposal: false, hasOpenOrder: true, lastCompletedAt: null, lastRejectedAt: null },
          magenta: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: daysAgo(13), lastRejectedAt: null },
          yellow: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: daysAgo(6) },
        },
      }),
    );
    expect(r.candidates).toEqual([]);
    expect(r.suppressed).toEqual([
      { colour: 'black', reason: 'live_proposal' },
      { colour: 'cyan', reason: 'open_order' },
      { colour: 'magenta', reason: 'recently_completed' },
      { colour: 'yellow', reason: 'recently_rejected' },
    ]);
  });

  it('lets suppression windows expire', () => {
    const r = evaluateDevice(
      input({
        levels: { black: 50, cyan: 50, magenta: 1, yellow: 1 },
        history: {
          magenta: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: daysAgo(15), lastRejectedAt: null },
          yellow: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: daysAgo(8) },
        },
      }),
    );
    expect(r.candidates.map((c) => c.colour)).toEqual(['magenta', 'yellow']);
  });

  it('lets a new alarm after a rejection through', () => {
    const r = evaluateDevice(
      input({
        alarms: [alarm('Toner Near Empty(C)', 'toner', daysAgo(1))],
        history: { cyan: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: daysAgo(3) } },
      }),
    );
    expect(r.candidates.map((c) => c.colour)).toEqual(['cyan']);
  });
});

describe('isRecovered', () => {
  it('is true at or above the threshold and false without a reading', () => {
    expect(isRecovered(10, 10)).toBe(true);
    expect(isRecovered(9, 10)).toBe(false);
    expect(isRecovered(null, 10)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run packages/core/src/replenishment.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `packages/core/src/replenishment.ts`**

```ts
/**
 * The replenishment engine: which consumables a device should get a proposal for, and why not.
 * Pure — no I/O. The settings arrive already resolved (the cascade lives in SQL,
 * `effectiveSettingsSubquery`), so this never re-implements it.
 */

export const REPLENISH_COLOURS = ['black', 'cyan', 'magenta', 'yellow', 'waste'] as const;
export const TONER_COLOURS = ['black', 'cyan', 'magenta', 'yellow'] as const;
export type ReplenishColour = (typeof REPLENISH_COLOURS)[number];
export type TonerColour = (typeof TONER_COLOURS)[number];

/** Vantage CreateConsumableOrder `Type`. */
export const CONSUMABLE_TYPE: Record<ReplenishColour, 1 | 2 | 3 | 4 | 5> = {
  black: 1,
  cyan: 2,
  magenta: 3,
  yellow: 4,
  waste: 5,
};

/** Only alarms DRMS has cleared for ERP delivery count; the rest are CSRC-side noise. */
export const READY_FOR_ERP = 'ReadyForErpDelivery';
/** (default) An alarm older than this no longer proposes anything. */
export const ALARM_WINDOW_DAYS = 7;
/** (agreed) No new proposal for a colour within this many days of an order for it completing. */
export const COMPLETED_SUPPRESS_DAYS = 14;
/** (default) A rejected colour stays quiet this long, unless a newer alarm arrives. */
export const REJECTED_SUPPRESS_DAYS = 7;

const DAY_MS = 86_400_000;

const BRACKET_COLOUR: Record<string, TonerColour> = { K: 'black', BK: 'black', C: 'cyan', M: 'magenta', Y: 'yellow' };

/**
 * The consumable a DRMS alarm asks for. Toner alarms name their colour in a trailing bracket —
 * "Toner Near Empty(K)", "Toner Delivery(BK)" — and waste alarms need no colour. Parts, service
 * and jam alarms never propose: a drum or imaging unit needs an engineer, not a sales order.
 */
export function alarmColour(a: { category: string | null; description: string | null; fcCode?: string | null }): ReplenishColour | null {
  if (a.category === 'waste') return 'waste';
  if (a.category !== 'toner') return null;
  const m = /\((BK|K|C|M|Y)\)\s*$/i.exec(a.description ?? '');
  return m ? (BRACKET_COLOUR[m[1]!.toUpperCase()] ?? null) : null;
}

export interface ConsumableAlarm {
  alarmId: string;
  receivedAt: Date;
  category: string | null;
  status: string | null;
  description: string | null;
  fcCode: string | null;
}

export interface ColourHistory {
  /** A `pending`/`approved` proposal already exists for this device + colour. */
  liveProposal: boolean;
  /** An open Vantage order line, or one of our orders still in flight. */
  hasOpenOrder: boolean;
  lastCompletedAt: Date | null;
  lastRejectedAt: Date | null;
}

export interface DeviceReplenishInput {
  vantageEquipmentId: number | null;
  isColour: boolean;
  autoReplenish: boolean;
  thresholds: Record<TonerColour, number>;
  levels: Record<TonerColour, number | null>;
  alarms: ConsumableAlarm[];
  history: Partial<Record<ReplenishColour, ColourHistory>>;
  now: Date;
}

export interface ProposalCandidate {
  colour: ReplenishColour;
  trigger: 'threshold' | 'alarm';
  level: number | null;
  threshold: number | null;
  alarmId: string | null;
  alarmDescription: string | null;
}

export type SuppressReason = 'live_proposal' | 'open_order' | 'recently_completed' | 'recently_rejected';

export interface DeviceEvaluation {
  candidates: ProposalCandidate[];
  suppressed: { colour: ReplenishColour; reason: SuppressReason }[];
  skipped: 'auto_off' | 'unlinked' | null;
}

export function isRecovered(level: number | null, threshold: number): boolean {
  return level !== null && level >= threshold;
}

function channels(isColour: boolean): ReplenishColour[] {
  return isColour ? [...REPLENISH_COLOURS] : ['black', 'waste'];
}

/** The newest ready alarm per colour inside the window. */
function latestAlarms(alarms: ConsumableAlarm[], now: Date): Map<ReplenishColour, ConsumableAlarm> {
  const since = now.getTime() - ALARM_WINDOW_DAYS * DAY_MS;
  const out = new Map<ReplenishColour, ConsumableAlarm>();
  for (const a of alarms) {
    if (a.status !== READY_FOR_ERP || a.receivedAt.getTime() < since) continue;
    const colour = alarmColour(a);
    if (!colour) continue;
    const prev = out.get(colour);
    if (!prev || a.receivedAt > prev.receivedAt) out.set(colour, a);
  }
  return out;
}

function suppression(
  h: ColourHistory | undefined,
  now: Date,
  alarm: ConsumableAlarm | undefined,
): SuppressReason | null {
  if (!h) return null;
  if (h.liveProposal) return 'live_proposal';
  if (h.hasOpenOrder) return 'open_order';
  if (h.lastCompletedAt && now.getTime() - h.lastCompletedAt.getTime() < COMPLETED_SUPPRESS_DAYS * DAY_MS) {
    return 'recently_completed';
  }
  if (h.lastRejectedAt && now.getTime() - h.lastRejectedAt.getTime() < REJECTED_SUPPRESS_DAYS * DAY_MS) {
    const newerAlarm = alarm !== undefined && alarm.receivedAt > h.lastRejectedAt;
    if (!newerAlarm) return 'recently_rejected';
  }
  return null;
}

export function evaluateDevice(input: DeviceReplenishInput): DeviceEvaluation {
  if (!input.autoReplenish) return { candidates: [], suppressed: [], skipped: 'auto_off' };
  if (input.vantageEquipmentId === null) return { candidates: [], suppressed: [], skipped: 'unlinked' };

  const alarms = latestAlarms(input.alarms, input.now);
  const candidates: ProposalCandidate[] = [];
  const suppressed: DeviceEvaluation['suppressed'] = [];

  for (const colour of channels(input.isColour)) {
    const alarm = alarms.get(colour);
    const level = colour === 'waste' ? null : input.levels[colour];
    const threshold = colour === 'waste' ? null : input.thresholds[colour];
    const byThreshold = level !== null && threshold !== null && level < threshold;
    if (!byThreshold && !alarm) continue;

    const reason = suppression(input.history[colour], input.now, alarm);
    if (reason) {
      suppressed.push({ colour, reason });
      continue;
    }
    candidates.push({
      colour,
      trigger: byThreshold ? 'threshold' : 'alarm',
      level: byThreshold ? level : (level ?? null),
      threshold: byThreshold ? threshold : (threshold ?? null),
      alarmId: alarm?.alarmId ?? null,
      alarmDescription: alarm?.description ?? null,
    });
  }
  return { candidates, suppressed, skipped: null };
}
```

Check the waste test: `{ level: null, threshold: null }` — waste has no level. For an alarm-only toner candidate `level`/`threshold` carry the current reading for context (the `Toner Near Empty(Y)` test does not assert them).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/core` → PASS. `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/replenishment.ts packages/core/src/replenishment.test.ts packages/core/src/index.ts
git commit -m "feat(core): replenishment engine — thresholds, ready alarms, duplicate suppression"
```

---

### Task 5: Order state per equipment and colour

**Files:**
- Create: `packages/db/src/queries/order-state.ts`
- Modify: `packages/db/src/queries/index.ts`
- Test: `packages/db/src/queries/order-state.test.ts`

**Interfaces:**
- Consumes: `vantage_sales_orders`, `vantage_sales_order_lines`, T2 `replenishment_orders` + `replenishment_proposals`; `REPLENISH_COLOURS`, `COMPLETED_SUPPRESS_DAYS` from `@mps/core`.
- Produces:
  - `interface OrderRef { reference: string|null; orderDate: Date|null; source: 'vantage'|'mps' }`
  - `interface ColourOrderState { open: OrderRef|null; lastCompletedAt: Date|null; last: (OrderRef & { open: boolean }) | null }`
  - `getOrderStates(db, vantageEquipmentIds: number[], now?: Date): Promise<Map<number, Record<ReplenishColour, ColourOrderState>>>` — every requested id is present in the map (colours with nothing have `{ open: null, lastCompletedAt: null, last: null }`).

Rules (from the spec): a Vantage line counts for equipment `coalesce(line.vantage_equipment_id, order.vantage_equipment_id)`, only if `order.deleted_date is null`, `line.returned_date is null` and `line.colour` is a replenish colour. Open = `order.completed_date is null`. Our own orders count as open while `queued|submitting|uncertain`, or `submitted` and **not yet pulled** (no `vantage_sales_orders` row with that id) and submitted less than `COMPLETED_SUPPRESS_DAYS` ago; once pulled, the Vantage rows speak for them (no double counting).

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drmsEquipment, replenishmentOrders, replenishmentProposals, vantageSalesOrderLines, vantageSalesOrders } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getOrderStates } from './order-state';

const NOW = new Date('2026-09-21T12:00:00Z');
const d = (iso: string) => new Date(iso);

describe('getOrderStates', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values({ drmsId: 'dev', raw: {} });
  });
  afterEach(() => t.close());

  async function order(id: number, o: { eq?: number | null; completed?: Date | null; deleted?: Date | null; date?: Date }, lines: { eq?: number | null; colour: string; returned?: Date | null }[]) {
    await t.db.insert(vantageSalesOrders).values({
      vantageId: id, reference: `SO${id}`, orderDate: o.date ?? d('2026-09-01'), completedDate: o.completed ?? null,
      deletedDate: o.deleted ?? null, vantageEquipmentId: o.eq ?? null, raw: {},
    });
    await t.db.insert(vantageSalesOrderLines).values(
      lines.map((l, i) => ({ vantageId: id * 10 + i, salesOrderId: id, vantageEquipmentId: l.eq ?? null, colour: l.colour, returnedDate: l.returned ?? null, raw: {} })),
    );
  }

  it('finds open orders through either link path and the last completion per colour', async () => {
    await order(1, { eq: 100, completed: null, date: d('2026-09-19') }, [{ colour: 'cyan' }]);
    await order(2, { eq: null, completed: d('2026-09-10'), date: d('2026-09-08') }, [{ eq: 100, colour: 'black' }]);
    await order(3, { eq: 100, completed: d('2026-08-01'), date: d('2026-07-30') }, [{ colour: 'black' }]);
    const s = (await getOrderStates(t.db, [100, 200], NOW)).get(100)!;
    expect(s.cyan.open).toEqual({ reference: 'SO1', orderDate: d('2026-09-19'), source: 'vantage' });
    expect(s.black).toEqual({ open: null, lastCompletedAt: d('2026-09-10'), last: { reference: 'SO2', orderDate: d('2026-09-08'), source: 'vantage', open: false } });
    expect(s.magenta).toEqual({ open: null, lastCompletedAt: null, last: null });
  });

  it('returns an empty state for an id with no orders', async () => {
    expect((await getOrderStates(t.db, [200], NOW)).get(200)?.waste).toEqual({ open: null, lastCompletedAt: null, last: null });
  });

  it('ignores deleted orders, returned lines and unclassified lines', async () => {
    await order(4, { eq: 100, deleted: d('2026-09-02') }, [{ colour: 'yellow' }]);
    await order(5, { eq: 100 }, [{ colour: 'magenta', returned: d('2026-09-03') }, { colour: 'unknown' }]);
    const s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.yellow.open).toBeNull();
    expect(s.magenta.open).toBeNull();
  });

  it('counts our own in-flight orders until the Vantage order has been pulled', async () => {
    const [o] = await t.db.insert(replenishmentOrders).values({
      drmsEquipmentId: 'dev', vantageEquipmentId: 100, status: 'submitted', request: {}, vantageSalesOrderId: 77, submittedAt: d('2026-09-20T09:00:00Z'),
    }).returning();
    await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: 'dev', colour: 'waste', trigger: 'alarm', status: 'ordered', orderId: o!.id });
    let s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.waste.open).toMatchObject({ source: 'mps' });

    await order(77, { eq: 100, completed: d('2026-09-21T08:00:00Z') }, [{ colour: 'waste' }]);
    s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.waste.open).toBeNull();
    expect(s.waste.lastCompletedAt).toEqual(d('2026-09-21T08:00:00Z'));
  });

  it('stops counting an unpulled submitted order after the suppression window, but never an uncertain one', async () => {
    const [a] = await t.db.insert(replenishmentOrders).values({ drmsEquipmentId: 'dev', vantageEquipmentId: 100, status: 'submitted', request: {}, submittedAt: d('2026-09-01') }).returning();
    const [b] = await t.db.insert(replenishmentOrders).values({ drmsEquipmentId: 'dev', vantageEquipmentId: 100, status: 'uncertain', request: {}, submittedAt: d('2026-09-01') }).returning();
    await t.db.insert(replenishmentProposals).values([
      { drmsEquipmentId: 'dev', colour: 'black', trigger: 'threshold', status: 'ordered', orderId: a!.id },
      { drmsEquipmentId: 'dev', colour: 'cyan', trigger: 'threshold', status: 'ordered', orderId: b!.id },
    ]);
    const s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.black.open).toBeNull();
    expect(s.cyan.open).toMatchObject({ source: 'mps' });
  });
});
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run packages/db/src/queries/order-state.test.ts` → FAIL.

- [ ] **Step 3: Implement `packages/db/src/queries/order-state.ts`**

```ts
import { COMPLETED_SUPPRESS_DAYS, REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { replenishmentOrders, replenishmentProposals, vantageSalesOrderLines, vantageSalesOrders } from '../schema';

export interface OrderRef {
  reference: string | null;
  orderDate: Date | null;
  source: 'vantage' | 'mps';
}

export interface ColourOrderState {
  /** The newest open order for this colour, if any. */
  open: OrderRef | null;
  lastCompletedAt: Date | null;
  /** The newest order of this colour, open or not. */
  last: (OrderRef & { open: boolean }) | null;
}

const emptyState = (): Record<ReplenishColour, ColourOrderState> =>
  Object.fromEntries(REPLENISH_COLOURS.map((c) => [c, { open: null, lastCompletedAt: null, last: null }])) as Record<
    ReplenishColour,
    ColourOrderState
  >;

/**
 * Per Vantage equipment and colour: is an order open, when did one last complete, and what was the
 * last order. Feeds the engine's duplicate suppression and the review queue's context column.
 * Two queries in total, whatever the number of ids.
 */
export async function getOrderStates(
  db: Db,
  vantageEquipmentIds: number[],
  now: Date = new Date(),
): Promise<Map<number, Record<ReplenishColour, ColourOrderState>>> {
  const out = new Map<number, Record<ReplenishColour, ColourOrderState>>();
  for (const id of vantageEquipmentIds) out.set(id, emptyState());
  if (vantageEquipmentIds.length === 0) return out;

  const equipment = sql<number>`coalesce(${vantageSalesOrderLines.vantageEquipmentId}, ${vantageSalesOrders.vantageEquipmentId})`;
  const lines = await db
    .select({
      equipmentId: equipment,
      colour: vantageSalesOrderLines.colour,
      reference: vantageSalesOrders.reference,
      orderDate: vantageSalesOrders.orderDate,
      completedDate: vantageSalesOrders.completedDate,
    })
    .from(vantageSalesOrderLines)
    .innerJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, vantageSalesOrderLines.salesOrderId))
    .where(
      and(
        isNull(vantageSalesOrders.deletedDate),
        isNull(vantageSalesOrderLines.returnedDate),
        inArray(vantageSalesOrderLines.colour, [...REPLENISH_COLOURS]),
        sql`${equipment} in (${sql.join(vantageEquipmentIds.map((id) => sql`${id}`), sql`, `)})`,
      ),
    )
    .orderBy(desc(vantageSalesOrders.orderDate), desc(vantageSalesOrders.vantageId));

  for (const l of lines) {
    const state = out.get(Number(l.equipmentId))?.[l.colour as ReplenishColour];
    if (!state) continue;
    const open = l.completedDate === null;
    const ref: OrderRef = { reference: l.reference, orderDate: l.orderDate, source: 'vantage' };
    state.last ??= { ...ref, open };
    if (open) state.open ??= ref;
    else if (!state.lastCompletedAt || (l.completedDate && l.completedDate > state.lastCompletedAt)) {
      state.lastCompletedAt = l.completedDate;
    }
  }

  const windowStart = new Date(now.getTime() - COMPLETED_SUPPRESS_DAYS * 86_400_000);
  const ours = await db
    .select({
      equipmentId: replenishmentOrders.vantageEquipmentId,
      status: replenishmentOrders.status,
      reference: replenishmentOrders.vantageReference,
      createdAt: replenishmentOrders.createdAt,
      submittedAt: replenishmentOrders.submittedAt,
      pulled: vantageSalesOrders.vantageId,
      colour: replenishmentProposals.colour,
    })
    .from(replenishmentOrders)
    .innerJoin(replenishmentProposals, eq(replenishmentProposals.orderId, replenishmentOrders.id))
    .leftJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, replenishmentOrders.vantageSalesOrderId))
    .where(
      and(
        inArray(replenishmentOrders.vantageEquipmentId, vantageEquipmentIds),
        inArray(replenishmentOrders.status, ['queued', 'submitting', 'uncertain', 'submitted']),
      ),
    );

  for (const o of ours) {
    if (o.pulled !== null) continue; // the Vantage rows above already speak for it
    if (o.status === 'submitted' && (!o.submittedAt || o.submittedAt < windowStart)) continue;
    const state = out.get(o.equipmentId)?.[o.colour];
    if (!state) continue;
    const ref: OrderRef = { reference: o.reference, orderDate: o.submittedAt ?? o.createdAt, source: 'mps' };
    state.open ??= ref;
    state.last ??= { ...ref, open: true };
  }
  return out;
}
```

- [ ] **Step 4: Run** `npx vitest run packages/db` → PASS; typecheck + lint.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/queries/order-state.ts packages/db/src/queries/order-state.test.ts packages/db/src/queries/index.ts
git commit -m "feat(db): per-colour order state from Vantage lines and our in-flight orders"
```

---

### Task 6: `replenish-evaluate` job

**Files:**
- Create: `apps/worker/src/jobs/replenish-evaluate.ts`
- Test: `apps/worker/src/jobs/replenish-evaluate.test.ts`
- Modify: `packages/queue/src/index.ts`, `apps/worker/src/queue-options.ts`, `apps/worker/src/handlers.ts` (+ `handlers.test.ts`), `apps/worker/src/main.ts`, `apps/web/src/components/admin-jobs.ts` (+ its test if it asserts the card count)

**Interfaces:**
- Consumes: `evaluateDevice`, `isRecovered`, `TONER_COLOURS`, `REJECTED_SUPPRESS_DAYS`, `ALARM_WINDOW_DAYS`, `READY_FOR_ERP` (`@mps/core`); `effectiveSettingsSubquery` (T3), `getOrderStates` (T5); `counterPivotSubquery` — **export it** from `packages/db/src/queries/index.ts` alongside the existing names (worker needs it).
- Produces: `QUEUES.replenishEvaluate = 'replenish-evaluate'`; `runReplenishEvaluate(deps: { db: Db; now?: () => Date }): Promise<JobResult>` with stats `{ devices, proposed, superseded, suppressed, autoOff, unlinked }`; `HandlerDeps.queueReplenish: () => Promise<unknown>`.

- [ ] **Step 1: Write the failing job test**

```ts
import { deviceAlarms, deviceLinks, drmsEquipment, replenishmentProposals, vantageEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { updateDeviceSettings } from '@mps/db/queries';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot } from './drms-snapshot';
import { runReplenishEvaluate } from './replenish-evaluate';

const NOW = new Date('2026-09-21T14:00:00Z');

describe('runReplenishEvaluate', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'colour', status: 'Registered', isColour: true, raw: {} },
      { drmsId: 'mono', status: 'Registered', isColour: false, raw: {} },
      { drmsId: 'loose', status: 'Registered', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([{ vantageId: 1, raw: {} }, { vantageId: 2, raw: {} }]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'colour', vantageEquipmentId: 1, method: 'serial' },
      { drmsEquipmentId: 'mono', vantageEquipmentId: 2, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  const levels = (id: string, counterId: string, k: number, c: number, m = 50, y = 50) =>
    saveSnapshot(t.db, id, {
      CounterId: counterId,
      ReceivedTime: '2026-09-21 09:00:00',
      Counters: [
        { Name: 'BlackTonerLevel', Value: k },
        { Name: 'CyanTonerLevel', Value: c },
        { Name: 'MagentaTonerLevel', Value: m },
        { Name: 'YellowTonerLevel', Value: y },
      ],
      ModeSizeCounters: [],
    } as never, NOW);

  it('proposes low channels for linked devices only, respecting mono', async () => {
    await levels('colour', 'c1', 12, 4);
    await levels('mono', 'm1', 5, 0);
    await levels('loose', 'l1', 1, 1);
    const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.status).toBe('success');
    expect(r.stats).toMatchObject({ proposed: 3, unlinked: 1 });
    const rows = await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.drmsEquipmentId, replenishmentProposals.colour);
    expect(rows.map((p) => [p.drmsEquipmentId, p.colour, p.trigger, p.level, p.threshold, p.status, p.vantageEquipmentId])).toEqual([
      ['colour', 'black', 'threshold', 12, 15, 'pending', 1],
      ['colour', 'cyan', 'threshold', 4, 10, 'pending', 1],
      ['mono', 'black', 'threshold', 5, 15, 'pending', 2],
    ]);
  });

  it('is idempotent: a second run proposes nothing new', async () => {
    await levels('colour', 'c1', 12, 50);
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    const again = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(again.stats).toMatchObject({ proposed: 0, suppressed: 1 });
    expect(await t.db.select().from(replenishmentProposals)).toHaveLength(1);
  });

  it('proposes waste from a ready alarm', async () => {
    await t.db.insert(deviceAlarms).values({
      alarmId: 'w1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'waste',
      status: 'ReadyForErpDelivery', description: 'Waste Toner Bottle Almost Full', raw: {},
    });
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    const [p] = await t.db.select().from(replenishmentProposals);
    expect(p).toMatchObject({ colour: 'waste', trigger: 'alarm', alarmId: 'w1', level: null });
  });

  it('supersedes a pending threshold proposal once the level recovers, or auto-replenish is switched off', async () => {
    await levels('colour', 'c1', 12, 4);
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    await levels('colour', 'c2', 98, 4); // black cartridge replaced
    let r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1 });
    await updateDeviceSettings(t.db, { drmsIds: ['colour'], patch: { autoReplenish: false }, userId: await userId() });
    r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1, autoOff: 1 });
    const live = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.status, 'pending'));
    expect(live).toEqual([]);
  });

  async function userId() {
    const { users } = await import('@mps/db');
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    return u!.id;
  }
});
```

- [ ] **Step 2: Run** `npx vitest run apps/worker/src/jobs/replenish-evaluate.test.ts` → FAIL.

- [ ] **Step 3: Implement `apps/worker/src/jobs/replenish-evaluate.ts`**

```ts
import {
  ALARM_WINDOW_DAYS,
  READY_FOR_ERP,
  REJECTED_SUPPRESS_DAYS,
  TONER_COLOURS,
  evaluateDevice,
  isRecovered,
  type ColourHistory,
  type ConsumableAlarm,
  type ReplenishColour,
  type TonerColour,
} from '@mps/core';
import { deviceAlarms, drmsEquipment, replenishmentProposals, type Db } from '@mps/db';
import { counterPivotSubquery, effectiveSettingsSubquery, getOrderStates } from '@mps/db/queries';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

export interface ReplenishEvaluateDeps {
  db: Db;
  now?: () => Date;
}

/**
 * Runs the engine over every monitored device and persists the result. Proposes only — nothing
 * here talks to Vantage. Safe to run any number of times: the live-proposal unique index and the
 * engine's `live_proposal` suppression both stop duplicates.
 */
export async function runReplenishEvaluate(deps: ReplenishEvaluateDeps): Promise<JobResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const eff = effectiveSettingsSubquery(db);
  const pivot = counterPivotSubquery(db);

  const devices = await db
    .select({
      drmsId: drmsEquipment.drmsId,
      isColour: drmsEquipment.isColour,
      vantageEquipmentId: eff.vantageEquipmentId,
      autoReplenish: eff.autoReplenish,
      tBlack: eff.thresholdBlack,
      tCyan: eff.thresholdCyan,
      tMagenta: eff.thresholdMagenta,
      tYellow: eff.thresholdYellow,
      black: pivot.black,
      cyan: pivot.cyan,
      magenta: pivot.magenta,
      yellow: pivot.yellow,
    })
    .from(drmsEquipment)
    .innerJoin(eff, eq(eff.drmsId, drmsEquipment.drmsId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
    .where(and(sql`upper(${drmsEquipment.status}) in ('REGISTERED', 'DISCOVERED')`, isNull(drmsEquipment.missingSince)));

  const since = new Date(now.getTime() - ALARM_WINDOW_DAYS * 86_400_000);
  const alarmRows = await db
    .select({
      drmsId: deviceAlarms.drmsEquipmentId,
      alarmId: deviceAlarms.alarmId,
      receivedAt: deviceAlarms.receivedTime,
      category: deviceAlarms.category,
      status: deviceAlarms.status,
      description: deviceAlarms.description,
      fcCode: deviceAlarms.fcCode,
    })
    .from(deviceAlarms)
    .where(and(gte(deviceAlarms.receivedTime, since), eq(deviceAlarms.status, READY_FOR_ERP), inArray(deviceAlarms.category, ['toner', 'waste'])));
  const alarmsByDevice = new Map<string, ConsumableAlarm[]>();
  for (const { drmsId, ...a } of alarmRows) alarmsByDevice.set(drmsId, [...(alarmsByDevice.get(drmsId) ?? []), a]);

  const rejectedSince = new Date(now.getTime() - REJECTED_SUPPRESS_DAYS * 86_400_000);
  const proposalRows = await db
    .select({
      id: replenishmentProposals.id,
      drmsId: replenishmentProposals.drmsEquipmentId,
      colour: replenishmentProposals.colour,
      status: replenishmentProposals.status,
      trigger: replenishmentProposals.trigger,
      decidedAt: replenishmentProposals.decidedAt,
    })
    .from(replenishmentProposals)
    .where(
      sql`${replenishmentProposals.status} in ('pending', 'approved') or (${replenishmentProposals.status} = 'rejected' and ${replenishmentProposals.decidedAt} >= ${rejectedSince})`,
    );

  const linkedIds = [...new Set(devices.map((d) => d.vantageEquipmentId).filter((id): id is number => id !== null))];
  const orderStates = await getOrderStates(db, linkedIds, now);

  const stats = { devices: devices.length, proposed: 0, superseded: 0, suppressed: 0, autoOff: 0, unlinked: 0 };
  const toSupersede: { id: number; note: string }[] = [];

  for (const d of devices) {
    const thresholds: Record<TonerColour, number> = { black: Number(d.tBlack), cyan: Number(d.tCyan), magenta: Number(d.tMagenta), yellow: Number(d.tYellow) };
    const levels: Record<TonerColour, number | null> = {
      black: d.black === null ? null : Number(d.black),
      cyan: d.cyan === null ? null : Number(d.cyan),
      magenta: d.magenta === null ? null : Number(d.magenta),
      yellow: d.yellow === null ? null : Number(d.yellow),
    };
    const mine = proposalRows.filter((p) => p.drmsId === d.drmsId);

    // Supersede first, so a recovered channel does not count as "live" below.
    for (const p of mine) {
      if (p.status !== 'pending') continue;
      if (!d.autoReplenish) toSupersede.push({ id: p.id, note: 'auto-replenish switched off' });
      else if (p.trigger === 'threshold' && p.colour !== 'waste' && isRecovered(levels[p.colour], thresholds[p.colour])) {
        toSupersede.push({ id: p.id, note: 'level recovered' });
      }
    }
    const superseded = new Set(toSupersede.map((s) => s.id));

    const history: Partial<Record<ReplenishColour, ColourHistory>> = {};
    const states = d.vantageEquipmentId === null ? undefined : orderStates.get(d.vantageEquipmentId);
    for (const colour of ['black', 'cyan', 'magenta', 'yellow', 'waste'] as const) {
      const live = mine.some((p) => p.colour === colour && (p.status === 'pending' || p.status === 'approved') && !superseded.has(p.id));
      const rejected = mine
        .filter((p) => p.colour === colour && p.status === 'rejected' && p.decidedAt)
        .map((p) => p.decidedAt!)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      history[colour] = {
        liveProposal: live,
        hasOpenOrder: states?.[colour].open != null,
        lastCompletedAt: states?.[colour].lastCompletedAt ?? null,
        lastRejectedAt: rejected ?? null,
      };
    }

    const result = evaluateDevice({
      vantageEquipmentId: d.vantageEquipmentId,
      isColour: d.isColour,
      autoReplenish: Boolean(d.autoReplenish),
      thresholds,
      levels,
      alarms: alarmsByDevice.get(d.drmsId) ?? [],
      history,
      now,
    });
    if (result.skipped === 'auto_off') stats.autoOff++;
    if (result.skipped === 'unlinked' && result.candidates.length === 0) {
      // Only count devices that would otherwise have had something to order.
      if (TONER_COLOURS.some((c) => levels[c] !== null && levels[c]! < thresholds[c]) || alarmsByDevice.has(d.drmsId)) stats.unlinked++;
    }
    stats.suppressed += result.suppressed.length;

    if (result.candidates.length > 0) {
      const inserted = await db
        .insert(replenishmentProposals)
        .values(
          result.candidates.map((c) => ({
            drmsEquipmentId: d.drmsId,
            vantageEquipmentId: d.vantageEquipmentId,
            colour: c.colour,
            trigger: c.trigger,
            level: c.level,
            threshold: c.threshold,
            alarmId: c.alarmId,
            alarmDescription: c.alarmDescription,
            status: 'pending' as const,
            createdAt: now,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: replenishmentProposals.id });
      stats.proposed += inserted.length;
    }
  }

  for (const s of toSupersede) {
    await db
      .update(replenishmentProposals)
      .set({ status: 'superseded', decidedAt: now, note: s.note })
      .where(and(eq(replenishmentProposals.id, s.id), eq(replenishmentProposals.status, 'pending')));
  }
  stats.superseded = toSupersede.length;
  return { status: 'success', stats };
}
```

Fix the test's `unlinked` expectation: the `loose` device has low levels and no link → `unlinked: 1`. The supersede test: after `levels('colour','c2',98,4)` only black recovers (`superseded: 1`); cyan stays pending until auto-replenish is switched off (`superseded: 1, autoOff: 1`).

- [ ] **Step 4: Wire the queue**

`packages/queue/src/index.ts` → add `replenishEvaluate: 'replenish-evaluate',` to `QUEUES`.
`apps/worker/src/queue-options.ts` → `[QUEUES.replenishEvaluate]: stately(QUEUES.replenishEvaluate, 1800),`.
`apps/worker/src/handlers.ts`:

```ts
import { runReplenishEvaluate } from './jobs/replenish-evaluate';
// HandlerDeps gains:
  /** Queues `replenish-evaluate` after the jobs whose data it reads (snapshot, alarms, orders). */
  queueReplenish: () => Promise<unknown>;
// drms-snapshot, drms-alarms and vantage-orders handlers each end with:  await deps.queueReplenish();
    [QUEUES.replenishEvaluate]: async () => {
      await withSyncRun(db, QUEUES.replenishEvaluate, () => runReplenishEvaluate({ db, now }));
    },
```

Update the `vantage-orders` handler comment ("Read-only…") to say it now queues the evaluation.
`apps/worker/src/main.ts` → pass `queueReplenish: () => boss.send(QUEUES.replenishEvaluate, {}, { startAfter: 30 })`.
`apps/worker/src/handlers.test.ts` → give `buildHandlers` a counting `queueReplenish` and assert it was called 3 times after `drms-snapshot`, `drms-alarms`, `vantage-orders`; add `['replenish-evaluate', 'success']` coverage by calling `handlers['replenish-evaluate']({})`.
`apps/web/src/components/admin-jobs.ts` → add a card after `vantageOrders`:

```ts
  {
    queue: QUEUES.replenishEvaluate,
    title: 'Replenishment check',
    description: 'Turns low toner and DRMS consumable alarms into order proposals for review. Postgres only — it never orders anything.',
    schedule: 'After each snapshot, alarm pull and sales-order pull',
    external: false,
  },
```

Fix the "The six queues" comment and any test that counts cards.

- [ ] **Step 5: Run** `npx vitest run apps/worker apps/web packages/queue` → PASS; `npm run typecheck && npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/jobs/replenish-evaluate.ts apps/worker/src/jobs/replenish-evaluate.test.ts packages/queue/src/index.ts apps/worker/src/queue-options.ts apps/worker/src/handlers.ts apps/worker/src/handlers.test.ts apps/worker/src/main.ts apps/web/src/components/admin-jobs.ts packages/db/src/queries/index.ts
git commit -m "feat(worker): replenish-evaluate job proposes orders after each data pull"
```

(Add any admin-jobs test file you changed.)

---

### Task 7: Queue reads and decisions (approve / reject / quantity / resolve)

**Files:**
- Create: `packages/db/src/queries/replenishment.ts`
- Modify: `packages/db/src/queries/index.ts`
- Test: `packages/db/src/queries/replenishment.test.ts`

**Interfaces:**
- Consumes: T2 tables, T3 `getDeviceSettings`/`effectiveSettingsSubquery`, T5 `getOrderStates`, `CONSUMABLE_TYPE` (`@mps/core`), `counterPivotSubquery`.
- Produces:
  - `type QueueTab = 'review' | 'in-progress' | 'ordered' | 'rejected'`
  - `interface QueueProposal { id; colour: ReplenishColour; trigger; level: number|null; threshold: number|null; thresholdSource: SettingSource|null; currentLevel: number|null; alarmDescription: string|null; quantity: number; status: ProposalStatus; createdAt: Date; decidedAt: Date|null; decidedBy: string|null; note: string|null; lastOrder: (OrderRef & { open: boolean }) | null; openOrder: OrderRef | null }`
  - `interface QueueOrder { id; status: OrderStatus; vantageReference: string|null; isOnHold: boolean|null; error: string|null; createdAt: Date; submittedAt: Date|null; createdBy: string|null }`
  - `interface QueueDevice { drmsId; name: string|null; model: string|null; serial: string|null; customerName: string|null; location: string|null; vantageEquipmentId: number|null; proposals: QueueProposal[]; orders: QueueOrder[] }`
  - `listReplenishmentQueue(db, { tab: QueueTab; limit?: number }): Promise<QueueDevice[]>`
  - `getReplenishmentStats(db, now?): Promise<{ awaitingReviewDevices: number; awaitingReviewProposals: number; onOrderDevices: number; openMpsOrders: number; attentionOrders: number; cartridgesThisQuarter: number }>` — `attentionOrders` = `failed` + `uncertain`.
  - `countAwaitingReview(db): Promise<number>` (distinct devices with a pending proposal — the sidebar badge; one cheap query).
  - `listDeviceReplenishment(db, drmsId): Promise<{ proposals: QueueProposal[]; orders: QueueOrder[] }>` (live proposals + last 10 orders, for the device page).
  - `approveProposals(db, { drmsId: string; items: { proposalId: number; quantity: number }[]; userId: number; now?: Date }): Promise<{ orderId: number }>`
  - `rejectProposals(db, { proposalIds: number[]; userId: number; note?: string; now?: Date }): Promise<{ rejected: number }>`
  - `resolveOrder(db, { orderId: number; outcome: 'ordered' | 'failed'; reference?: string; userId: number; now?: Date }): Promise<void>` — only from `uncertain`.
  - `retryOrder(db, { orderId: number; userId: number; now?: Date }): Promise<void>` — only from `failed` → `queued`, proposals `approved`.
  - `class ReplenishmentError extends Error { code: 'not_pending'|'mixed_devices'|'unlinked'|'bad_quantity'|'not_found'|'bad_state'|'empty' }`

Approval rules: all proposals must exist, be `pending`, belong to `drmsId`; the device must have an active link (use the current link's `vantage_equipment_id`, not the one stored at proposal time); quantity integer 1–20. In **one transaction**: insert `replenishment_orders` (`status 'queued'`, `request: { components: items.map(i => ({ Type: CONSUMABLE_TYPE[colour], RequestedQuantity: quantity })) }` in K,C,M,Y,waste order, `createdBy`), update proposals (`status 'approved'`, `quantity`, `orderId`, `decidedBy`, `decidedAt`), guarded `where status = 'pending'` — if fewer rows update than requested, throw `not_pending` (rolls back). Write `audit_log` `{ action: 'proposal.approve', entity: 'proposal', entityIds, details: { orderId, items } }`. Reject: guarded update to `rejected` + audit `proposal.reject`. Resolve: `uncertain` → `submitted` (with `vantageReference`, `resolvedBy/At`) + proposals `ordered`, or → `failed` + proposals `failed`; audit `order.resolve`. Retry: `failed` → `queued`, `error = null`, proposals `approved`; audit `order.retry`.

Tabs: *review* = devices with ≥1 `pending` proposal (proposals shown: pending only); *in-progress* = orders `queued|submitting|uncertain|failed` (proposals of those orders); *ordered* = orders `submitted` in the last 90 days; *rejected* = proposals `rejected|superseded` in the last 30 days. Review sorts devices by their lowest current level (nulls last), then name. `currentLevel` comes from the counter pivot, `threshold`/`thresholdSource` from the effective settings (null for waste), `lastOrder`/`openOrder` from `getOrderStates`.

- [ ] **Step 1: Write the failing tests** (`packages/db/src/queries/replenishment.test.ts`)

Seed: a user; devices `d1` (colour, linked to Vantage equipment 100 with customer name "Acme"), `d2` (linked to 101); pending proposals d1 black (level 12, threshold 15), d1 cyan (level 4), d2 waste (alarm). Cover:

```ts
it('approves selected proposals into one queued order with the Vantage body', async () => {
  const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 2 }, { proposalId: black, quantity: 1 }], userId });
  const [o] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, orderId));
  expect(o).toMatchObject({ status: 'queued', vantageEquipmentId: 100, createdBy: userId });
  expect(o!.request).toEqual({ components: [{ Type: 1, RequestedQuantity: 1 }, { Type: 2, RequestedQuantity: 2 }] });
  const ps = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.orderId, orderId));
  expect(ps.map((p) => [p.colour, p.status, p.quantity])).toEqual(expect.arrayContaining([['black', 'approved', 1], ['cyan', 'approved', 2]]));
  expect(await t.db.select().from(auditLog)).toEqual([expect.objectContaining({ action: 'proposal.approve', userId })]);
});
it('refuses proposals from another device, already decided ones, and bad quantities — and writes nothing', async () => {
  await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: waste, quantity: 1 }], userId })).rejects.toMatchObject({ code: 'mixed_devices' });
  await rejectProposals(t.db, { proposalIds: [black], userId });
  await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId })).rejects.toMatchObject({ code: 'not_pending' });
  await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 0 }], userId })).rejects.toMatchObject({ code: 'bad_quantity' });
  await expect(approveProposals(t.db, { drmsId: 'd1', items: [], userId })).rejects.toMatchObject({ code: 'empty' });
  expect(await t.db.select().from(replenishmentOrders)).toEqual([]);
});
it('refuses a device whose link has gone', async () => { /* set device_links.unlinked_at for d1, expect code 'unlinked' */ });
it('lists the review tab grouped by device, lowest level first, with threshold source and order context', async () => {
  const q = await listReplenishmentQueue(t.db, { tab: 'review' });
  expect(q.map((d) => d.drmsId)).toEqual(['d1', 'd2']);
  expect(q[0]!.proposals.find((p) => p.colour === 'black')).toMatchObject({ threshold: 15, thresholdSource: 'default', currentLevel: 12 });
});
it('moves an approved device to in-progress and counts stats', async () => {
  await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
  expect((await listReplenishmentQueue(t.db, { tab: 'in-progress' })).map((d) => d.drmsId)).toEqual(['d1']);
  expect(await getReplenishmentStats(t.db)).toMatchObject({ awaitingReviewDevices: 2, awaitingReviewProposals: 2, openMpsOrders: 1 });
  expect(await countAwaitingReview(t.db)).toBe(2);
});
it('resolves an uncertain order either way and retries a failed one', async () => { /* set status manually; assert transitions, proposal statuses and bad_state on wrong source states */ });
```

Write the full bodies (seed ids captured from `.returning()`); the "refuses a device whose link has gone" and "resolves…" tests follow the patterns above.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `replenishment.ts` per the Interfaces and rules above (same style as `settings.ts`: a `ReplenishmentError` class, `db.transaction`, guarded updates with `.returning()` to count, `audit_log` insert). **Step 4: Run** `npx vitest run packages/db` → PASS; typecheck + lint.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/queries/replenishment.ts packages/db/src/queries/replenishment.test.ts packages/db/src/queries/index.ts
git commit -m "feat(db): toner order queue reads and audited approve/reject/resolve actions"
```

---

### Task 8: `vantage-order-submit` job + kill switch + `created_by_mps`

**Files:**
- Create: `apps/worker/src/jobs/vantage-order-submit.ts`
- Test: `apps/worker/src/jobs/vantage-order-submit.test.ts`
- Modify: `packages/queue/src/index.ts`, `apps/worker/src/queue-options.ts`, `apps/worker/src/env.ts` (+ `env.test.ts`), `apps/worker/src/handlers.ts` (+ test), `apps/worker/src/main.ts`, `apps/worker/src/jobs/vantage-orders.ts` (+ test), `.env.example`, `apps/web/src/components/admin-jobs.ts`

**Interfaces:**
- Consumes: `VantageClient.createConsumableOrder`, `UncertainWriteError`, `HttpError`, `AuthError` (T1); T2 tables; `setAppState` (`@mps/db`).
- Produces: `QUEUES.vantageOrderSubmit = 'vantage-order-submit'`; env `VANTAGE_ORDERS_ENABLED: boolean` (default false; `'true'`/`'1'` enable); `runVantageOrderSubmit(deps: { db: Db; vantage: Pick<VantageClient, 'createConsumableOrder'>; enabled: boolean; now?: () => Date }): Promise<JobResult>` with stats `{ queued, sent, failed, uncertain, disabled: 0|1 }`; `app_state.vantage_orders_enabled` (boolean) written at worker start.

- [ ] **Step 1: Write the failing tests**

```ts
// Seed: user, device 'd1' linked to 100, two approved proposals attached to one queued order
// (request { components: [{ Type: 1, RequestedQuantity: 1 }] }).
function fakeVantage(result: { status: number; body: unknown } | Error) {
  const calls: { id: number; components: unknown }[] = [];
  return { calls, client: { async createConsumableOrder(id: number, components: unknown) { calls.push({ id, components }); if (result instanceof Error) throw result; return result; } } };
}

it('does nothing at all while the kill switch is off', async () => {
  const v = fakeVantage({ status: 201, body: {} });
  const r = await runVantageOrderSubmit({ db: t.db, vantage: v.client, enabled: false, now: () => NOW });
  expect(r.stats).toMatchObject({ disabled: 1, queued: 1, sent: 0 });
  expect(v.calls).toEqual([]);
  expect((await order()).status).toBe('queued');
});
it('sends each queued order once and records the Vantage order', async () => {
  const v = fakeVantage({ status: 201, body: { Id: 991, Reference: 'SO991', IsOnHold: false } });
  const r = await runVantageOrderSubmit({ db: t.db, vantage: v.client, enabled: true, now: () => NOW });
  expect(v.calls).toEqual([{ id: 100, components: [{ Type: 1, RequestedQuantity: 1 }] }]);
  expect(r.stats).toMatchObject({ sent: 1 });
  expect(await order()).toMatchObject({ status: 'submitted', vantageSalesOrderId: 991, vantageReference: 'SO991', isOnHold: false, submittedAt: NOW });
  expect((await proposals()).every((p) => p.status === 'ordered')).toBe(true);
  await runVantageOrderSubmit({ db: t.db, vantage: v.client, enabled: true, now: () => NOW });
  expect(v.calls).toHaveLength(1); // never re-sent
});
it('marks a 4xx as failed with the message, and its proposals failed', async () => {
  const v = fakeVantage(new HttpError('Vantage POST failed (400)', 400, '{"Message":"no compatible toner"}'));
  await runVantageOrderSubmit({ db: t.db, vantage: v.client, enabled: true, now: () => NOW });
  expect(await order()).toMatchObject({ status: 'failed', error: expect.stringContaining('no compatible toner') });
  expect((await proposals()).every((p) => p.status === 'failed')).toBe(true);
});
it('marks an uncertain outcome uncertain and leaves proposals approved', async () => {
  const v = fakeVantage(new UncertainWriteError('no response', null));
  const r = await runVantageOrderSubmit({ db: t.db, vantage: v.client, enabled: true, now: () => NOW });
  expect(r.status).toBe('partial');
  expect(await order()).toMatchObject({ status: 'uncertain' });
  expect((await proposals()).every((p) => p.status === 'approved')).toBe(true);
});
it('stops the run on an auth error and leaves the order queued', async () => {
  const v = fakeVantage(new AuthError('bad credentials', 401));
  const r = await runVantageOrderSubmit({ db: t.db, vantage: v.client, enabled: true, now: () => NOW });
  expect(r.status).toBe('partial');
  expect((await order()).status).toBe('queued');
});
it('accepts a 204 without an id', async () => { /* status 'submitted', vantageSalesOrderId null */ });
```

In `vantage-orders.test.ts` add: an order pulled whose id matches a `replenishment_orders.vantage_sales_order_id` ends with `createdByMps = true`; others stay false.
In `env.test.ts` add: `VANTAGE_ORDERS_ENABLED` defaults to `false`, `'true'` → true, `'false'` → false.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement the job**

```ts
import { AuthError, HttpError, errorMessage, getBool, getNumber, getString } from '@mps/core';
import { replenishmentOrders, replenishmentProposals, type Db } from '@mps/db';
import type { ConsumableComponent, VantageClient } from '@mps/vantage';
import { and, asc, eq } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

export interface VantageOrderSubmitDeps {
  db: Db;
  vantage: Pick<VantageClient, 'createConsumableOrder'>;
  /** `VANTAGE_ORDERS_ENABLED`. While false this job sends nothing. */
  enabled: boolean;
  now?: () => Date;
}

/**
 * The only code that writes to Vantage. One POST per queued order, claimed first (queued →
 * submitting) so it can never be sent twice, and never retried: an uncertain outcome is left for a
 * person to check in Vantage (`resolveOrder`).
 */
export async function runVantageOrderSubmit(deps: VantageOrderSubmitDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const now = deps.now ?? (() => new Date());
  const queued = await db
    .select({ id: replenishmentOrders.id })
    .from(replenishmentOrders)
    .where(eq(replenishmentOrders.status, 'queued'))
    .orderBy(asc(replenishmentOrders.id));

  const stats = { queued: queued.length, sent: 0, failed: 0, uncertain: 0, disabled: deps.enabled ? 0 : 1 };
  if (!deps.enabled) return { status: 'success', stats };

  for (const { id } of queued) {
    const [claimed] = await db
      .update(replenishmentOrders)
      .set({ status: 'submitting' })
      .where(and(eq(replenishmentOrders.id, id), eq(replenishmentOrders.status, 'queued')))
      .returning();
    if (!claimed) continue;
    const components = (claimed.request as { components: ConsumableComponent[] }).components;

    try {
      const res = await vantage.createConsumableOrder(claimed.vantageEquipmentId, components);
      await db.transaction(async (tx) => {
        await tx
          .update(replenishmentOrders)
          .set({
            status: 'submitted',
            response: res as never,
            vantageSalesOrderId: getNumber(res.body, 'Id'),
            vantageReference: getString(res.body, 'Reference'),
            isOnHold: getBool(res.body, 'IsOnHold'),
            submittedAt: now(),
          })
          .where(eq(replenishmentOrders.id, id));
        await tx.update(replenishmentProposals).set({ status: 'ordered' }).where(eq(replenishmentProposals.orderId, id));
      });
      stats.sent++;
    } catch (err) {
      if (err instanceof AuthError) {
        // Nothing was accepted; put it back and stop — every other order would fail the same way.
        await db.update(replenishmentOrders).set({ status: 'queued' }).where(eq(replenishmentOrders.id, id));
        return { status: 'partial', stats, errorSample: `stopped: ${errorMessage(err)}` };
      }
      if (err instanceof HttpError && err.status !== null && err.status < 500) {
        await db.transaction(async (tx) => {
          await tx
            .update(replenishmentOrders)
            .set({ status: 'failed', error: `${err.message}: ${err.body ?? ''}`.slice(0, 1000), submittedAt: now() })
            .where(eq(replenishmentOrders.id, id));
          await tx.update(replenishmentProposals).set({ status: 'failed' }).where(eq(replenishmentProposals.orderId, id));
        });
        stats.failed++;
        continue;
      }
      // UncertainWriteError or anything unexpected: the order may exist. Never re-send.
      await db
        .update(replenishmentOrders)
        .set({ status: 'uncertain', error: errorMessage(err), submittedAt: now() })
        .where(eq(replenishmentOrders.id, id));
      stats.uncertain++;
    }
  }
  return { status: stats.failed + stats.uncertain > 0 ? 'partial' : 'success', stats };
}
```

(`UncertainWriteError` needs no branch of its own: it falls through to "uncertain" with anything else unexpected. Import only `AuthError, HttpError, errorMessage, getBool, getNumber, getString` from `@mps/core`.)

**Response parsing:** if Task 1 found the id under another field name (or none), adjust the three `get*` calls and the tests here before implementing.

- [ ] **Step 4: Wire it**

- `QUEUES.vantageOrderSubmit = 'vantage-order-submit'`; queue option `stately(…, 900)`.
- `env.ts`: `VANTAGE_ORDERS_ENABLED: z.enum(['true', 'false', '1', '0']).default('false').transform((v) => v === 'true' || v === '1'),`
- `handlers.ts`: `HandlerDeps.vantageOrdersEnabled: boolean`; handler `[QUEUES.vantageOrderSubmit]: () => withSyncRun(db, QUEUES.vantageOrderSubmit, () => runVantageOrderSubmit({ db, vantage, enabled: deps.vantageOrdersEnabled, now }))` (wrap in `async () => { await … }` like the others).
- `main.ts`: pass `vantageOrdersEnabled: env.VANTAGE_ORDERS_ENABLED`; after `setAppState(db, 'drms_token_expiry', …)` add `await setAppState(db, 'vantage_orders_enabled', env.VANTAGE_ORDERS_ENABLED);`; schedule a safety sweep `await boss.schedule(QUEUES.vantageOrderSubmit, '*/10 * * * *', {}, { tz });` (orders queued while the worker was down still go out).
- `vantage-orders.ts`: after the upsert loop,

```ts
  // Badge the orders this app raised. Ours is the only source of the flag, so it is set here
  // rather than trusted from Vantage.
  await db
    .update(vantageSalesOrders)
    .set({ createdByMps: true })
    .where(
      and(
        eq(vantageSalesOrders.createdByMps, false),
        inArray(
          vantageSalesOrders.vantageId,
          db.select({ id: replenishmentOrders.vantageSalesOrderId }).from(replenishmentOrders).where(isNotNull(replenishmentOrders.vantageSalesOrderId)),
        ),
      ),
    );
```

  and update its header comment (it still never writes to Vantage).
- `.env.example`: `VANTAGE_ORDERS_ENABLED=false  # true sends approved toner orders to Vantage — only the user turns this on`.
- `admin-jobs.ts` card: title "Send toner orders to Vantage", description "Sends approved toner orders to Vantage as consumable sales orders — the only job that writes to Vantage. Does nothing while VANTAGE_ORDERS_ENABLED is off.", schedule "When an order is approved, and every 10 minutes", `external: true`.

- [ ] **Step 5: Run** `npx vitest run apps/worker apps/web packages/queue` → PASS; typecheck + lint.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/jobs/vantage-order-submit.ts apps/worker/src/jobs/vantage-order-submit.test.ts packages/queue/src/index.ts apps/worker/src/queue-options.ts apps/worker/src/env.ts apps/worker/src/env.test.ts apps/worker/src/handlers.ts apps/worker/src/handlers.test.ts apps/worker/src/main.ts apps/worker/src/jobs/vantage-orders.ts apps/worker/src/jobs/vantage-orders.test.ts .env.example apps/web/src/components/admin-jobs.ts
git commit -m "feat(worker): send approved toner orders to Vantage behind a kill switch, never retried"
```

---

### Task 9: Cascade-based "Needs toner", "Manual replenishment" filter, alerts on/off

**Files:**
- Modify: `packages/db/src/queries/shared.ts`, `fleet.ts`, `devices.ts`, `queries.test.ts`
- Modify: `apps/worker/src/jobs/alerts-evaluate.ts` (+ test)
- Modify: `apps/web/src/app/(app)/devices/page.tsx` (new tab + empty text), `apps/web/src/app/(app)/page.tsx` (tile)

**Interfaces:**
- Consumes: `effectiveSettingsSubquery` (T3), `getReplenishmentStats` (T7).
- Produces: `belowThreshold(pivot, eff): SQL` in `shared.ts` — `pivot.black < eff.thresholdBlack or pivot.cyan < eff.thresholdCyan or pivot.magenta < eff.thresholdMagenta or pivot.yellow < eff.thresholdYellow` (null levels and mono CMY are already null in the pivot, so they never match); `DeviceListOptions.filter` gains `'manual'`; `FleetSummary.needsToner` now = below threshold **and** auto-replenish on; new `FleetSummary.manualLow` = below threshold and auto-replenish off. `criticalToner`/`lowToner` keep their 5%/20% meaning but are only used by the toner health card.

- [ ] **Step 1: Failing tests** in `queries.test.ts`: with the default row (K15/C10), a colour device at black 14 is in `needs-toner` and `needsToner`; the same device at black 16, cyan 12 is not; after `updateDeviceSettings(... { autoReplenish: false })` it moves to `filter: 'manual'` and `manualLow`; a mono device with pivot CMY null and black 50 is in neither. In `alerts-evaluate.test.ts`: a stale device with `alertsEnabled: false` gets no alert, and an already-open alert on it is cleared with `details.clearedReason = 'alerts switched off'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `fleet.ts` and `devices.ts`, left-join `effectiveSettingsSubquery(db)` on `drmsId` next to the pivot and replace the hard-coded `< 20` needs-toner conditions with `and(belowThreshold(pivot, eff), eq(eff.autoReplenish, true))`; `'manual'` uses `eq(eff.autoReplenish, false)`. Keep `urgencyRank` on 5/20 (display). In `alerts-evaluate.ts`, add to `candidateFilter` a subquery restriction to devices whose effective `alertsEnabled` is true, and before returning, clear open offline alerts of devices whose `alertsEnabled` is false (`cleared_at = now`, `details = details || {"clearedReason":"alerts switched off"}`), counting them in `cleared`.
- [ ] **Step 4: Web.** Devices page: add `{ value: 'manual', label: 'Manual replenishment' }` to `FILTERS`, `EMPTY.manual = 'No device with auto-replenishment switched off is below its threshold.'`, and change `EMPTY['needs-toner']` to `'No device is below its replenishment threshold.'`. Fleet page: `getReplenishmentStats(db)` joins the `Promise.all`; the Needs toner tile becomes a link to `/orders` (wrap `StatCard` in `<Link href="/orders" className="…rounded-xl focus-visible:ring…">`, or add an `href` prop to `StatCard` if cleaner) with `sub={`${formatNumber(stats.awaitingReviewDevices)} awaiting review · ${formatNumber(stats.onOrderDevices)} on order`}`.
- [ ] **Step 5: Run** `npm test` (all) → PASS; typecheck + lint.
- [ ] **Step 6: Commit**

```bash
git add packages/db/src/queries/shared.ts packages/db/src/queries/fleet.ts packages/db/src/queries/devices.ts packages/db/src/queries/queries.test.ts apps/worker/src/jobs/alerts-evaluate.ts apps/worker/src/jobs/alerts-evaluate.test.ts "apps/web/src/app/(app)/devices/page.tsx" "apps/web/src/app/(app)/page.tsx"
git commit -m "feat: needs-toner follows the settings cascade; manual filter; per-device alerts switch"
```

---

### Task 10 (opus): Toner orders page — the review queue

**Files:**
- Create: `apps/web/src/app/(app)/orders/page.tsx`, `apps/web/src/app/(app)/orders/actions.ts`
- Create: `apps/web/src/components/replenishment-queue.tsx` (client), `apps/web/src/components/replenishment.ts` (pure display helpers) + `replenishment.test.ts`
- Modify: `apps/web/src/components/app-sidebar.tsx`, `apps/web/src/lib/nav-counts.ts`, `apps/web/src/app/(app)/layout.tsx` (pass the new count)

**Interfaces:**
- Consumes: `listReplenishmentQueue`, `getReplenishmentStats`, `countAwaitingReview`, `approveProposals`, `rejectProposals`, `resolveOrder`, `retryOrder`, `ReplenishmentError` (T7); `getAppState` (`@mps/db`); `sendJob`, `QUEUES` (`@mps/queue`).
- Produces: server actions `approveAction(formData)`, `rejectAction(formData)`, `resolveOrderAction(formData)`, `retryOrderAction(formData)`; `NavCounts.awaitingReview`; helpers `colourLabel(c)`, `triggerLabel(p)`, `sourceLabel(s)`, `orderStatusTone(status)`.

- [ ] **Step 1: Helper tests** (`replenishment.test.ts`, pure): `colourLabel('waste') === 'Waste toner box'`; `triggerLabel({ trigger: 'threshold', level: 4, threshold: 10 }) === '4% · below 10%'`; `triggerLabel({ trigger: 'alarm', alarmDescription: 'Toner Near Empty(C)' }) === 'DRMS alarm: Toner Near Empty(C)'`; `sourceLabel('customer') === 'customer setting'`; `orderStatusTone('uncertain') === 'critical'`, `'failed' → 'critical'`, `'queued'|'submitting' → 'warn'`, `'submitted' → 'ok'`. Run → FAIL, implement `replenishment.ts`, run → PASS.

- [ ] **Step 2: Server actions** (`orders/actions.ts`):

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ReplenishmentError, approveProposals, rejectProposals, resolveOrder, retryOrder } from '@mps/db/queries';
import { QUEUES, sendJob } from '@mps/queue';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requiredEnv } from '@/lib/env';

/** Any signed-in user may decide proposals; the user id always comes from the session. */
async function run(fn: (userId: number) => Promise<void>, back: string): Promise<void> {
  const user = await requireUser();
  try {
    await fn(user.userId);
  } catch (err) {
    if (err instanceof ReplenishmentError) redirect(`${back}${back.includes('?') ? '&' : '?'}error=${err.code}`);
    throw err;
  }
  revalidatePath('/orders');
  revalidatePath('/');
}

export async function approveAction(formData: FormData): Promise<void> {
  const drmsId = String(formData.get('drmsId') ?? '');
  const ids = formData.getAll('proposalId').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const items = ids.map((proposalId) => ({ proposalId, quantity: Number(formData.get(`qty-${proposalId}`) ?? 1) }));
  await run(async (userId) => {
    await approveProposals(getDb(), { drmsId, items, userId });
    // Wake the sender now rather than waiting for its 10-minute sweep. A dedup (null) is fine.
    await sendJob(requiredEnv('DATABASE_URL'), QUEUES.vantageOrderSubmit);
  }, '/orders');
  revalidatePath(`/devices/${drmsId}`);
}

export async function rejectAction(formData: FormData): Promise<void> {
  const proposalIds = formData.getAll('proposalId').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || undefined;
  await run(async (userId) => {
    await rejectProposals(getDb(), { proposalIds, userId, note });
  }, '/orders');
}

export async function resolveOrderAction(formData: FormData): Promise<void> {
  const orderId = Number(formData.get('orderId'));
  const outcome = formData.get('outcome') === 'ordered' ? 'ordered' : 'failed';
  const reference = String(formData.get('reference') ?? '').trim().slice(0, 100) || undefined;
  await run((userId) => resolveOrder(getDb(), { orderId, outcome, reference, userId }), '/orders?tab=in-progress');
}

export async function retryOrderAction(formData: FormData): Promise<void> {
  const orderId = Number(formData.get('orderId'));
  await run(async (userId) => {
    await retryOrder(getDb(), { orderId, userId });
    await sendJob(requiredEnv('DATABASE_URL'), QUEUES.vantageOrderSubmit);
  }, '/orders?tab=in-progress');
}
```

(Import `requiredEnv` from wherever `admin/actions.ts` imports it.)

- [ ] **Step 3: The page** (`orders/page.tsx`, server component): `await requireUser()` first; read `tab` (default `review`) and `error` from `searchParams`; `Promise.all([listReplenishmentQueue(db, { tab }), getReplenishmentStats(db), getAppState<boolean>(db, 'vantage_orders_enabled')])`. Layout (match the mockup's header and card styling):
  - `Breadcrumb` Fleet overview / Toner orders; `PageHeader` title "Toner orders", subtitle "Proposals from low toner and DRMS consumable alarms. Nothing is ordered until someone approves it."; header stats (right-aligned like the mockup): *Awaiting review* (devices), *Open orders* (`openMpsOrders`), *Cartridges this quarter*.
  - A warn banner when `vantage_orders_enabled !== true`: "Sending to Vantage is switched off. Approved orders wait in *In progress* until an administrator sets VANTAGE_ORDERS_ENABLED on the worker." A critical banner when `attentionOrders > 0` linking to `?tab=in-progress`.
  - `FilterTabs` param `tab`: Review (count), In progress (count), Ordered, Rejected.
  - An error line mapping `?error=` codes to sentences (`not_pending`: "Someone else has already decided one of those proposals — the list has been refreshed.", `unlinked`: "That device is no longer linked to Vantage equipment, so it cannot be ordered for.", `bad_quantity`: "Quantities are whole numbers from 1 to 20.", `mixed_devices`/`empty`/`not_found`/`bad_state`: sensible sentences).
  - `<ReplenishmentQueue tab={tab} devices={devices} />`.

- [ ] **Step 4: `replenishment-queue.tsx`** (`'use client'`): one card per device — header row: device name (link to `/devices/[drmsId]`), model, customer · location, serial (mono font). **Review tab**: one `<form action={approveAction}>` per device with hidden `drmsId`; per proposal a row: checkbox `name="proposalId" value={id}` (checked by default), colour swatch (reuse the toner colour classes / `ColourChip`), `colourLabel`, `triggerLabel` with the threshold source as muted text ("default setting"), current level, "Last: SO123 · 3 Sep" / "Open order SO456" from `lastOrder`/`openOrder`, and a − / number / + stepper `name={`qty-${id}`}` 1–20 (like the mockup). Footer: *Approve selected* (primary, `bg-brand`) and *Reject selected* — the reject button uses `formAction={rejectAction}` on the same form, with an optional note input. Disable the buttons while pending (`useFormStatus`). **In progress tab**: order rows with `ToneBadge` status; `failed` shows the error and a *Retry* button (`retryOrderAction`); `uncertain` shows "Vantage did not answer — check whether this order exists in Vantage" with two forms: *It exists* (reference input, `outcome=ordered`) and *It does not* (`outcome=failed`). **Ordered tab**: reference, date, on-hold badge. **Rejected tab**: who, when, note or "superseded: level recovered". Empty states: review "Nothing to review — every device is above its threshold or already on order."

- [ ] **Step 5: Sidebar.** `nav-counts.ts` gains `awaitingReview` via `countAwaitingReview(db)` (one `count(distinct)` query — keep it cheap). `app-sidebar.tsx`: `<NavLink href="/orders" label="Toner orders" icon={<ShoppingCart />} count={awaitingReview} tone="warn" />` after Devices (lucide `ShoppingCart`). Pass it through `layout.tsx`.

- [ ] **Step 6: Verify.** `npx vitest run apps/web` → PASS; typecheck + lint. Then run the app (`npm run dev -w @mps/web`, worker with `VANTAGE_ORDERS_ENABLED` unset), run *Replenishment check* from Admin → Jobs, open `/orders`, approve one proposal and confirm it lands in *In progress* as `queued` with the switched-off banner — **nothing may reach Vantage**. Reject one and see it under *Rejected*. Take a screenshot for the user.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/(app)/orders" apps/web/src/components/replenishment-queue.tsx apps/web/src/components/replenishment.ts apps/web/src/components/replenishment.test.ts apps/web/src/components/app-sidebar.tsx apps/web/src/lib/nav-counts.ts "apps/web/src/app/(app)/layout.tsx"
git commit -m "feat(web): toner order review queue with approve, reject and order follow-up"
```

---

### Task 11 (opus): Device page — Replenishment card and device settings

**Files:**
- Create: `apps/web/src/components/replenishment-card.tsx`, `apps/web/src/components/settings-dialog.tsx` (client, reused by T12/T13), `apps/web/src/app/(app)/devices/[id]/actions.ts`
- Create: `apps/web/src/lib/settings-form.ts` + `settings-form.test.ts` (pure form parsing, shared by T11–T13)
- Modify: `apps/web/src/app/(app)/devices/[id]/page.tsx`

**Interfaces:**
- Consumes: `getDeviceSettings`, `updateDeviceSettings`, `SettingsError`, `listDeviceReplenishment`.
- Produces: `parseSettingsForm(formData, { allowInherit: boolean; isColour: boolean }): SettingsPatch` — each field arrives as `keep` | `inherit` | a value; thresholds via `threshold-<colour>` + `threshold-<colour>-mode`, flags via `autoReplenish`/`alertsEnabled` = `keep|inherit|on|off`; CMY fields are ignored when `isColour` is false; `updateDeviceSettingsAction(formData)`; `<SettingsDialog title fields initial allowInherit isColour action hidden />`.

- [ ] **Step 1: `settings-form.test.ts`** — `keep` omits the key; `inherit` gives `null` (and throws when `allowInherit` is false); `'15'` gives `15`; `'abc'`/`'101'` throw `SettingsError('invalid_threshold')`; `on`/`off` give booleans; mono ignores CMY. Run → FAIL; implement; run → PASS.
- [ ] **Step 2: Action** `devices/[id]/actions.ts`: `requireUser()`; `drmsId` from the form; `patch = parseSettingsForm(formData, { allowInherit: true, isColour })` where `isColour` is read **from the DB** (`drms_equipment.is_colour`), not the form; `updateDeviceSettings(getDb(), { drmsIds: [drmsId], patch, userId })`; on `SettingsError` redirect back with `?settingsError=<code>`; `revalidatePath` the device page, `/orders`, `/`, `/devices`.
- [ ] **Step 3: Card.** In the device page's side column, above "Links": *Replenishment* card — rows for Black (and Cyan/Magenta/Yellow when colour), Auto-replenish, No-meter-reading alerts. Each shows the effective value and a muted source: "default", "customer setting", or "set on this device by <user>, <date>" (from `deviceRow`/`customerRow` meta). When auto-replenish is off, a `ToneBadge` "Manual replenishment" next to the page title as well. Beneath, this device's live proposals (colour · trigger · status) linking to `/orders`, and its last MPS orders with status badges. An *Edit* button opens `SettingsDialog` with per-field *Keep / Inherit / value* controls (thresholds: a mode select + number input; flags: Keep / Inherit / On / Off), shown with the currently effective value as a hint.
- [ ] **Step 4: Verify** in the running app: change a device's cyan to 20, see "set on this device by admin, …"; reset it to inherited and see "default"; switch auto-replenish off and see the badge and the device under *Manual replenishment* once it is low. Tests + typecheck + lint.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/replenishment-card.tsx apps/web/src/components/settings-dialog.tsx apps/web/src/lib/settings-form.ts apps/web/src/lib/settings-form.test.ts "apps/web/src/app/(app)/devices/[id]"
git commit -m "feat(web): replenishment settings and proposals on the device page"
```

---

### Task 12 (opus): Devices list — selection and bulk settings

**Files:**
- Create: `apps/web/src/components/device-selection.tsx` (client: selection context, checkbox cells, bulk bar, confirm dialog), `apps/web/src/app/(app)/devices/actions.ts`
- Create: `packages/db/src/queries/device-selection.ts` + test
- Modify: `apps/web/src/components/device-table.tsx` (optional `selectable` prop renders a checkbox column), `apps/web/src/app/(app)/devices/page.tsx`

**Interfaces:**
- Consumes: `DeviceListOptions` conditions, `updateDeviceSettings`, `parseSettingsForm`, `SettingsDialog`.
- Produces: `resolveDeviceSelection(db, { search?: string; filter?: DeviceListOptions['filter'] }): Promise<{ drmsIds: string[]; customers: number; hasMono: boolean }>` — refactor the WHERE-building in `listDevices` into an exported `deviceListConditions(db, o)` so the list and the selection can never disagree; `describeSelection(db, drmsIds): Promise<{ count; customers; hasMono; names: string[] }>` (names capped at 50 for the expandable list); `bulkUpdateSettingsAction(formData)`.

- [ ] **Step 1: DB tests** — `resolveDeviceSelection` returns exactly the ids `listDevices` would page through for the same search/filter (assert against a paged `listDevices` with a big limit); `customers` counts distinct Vantage customers (unlinked devices count as one "no customer" group); `hasMono` is true when any selected device is mono. Run → FAIL; implement (extract `deviceListConditions`, reuse it in `listDevices`); run → PASS, and the existing `listDevices` tests still pass.
- [ ] **Step 2: Action** `devices/actions.ts`: `requireUser()`; mode `ids` (repeated `drmsId` fields, capped at 5,000) or `matching` (`search` + `filter` → `resolveDeviceSelection` **on the server**, never trusting a client-sent list for "all matching"); `parseSettingsForm(formData, { allowInherit: true, isColour: true })` — CMY patches are written to mono devices too but are harmless (the engine and UI ignore CMY on mono; the confirm step warns "N mono devices will ignore the colour thresholds"); `updateDeviceSettings` (one transaction, one audit row); redirect back to the same list URL with `?updated=N` (or `?settingsError=code`); revalidate `/devices`, `/`, `/orders`.
- [ ] **Step 3: UI.** Checkbox column (header box = select this page; indeterminate when partial). When anything is selected a sticky bulk bar appears above the table: "*N selected*" · "Select all *total* matching" link (switches to `matching` mode, shown as "All *total* devices matching this view") · *Change settings…* · *Clear*. *Change settings…* opens `SettingsDialog` (same Keep / Inherit / value controls), and *Review* moves to a confirmation step (server-rendered summary via a `describeSelection` call made by a small server action returning JSON, or pass counts from the page): "Set cyan, magenta and yellow threshold to 15% on 42 devices", an expandable list of names, a warning when `customers > 1` ("This selection spans 3 customers"), a note when `hasMono`. *Apply* submits. Show the `?updated=N` result as a toast (`sonner`). Selection state resets when search/filter/page changes.
- [ ] **Step 4: Verify** in the app: select 3 devices → set black 20 → confirm → 3 device rows updated, one audit row (check with psql `select * from audit_log order by id desc limit 1`); "select all matching" on a search for one customer → confirm shows the right count and one customer; reset to inherited clears the overrides. Tests + typecheck + lint.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/device-selection.tsx apps/web/src/components/device-table.tsx "apps/web/src/app/(app)/devices/actions.ts" "apps/web/src/app/(app)/devices/page.tsx" packages/db/src/queries/device-selection.ts packages/db/src/queries/device-selection.test.ts packages/db/src/queries/devices.ts packages/db/src/queries/index.ts
git commit -m "feat(web): bulk replenishment settings from the devices list"
```

---

### Task 13 (opus): Replenishment settings page — defaults and customer overrides

**Files:**
- Create: `apps/web/src/app/(app)/settings/replenishment/page.tsx`, `.../actions.ts`
- Create: `packages/db/src/queries/customers.ts` + test — `searchVantageCustomers(db, q: string, limit = 20): Promise<{ vantageId: number; name: string|null; reference: string|null; deviceCount: number }[]>` (name/reference `ilike`, only customers with ≥1 linked DRMS device, ordered by name)
- Modify: `apps/web/src/components/app-sidebar.tsx` (a "Settings" link for all users, or a link from `/orders`' header — pick the sidebar), `apps/web/src/components/replenishment-card.tsx` (customer source links here)

**Interfaces:**
- Consumes: `updateDefaultSettings`, `updateCustomerSettings`, `listCustomerSettings`, `SettingsDialog`, `parseSettingsForm`.
- Produces: `updateDefaultsAction`, `updateCustomerAction`, `resetCustomerAction` (sets every field to inherit, which deletes the row).

- [ ] **Step 1: DB test** for `searchVantageCustomers` (matches name and reference case-insensitively; excludes customers with no linked device; returns device counts). Run → FAIL; implement; → PASS.
- [ ] **Step 2: Actions** — all `requireUser()` (any signed-in user; spec); defaults use `parseSettingsForm(…, { allowInherit: false, isColour: true })`; customer actions validate `vantageCustomerId` is an integer that exists in `vantage_customers`; audit is written by the query functions; revalidate `/settings/replenishment`, `/`, `/orders`, `/devices`.
- [ ] **Step 3: Page** — card *Defaults* (the four thresholds, auto-replenish, alerts; "last changed by <user>, <date>" from the audit log's latest `entity = 'default'` row) with *Edit*; card *Customer overrides*: table (customer, reference, devices, K/C/M/Y — blank = inherited, auto-replenish, alerts, changed by/at) with *Edit* and *Reset* per row, and *Add customer override* opening a dialog with a customer search (`searchVantageCustomers` via a server action or `?q=` param) then the same settings controls. Copy: "A device uses its own setting first, then its customer's, then these defaults."
- [ ] **Step 4: Verify** in the app: set customer "Acme" auto-replenish off → its devices show "customer setting" on the device page, move to *Manual replenishment* when low, and their pending proposals are superseded on the next *Replenishment check*. Tests + typecheck + lint.
- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/settings" packages/db/src/queries/customers.ts packages/db/src/queries/customers.test.ts packages/db/src/queries/index.ts apps/web/src/components/app-sidebar.tsx apps/web/src/components/replenishment-card.tsx
git commit -m "feat(web): default and per-customer replenishment settings"
```

---

### Task 14: Full test pass, live enablement with the user, handoff

**Files:**
- Create: `docs/TEST-REPORT-<date>.md`
- Modify: `docs/HANDOFF.md`, `CLAUDE.md` (rules: the one Vantage write, never retry, kill switch), `docs/superpowers/specs/2026-09-21-replenishment-design.md` (status line)

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint` — all green; record counts.
- [ ] **Step 2: Worker end-to-end against local Postgres**, kill switch **off**: run `drms-snapshot` (or use existing data), `drms-alarms`, `vantage-orders`, then confirm `replenish-evaluate` ran after each (`sync_runs`), and record its stats. Sanity-check the proposals against the fleet: every proposed colour is strictly below its effective threshold or has a ready alarm; no CMY on mono devices; no proposal where `getOrderStates` shows an open order. Write the SQL used into the report.
- [ ] **Step 3: UI pass**, page by page (Fleet tile → /orders, review/approve/reject, in-progress with the switched-off banner, device card + edit + reset, bulk edit incl. select-all-matching and confirm, settings page defaults + customer override). Note anything left untested.
- [ ] **Step 4: STOP — enable with the user.** Only with the user's explicit OK: set `VANTAGE_ORDERS_ENABLED=true` for the worker, restart it, approve **one** real proposal the user picks, watch `vantage-order-submit` send it, check the order in Vantage with the user, run `vantage-orders` and confirm the order shows with the MPS badge on the device page. If anything is off, set the switch back to false.
- [ ] **Step 5:** Write the test report (as in `docs/TEST-REPORT-2026-09-18.md`: what was run, results, recorded-but-unfixed items, what was not tested). Update `HANDOFF.md` (state, what's next: sub-project 4 site stock) and the spec's status line. Add to `CLAUDE.md` under "Rules that aren't obvious": the Vantage write rule, never retry POST, the kill switch and where it's shown.
- [ ] **Step 6: Commit** (and ask the user before pushing)

```bash
git add docs/TEST-REPORT-*.md docs/HANDOFF.md CLAUDE.md docs/superpowers/specs/2026-09-21-replenishment-design.md
git commit -m "docs: sub-project 3 test report and handoff"
```
