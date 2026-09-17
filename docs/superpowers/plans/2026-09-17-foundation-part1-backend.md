# MPS Brain Foundation — Part 1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend of the MPS brain Foundation: Postgres schema, pure DRMS↔Vantage linking logic, DRMS3 and Vantage API clients, and a pg-boss worker that pulls both systems, links devices and stores nightly counter snapshots.

**Architecture:** npm-workspaces TypeScript monorepo. Pure logic lives in `packages/core`, the API clients in `packages/drms` and `packages/vantage`, the Drizzle schema in `packages/db`, and queue names in `packages/queue`. `apps/worker` wires them together through pg-boss schedules. Packages are consumed as TypeScript source (no build step): the worker runs under `tsx`, and Next.js (Part 2) transpiles them. DB tests run against in-process PGlite, so no Docker is needed for `npm test`.

**Tech Stack:** Node 24, TypeScript 5, Vitest 3, Drizzle ORM 0.44 + drizzle-kit 0.31, pg 8, PGlite 0.3 (tests), pg-boss 10, zod 4, @node-rs/argon2 2, tsx 4.

**Spec:** `docs/superpowers/specs/2026-09-17-mps-foundation-design.md`

## Global Constraints

- Repo root: `C:\dev\mps-brain`. All paths below are relative to it.
- DRMS3 is **read-only** in this sub-project: no `EquipmentRequest/*` calls, ever.
- DRMS throttle: at most **1,000 calls/min per method**. After a 429, **no call to that method for 10 minutes**. Never retry a 429.
- Vantage: `api-version` header on **every** call (env `VANTAGE_API_VERSION`, default `1.22`). Add `deleteddate eq null` unless deleted rows are explicitly wanted. Reissue the token when less than 5 min is left.
- Secrets only from env. Never log tokens. Never read or copy `F:\dev\API Docs Etc\API Keys.txt` or the token inside the `.docx`.
- Keep every synced API payload in a `raw jsonb` column.
- Queue/job names: `vantage-pull`, `drms-pull`, `link-run`, `drms-snapshot` (hyphens, not the spec's dots, for pg-boss name safety).
- Schedules (tz `Europe/London`): vantage-pull `0 2 * * *` (full refresh on Sundays), drms-pull `15 2 * * *`, drms-snapshot `SNAPSHOT_CRON` default `0 6 * * *`, link-run queued 120 s after either pull finishes.
- Auto-linking is automatic (ERP ID first, then exact normalised serial). Manual links are never overwritten.
- ESM everywhere (`"type": "module"`). Workspace packages export `./src/index.ts` directly.
- Commit after every task, with a message ending in the line `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- If an installed library's API differs from the code here (version drift), check its docs (context7) and adapt. Keep behaviour and names the same.

## File Map

```
package.json, tsconfig.base.json, vitest.config.ts, eslint.config.js, .prettierrc, .env.example
scripts/phase0-spike.ts                     Task 2  read-only discovery against real APIs
packages/core/src/fields.ts                 Task 1  normaliseSerial/Key, getField/String/Number/Bool, parseApiDate, chunk, mapPool
packages/core/src/errors.ts                 Task 1  ApiError family, errorMessage, ErrorCollector
packages/core/src/linking.ts                Task 4  computeLinks, diffLinks, issueKey, types
packages/core/src/issues.ts                 Task 5  reconcileIssues, deriveCustomerLinks
packages/db/src/schema.ts                   Task 3  all tables
packages/db/src/client.ts                   Task 3  Db type, createDb, excluded()
packages/db/src/users.ts, app-state.ts      Task 3  password hashing, admin seed, key/value state
packages/db/src/migrate.ts, testing.ts      Task 3  runMigrations, createTestDb (PGlite)
packages/drms/src/{limiter,jwt,schemas,client}.ts   Task 6
packages/vantage/src/client.ts              Task 7
packages/queue/src/index.ts                 Task 8  QUEUES, createBoss
apps/worker/src/{env,sync-runs,time}.ts     Task 8
apps/worker/src/jobs/vantage-pull.ts        Task 9
apps/worker/src/jobs/drms-pull.ts           Task 10
apps/worker/src/jobs/link-run.ts            Task 11
apps/worker/src/jobs/drms-snapshot.ts       Task 12
apps/worker/src/main.ts                     Task 13
apps/worker/src/test-helpers.ts             Task 9 (extended in 10–12)
```

---

### Task 1: Monorepo scaffold + core field utilities

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `.env.example`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/fields.ts`, `packages/core/src/errors.ts`
- Test: `packages/core/src/fields.test.ts`, `packages/core/src/errors.test.ts`

**Interfaces:**
- Produces (`@mps/core`):
  - `normaliseSerial(v: string | null | undefined): string | null`
  - `normaliseKey(v: string | number | null | undefined): string | null`
  - `getField(obj: unknown, name: string): unknown` (case-insensitive key lookup)
  - `getString(obj, name): string | null`, `getNumber(obj, name): number | null`, `getBool(obj, name): boolean | null`
  - `parseApiDate(v: unknown): Date | null` (accepts `YYYY-MM-DD HH:mm:ss` as UTC, and ISO)
  - `chunk<T>(items: readonly T[], size: number): T[][]`
  - `mapPool<T>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<void>, shouldStop?: () => boolean): Promise<void>`
  - `class ApiError extends Error { status: number | null; body?: string }`, and the subclasses `AuthError`, `HttpError`, `ParseError`, `RateLimitError` (`retryAt: Date`)
  - `errorMessage(err: unknown): string`, `class ErrorCollector { count: number; add(context: string, err: unknown): void; sample: string | undefined }`

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "mps-brain",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "format": "prettier --write ."
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/worker/src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

`eslint.config.js`:
```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/drizzle/**', 'fixtures/**'] },
  ...tseslint.configs.recommended,
);
```

`.prettierrc`:
```json
{ "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

`.env.example`:
```
DATABASE_URL=postgres://mps:mps@localhost:5432/mps
DRMS_BASE_URL=https://drmsqa.konicaminolta.eu/DRMS3Webservice/api/v8
DRMS_TOKEN=
VANTAGE_BASE_URL=https://api.vantage.online
VANTAGE_USER=
VANTAGE_PASS=
VANTAGE_API_VERSION=1.22
LINK_ERP_ID_FIELD=id
LINK_CUSTOMER_ERP_FIELD=none
SNAPSHOT_CRON=0 6 * * *
TZ_SCHEDULE=Europe/London
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
SESSION_SECRET=
```

`packages/core/package.json`:
```json
{
  "name": "@mps/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

`packages/core/tsconfig.json` (use the same content for every package and for the worker):
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 2: Install root dev tooling**

Run: `npm i -D typescript@^5 vitest@^3 tsx@^4 @types/node@^24 eslint@^9 typescript-eslint@^8 prettier@^3`
Expected: `node_modules/` created, and `package-lock.json` written.

- [ ] **Step 3: Write failing tests**

`packages/core/src/fields.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  chunk,
  getBool,
  getField,
  getNumber,
  getString,
  mapPool,
  normaliseKey,
  normaliseSerial,
  parseApiDate,
} from './fields';

describe('normaliseSerial', () => {
  it('trims, upper-cases and strips spaces and dashes', () => {
    expect(normaliseSerial(' a1b2-c3 d4e ')).toBe('A1B2C3D4E');
  });
  it('returns null for empty or missing', () => {
    expect(normaliseSerial('  - ')).toBeNull();
    expect(normaliseSerial(null)).toBeNull();
    expect(normaliseSerial(undefined)).toBeNull();
  });
});

describe('normaliseKey', () => {
  it('stringifies numbers and upper-cases strings', () => {
    expect(normaliseKey(42)).toBe('42');
    expect(normaliseKey(' cust1 ')).toBe('CUST1');
    expect(normaliseKey('')).toBeNull();
  });
});

describe('getField family', () => {
  const obj = { SerialNumber: 'X1', id: '7', IsActive: 'false', Flag: true, Empty: '' };
  it('finds keys case-insensitively', () => {
    expect(getField(obj, 'serialnumber')).toBe('X1');
    expect(getField(obj, 'Id')).toBe('7');
    expect(getField(null, 'x')).toBeUndefined();
  });
  it('converts types', () => {
    expect(getString(obj, 'Id')).toBe('7');
    expect(getNumber(obj, 'Id')).toBe(7);
    expect(getNumber(obj, 'Empty')).toBeNull();
    expect(getNumber(obj, 'SerialNumber')).toBeNull();
    expect(getBool(obj, 'IsActive')).toBe(false);
    expect(getBool(obj, 'Flag')).toBe(true);
    expect(getBool(obj, 'Missing')).toBeNull();
  });
});

describe('parseApiDate', () => {
  it('parses DRMS space format as UTC', () => {
    expect(parseApiDate('2026-09-17 06:30:00')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
  });
  it('parses ISO with and without zone', () => {
    expect(parseApiDate('2026-09-17T06:30:00Z')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
    expect(parseApiDate('2026-09-17T06:30:00')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
    expect(parseApiDate('2026-09-17T07:30:00+01:00')?.toISOString()).toBe(
      '2026-09-17T06:30:00.000Z',
    );
  });
  it('returns null for junk', () => {
    expect(parseApiDate('not a date')).toBeNull();
    expect(parseApiDate(null)).toBeNull();
    expect(parseApiDate('')).toBeNull();
  });
});

describe('chunk', () => {
  it('splits into fixed-size pieces', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('mapPool', () => {
  it('processes every item with bounded concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const seen: number[] = [];
    await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(maxActive).toBe(2);
  });
  it('stops picking new items when shouldStop returns true', async () => {
    const seen: number[] = [];
    let stop = false;
    await mapPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        seen.push(n);
        if (n === 2) stop = true;
      },
      () => stop,
    );
    expect(seen).toEqual([1, 2]);
  });
});
```

`packages/core/src/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ApiError, AuthError, ErrorCollector, RateLimitError, errorMessage } from './errors';

describe('errors', () => {
  it('keeps subclass identity and status', () => {
    const err = new AuthError('nope', 401);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe('AuthError');
    expect(err.status).toBe(401);
  });
  it('RateLimitError carries retryAt and 429', () => {
    const at = new Date('2026-01-01T00:10:00Z');
    const err = new RateLimitError('slow down', at);
    expect(err.status).toBe(429);
    expect(err.retryAt).toBe(at);
  });
  it('errorMessage formats errors and non-errors', () => {
    expect(errorMessage(new AuthError('bad', 401))).toBe('AuthError: bad');
    expect(errorMessage('plain')).toBe('plain');
  });
  it('ErrorCollector counts all and samples first five', () => {
    const c = new ErrorCollector();
    expect(c.sample).toBeUndefined();
    for (let i = 0; i < 7; i++) c.add(`dev${i}`, new Error(`e${i}`));
    expect(c.count).toBe(7);
    expect(c.sample?.split('\n')).toHaveLength(5);
    expect(c.sample).toContain('dev0: Error: e0');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run packages/core`
Expected: FAIL, "Failed to resolve import './fields'" (and './errors').

- [ ] **Step 5: Implement**

`packages/core/src/fields.ts`:
```ts
export function normaliseSerial(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = value.trim().toUpperCase().replace(/[\s-]/g, '');
  return s === '' ? null : s;
}

export function normaliseKey(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase();
  return s === '' ? null : s;
}

export function getField(obj: unknown, name: string): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  if (name in rec) return rec[name];
  const lower = name.toLowerCase();
  const key = Object.keys(rec).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : rec[key];
}

export function getString(obj: unknown, name: string): string | null {
  const v = getField(obj, name);
  return v == null ? null : String(v);
}

export function getNumber(obj: unknown, name: string): number | null {
  const v = getField(obj, name);
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function getBool(obj: unknown, name: string): boolean | null {
  const v = getField(obj, name);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

export function parseApiDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  if (s.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
}
```

`packages/core/src/errors.ts`:
```ts
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends ApiError {}
export class HttpError extends ApiError {}
export class ParseError extends ApiError {}

export class RateLimitError extends ApiError {
  constructor(
    message: string,
    readonly retryAt: Date,
  ) {
    super(message, 429);
  }
}

export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 1000);
}

export class ErrorCollector {
  count = 0;
  private samples: string[] = [];

  add(context: string, err: unknown): void {
    this.count++;
    if (this.samples.length < 5) this.samples.push(`${context}: ${errorMessage(err)}`);
  }

  get sample(): string | undefined {
    return this.samples.length > 0 ? this.samples.join('\n') : undefined;
  }
}
```

`packages/core/src/index.ts`:
```ts
export * from './fields';
export * from './errors';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/core`, then `npm run typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo and core field utilities

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Phase 0 discovery spike (needs real credentials from the user)

This is a throwaway, read-only script. **It needs the user to create `.env` with real DRMS QA and Vantage credentials.** If `.env` isn't there, ask the user. Don't read `API Keys.txt` yourself. If the user isn't available, skip to Task 3 and come back: later tasks use configurable defaults and don't depend on the answers.

**Files:**
- Create: `scripts/phase0-spike.ts`
- Modify: `docs/superpowers/specs/2026-09-17-mps-foundation-design.md` (append a "Phase 0 findings" section)

**Interfaces:** none (standalone script, writes to gitignored `fixtures/raw/`).

- [ ] **Step 1: Write the script**

`scripts/phase0-spike.ts`:
```ts
// Phase 0: read-only discovery. Run: npx tsx --env-file=.env scripts/phase0-spike.ts
import { mkdir, writeFile } from 'node:fs/promises';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const OUT = 'fixtures/raw';
await mkdir(OUT, { recursive: true });
const save = (name: string, data: unknown) =>
  writeFile(`${OUT}/${name}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));

// ---------- DRMS ----------
const drmsBase = env('DRMS_BASE_URL').replace(/\/+$/, '');
const drmsToken = env('DRMS_TOKEN');
async function drms(path: string): Promise<unknown> {
  const res = await fetch(`${drmsBase}/${path}`, {
    headers: { Authorization: `Bearer ${drmsToken}`, Accept: 'application/json' },
  });
  const text = await res.text();
  console.log(`DRMS GET ${path} -> ${res.status} (${text.length} bytes)`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [, payload] = drmsToken.split('.');
if (payload) {
  const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number }).exp;
  console.log('DRMS token exp:', exp ? new Date(exp * 1000).toISOString() : 'none');
}
console.log('Test/Auth:', await drms('Test/Auth'));
console.log('Test/Client:', await drms('Test/Client'));

type Row = Record<string, unknown>;
const page1 = (await drms('Equipment?pageNo=1')) as Row[];
const page0 = (await drms('Equipment?pageNo=0')) as Row[];
await save('drms-equipment-page1.json', page1);
console.log('Equipment page1 count:', Array.isArray(page1) ? page1.length : 'NOT ARRAY');
console.log(
  'pageNo=0 same first Id as pageNo=1?',
  Array.isArray(page0) && Array.isArray(page1) && page0[0]?.Id === page1[0]?.Id,
);
if (!Array.isArray(page1)) process.exit(1);

const statusCounts: Record<string, number> = {};
for (const e of page1) statusCounts[String(e.Status)] = (statusCounts[String(e.Status)] ?? 0) + 1;
console.log('Status counts (page1):', statusCounts);
console.log('Field names on equipment:', Object.keys(page1[0] ?? {}).join(', '));
console.log(
  'Sample ErpId / SerialNumber / CustomerErpId / CustomerName:',
  page1.slice(0, 10).map((e) => [e.ErpId, e.SerialNumber, e.CustomerErpId, e.CustomerName]),
);

const counterNames = new Set<string>();
const registered = page1.filter((e) => String(e.Status).toLowerCase() === 'registered').slice(0, 5);
for (const e of registered) {
  const c = (await drms(`Equipment/${e.Id}/LatestCounters`)) as Row;
  await save(`drms-latestcounters-${e.Id}.json`, c);
  for (const x of (c?.Counters as Row[] | undefined) ?? []) counterNames.add(String(x.Name));
  for (const m of (c?.ModeSizeCounters as Row[] | undefined) ?? [])
    for (const x of (m.Counters as Row[] | undefined) ?? []) counterNames.add(String(x.Name));
}
console.log('Counter names seen:', [...counterNames].sort());

const customers = await drms('Customer?pageNo=1');
await save('drms-customer-page1.json', customers);
console.log('Customer page1 count:', Array.isArray(customers) ? customers.length : 'NOT ARRAY');

// ---------- Vantage ----------
const vBase = env('VANTAGE_BASE_URL').replace(/\/+$/, '');
const apiVersion = env('VANTAGE_API_VERSION');
const basic = Buffer.from(`${env('VANTAGE_USER')}:${env('VANTAGE_PASS')}`).toString('base64');
const loginRes = await fetch(`${vBase}/application/loginsingle`, {
  method: 'POST',
  headers: { authorization: `Basic ${basic}`, 'api-version': apiVersion },
});
const login = (await loginRes.json()) as Row;
console.log('Vantage login', loginRes.status, 'keys:', Object.keys(login).join(', '));
const vToken = String(login.Token ?? login.token);
console.log('TokenExpiryDate:', login.TokenExpiryDate ?? login.tokenExpiryDate);

async function vantage(pathAndQuery: string): Promise<unknown> {
  const res = await fetch(`${vBase}/${pathAndQuery}`, {
    headers: { authorization: `Bearer ${vToken}`, 'api-version': apiVersion },
  });
  const text = await res.text();
  console.log(`Vantage GET ${pathAndQuery} -> ${res.status} (${text.length} bytes)`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const q = (s: string) => encodeURIComponent(s);

await save('vantage-metadata.xml', await vantage(`$metadata?api-version=${apiVersion}`));
await save('vantage-customer-top5.json', await vantage(`customer?$top=5`));
await save(
  'vantage-equipment-top5.json',
  await vantage(`Equipment?$top=5&$expand=${q('Item,Customer')}`),
);
const big = (await vantage(`Equipment?$top=1000&$count=true&$select=Id`)) as Row;
console.log(
  'Equipment $top=1000 returned',
  Array.isArray(big) ? big.length : (big?.value as unknown[] | undefined)?.length,
  '@odata.count =',
  (big as Row)?.['@odata.count'],
  'response shape:',
  Array.isArray(big) ? 'array' : Object.keys(big ?? {}).join(', '),
);

for (const e of page1.filter((x) => x.SerialNumber).slice(0, 5)) {
  const serial = String(e.SerialNumber).replace(/'/g, "''");
  const match = await vantage(
    `Equipment?$filter=${q(`serialnumber eq '${serial}'`)}&$expand=${q('Customer')}`,
  );
  const rows = (Array.isArray(match) ? match : (match as Row)?.value) as Row[] | undefined;
  console.log('DRMS', { ErpId: e.ErpId, Serial: e.SerialNumber, CustomerErpId: e.CustomerErpId });
  console.log(
    '  Vantage',
    (rows ?? []).map((r) => ({
      Id: r.Id,
      AssetNumber: r.AssetNumber,
      CustomerId: (r.Customer as Row | undefined)?.Id,
      CustomerRef: (r.Customer as Row | undefined)?.Reference,
    })),
  );
}
console.log('Done. Raw files in fixtures/raw (gitignored). Do not commit them.');
```

- [ ] **Step 2: Ask the user for `.env`, then run**

Run: `npx tsx --env-file=.env scripts/phase0-spike.ts`
Expected: status lines for every call, then the printed comparisons. If a call fails, record the status and the text in the findings, and don't retry in a loop (DRMS 429 rules).

- [ ] **Step 3: Record findings in the spec**

Append to `docs/superpowers/specs/2026-09-17-mps-foundation-design.md`:
```markdown
## Phase 0 findings (YYYY-MM-DD)
- DRMS pageNo first page: 1 | 0 (evidence: …)
- DRMS ErpId holds: Vantage Id | AssetNumber | other/empty (examples: …) → LINK_ERP_ID_FIELD=…
- DRMS CustomerErpId holds: Vantage customer Id | Reference | other (examples: …) → LINK_CUSTOMER_ERP_FIELD=…
- DRMS /Customer returns: end customers | client only (count …)
- Counter names seen: …  (waste toner name: …)
- DRMS token exp: …
- Vantage list response shape: array | {value, @odata.count}; server cap on $top: none | N
- Vantage Equipment customer FK: expanded Customer | CustomerId scalar
```
Fill in every value from the script output. If ErpId or CustomerErpId turns out to be something other than the listed options, stop and tell the user before Task 4.

- [ ] **Step 4: Commit**

```bash
git add scripts/phase0-spike.ts docs/superpowers/specs/2026-09-17-mps-foundation-design.md
git commit -m "chore: add phase 0 discovery spike and findings

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Database package (schema, migrations, test DB, users, app state)

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`, `client.ts`, `users.ts`, `app-state.ts`, `migrate.ts`, `testing.ts`, `index.ts`
- Generated: `packages/db/drizzle/*` (commit it)
- Create: `docker-compose.dev.yml` (local Postgres for running the worker; not needed for tests)
- Test: `packages/db/src/schema.test.ts`, `packages/db/src/users.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (`@mps/db`):
  - Tables: `users`, `vantageCustomers`, `vantageEquipment`, `drmsEquipment`, `drmsCustomers`, `deviceLinks`, `customerLinks`, `linkIssues`, `counterSnapshots`, `counterValues`, `counterNames`, `syncRuns`, `appState`
  - `type Db` (a Drizzle Postgres database with the schema; works for node-postgres and PGlite)
  - `createDb(connectionString: string): { db: Db; pool: pg.Pool }`
  - `excluded(table, keep?: string[]): Record<string, SQL>` (the SET map for upserts)
  - `hashPassword(p: string): Promise<string>`, `verifyPassword(hash: string, p: string): Promise<boolean>`, `ensureAdminUser(db: Db, username: string, password: string): Promise<boolean>`
  - `getAppState<T>(db: Db, key: string): Promise<T | null>`, `setAppState(db: Db, key: string, value: unknown): Promise<void>`
- Produces (`@mps/db/migrate`): `runMigrations(db: Db): Promise<void>`, `migrationsFolder: string`
- Produces (`@mps/db/testing`): `createTestDb(): Promise<TestDb>`, `interface TestDb { db: Db; close(): Promise<void> }`

- [ ] **Step 1: Package files + install**

`packages/db/package.json`:
```json
{
  "name": "@mps/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./migrate": "./src/migrate.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "generate": "drizzle-kit generate"
  }
}
```
`packages/db/tsconfig.json`: same as core.

Run: `npm i -w @mps/db drizzle-orm@^0.44 pg@^8 @node-rs/argon2@^2 && npm i -D -w @mps/db drizzle-kit@^0.31 @types/pg@^8 @electric-sql/pglite@^0.3`
Expected: installs cleanly.

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
```

`docker-compose.dev.yml`:
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: mps
      POSTGRES_PASSWORD: mps
      POSTGRES_DB: mps
    ports: ['5432:5432']
    volumes: ['pgdata-dev:/var/lib/postgresql/data']
volumes:
  pgdata-dev:
```

- [ ] **Step 2: Schema**

`packages/db/src/schema.ts`:
```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'operator'] }).notNull().default('operator'),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const vantageCustomers = pgTable('vantage_customers', {
  vantageId: integer('vantage_id').primaryKey(),
  reference: text('reference'),
  name: text('name'),
  isActive: boolean('is_active'),
  isOnStop: boolean('is_on_stop'),
  modifiedDate: ts('modified_date'),
  deletedDate: ts('deleted_date'),
  raw: jsonb('raw').notNull(),
  syncedAt: ts('synced_at').notNull().defaultNow(),
});

export const vantageEquipment = pgTable(
  'vantage_equipment',
  {
    vantageId: integer('vantage_id').primaryKey(),
    serial: text('serial'),
    serialNorm: text('serial_norm'),
    assetNumber: text('asset_number'),
    description: text('description'),
    itemPartNumber: text('item_part_number'),
    vantageCustomerId: integer('vantage_customer_id'),
    customerReference: text('customer_reference'),
    customerName: text('customer_name'),
    location: text('location'),
    installDate: ts('install_date'),
    modifiedDate: ts('modified_date'),
    deletedDate: ts('deleted_date'),
    raw: jsonb('raw').notNull(),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    index('vantage_equipment_serial_norm_idx').on(t.serialNorm),
    index('vantage_equipment_customer_idx').on(t.vantageCustomerId),
  ],
);

export const drmsEquipment = pgTable(
  'drms_equipment',
  {
    drmsId: text('drms_id').primaryKey(),
    erpId: text('erp_id'),
    serial: text('serial'),
    serialNorm: text('serial_norm'),
    modelName: text('model_name'),
    productName: text('product_name'),
    status: text('status'),
    communicationType: text('communication_type'),
    customerErpId: text('customer_erp_id'),
    customerName: text('customer_name'),
    customerCsrcId: text('customer_csrc_id'),
    registrationTime: ts('registration_time'),
    initialConnectionTime: ts('initial_connection_time'),
    lastCounterReceivedTime: ts('last_counter_received_time'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    missingSince: ts('missing_since'),
    lastSnapshotFetchAt: ts('last_snapshot_fetch_at'),
    raw: jsonb('raw').notNull(),
    syncedAt: ts('synced_at').notNull().defaultNow(),
  },
  (t) => [
    index('drms_equipment_serial_norm_idx').on(t.serialNorm),
    index('drms_equipment_erp_id_idx').on(t.erpId),
  ],
);

export const drmsCustomers = pgTable('drms_customers', {
  drmsId: text('drms_id').primaryKey(),
  erpId: text('erp_id'),
  name: text('name'),
  csrcIds: text('csrc_ids').array(),
  raw: jsonb('raw').notNull(),
  syncedAt: ts('synced_at').notNull().defaultNow(),
});

export const deviceLinks = pgTable(
  'device_links',
  {
    id: serial('id').primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    vantageEquipmentId: integer('vantage_equipment_id')
      .notNull()
      .references(() => vantageEquipment.vantageId),
    method: text('method', { enum: ['erp_id', 'serial', 'manual'] }).notNull(),
    linkedBy: integer('linked_by').references(() => users.id),
    linkedAt: ts('linked_at').notNull().defaultNow(),
    unlinkedAt: ts('unlinked_at'),
    unlinkedReason: text('unlinked_reason'),
  },
  (t) => [
    uniqueIndex('device_links_active_drms_uq').on(t.drmsEquipmentId).where(sql`unlinked_at is null`),
    uniqueIndex('device_links_active_vantage_uq')
      .on(t.vantageEquipmentId)
      .where(sql`unlinked_at is null`),
  ],
);

export const customerLinks = pgTable('customer_links', {
  id: serial('id').primaryKey(),
  customerErpId: text('customer_erp_id').notNull().unique(),
  vantageCustomerId: integer('vantage_customer_id').notNull(),
  method: text('method', { enum: ['derived', 'manual'] }).notNull(),
  deviceCount: integer('device_count').notNull().default(0),
  linkedBy: integer('linked_by').references(() => users.id),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const linkIssues = pgTable(
  'link_issues',
  {
    id: serial('id').primaryKey(),
    issueKey: text('issue_key').notNull().unique(),
    type: text('type').notNull(),
    drmsEquipmentId: text('drms_equipment_id'),
    vantageEquipmentId: integer('vantage_equipment_id'),
    details: jsonb('details').notNull().default({}),
    status: text('status', { enum: ['open', 'resolved', 'ignored'] }).notNull().default('open'),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
    resolvedBy: integer('resolved_by').references(() => users.id),
    resolvedAt: ts('resolved_at'),
    note: text('note'),
  },
  (t) => [index('link_issues_status_type_idx').on(t.status, t.type)],
);

export const counterSnapshots = pgTable(
  'counter_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    drmsEquipmentId: text('drms_equipment_id')
      .notNull()
      .references(() => drmsEquipment.drmsId),
    counterId: text('counter_id').notNull(),
    receivedTime: ts('received_time'),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    raw: jsonb('raw').notNull(),
  },
  (t) => [
    uniqueIndex('counter_snapshots_device_counter_uq').on(t.drmsEquipmentId, t.counterId),
    index('counter_snapshots_device_received_idx').on(t.drmsEquipmentId, t.receivedTime),
  ],
);

export const counterValues = pgTable(
  'counter_values',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    snapshotId: bigint('snapshot_id', { mode: 'number' })
      .notNull()
      .references(() => counterSnapshots.id, { onDelete: 'cascade' }),
    itemNumber: text('item_number'),
    name: text('name').notNull(),
    value: doublePrecision('value'),
    colorMode: text('color_mode'),
    mode: text('mode'),
  },
  (t) => [
    index('counter_values_snapshot_idx').on(t.snapshotId),
    index('counter_values_name_idx').on(t.name),
  ],
);

export const counterNames = pgTable('counter_names', {
  name: text('name').primaryKey(),
  firstSeen: ts('first_seen').notNull().defaultNow(),
  sampleValue: doublePrecision('sample_value'),
  category: text('category', { enum: ['meter', 'supply', 'other'] }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: serial('id').primaryKey(),
    job: text('job').notNull(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    status: text('status', { enum: ['running', 'success', 'partial', 'failed'] }).notNull(),
    stats: jsonb('stats').notNull().default({}),
    errorSample: text('error_sample'),
  },
  (t) => [index('sync_runs_job_started_idx').on(t.job, t.startedAt)],
);

export const appState = pgTable('app_state', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
```

- [ ] **Step 3: Generate the migration**

Run: `cd packages/db && npx drizzle-kit generate --name init && cd ../..`
Expected: `packages/db/drizzle/0000_init.sql` and `packages/db/drizzle/meta/` created. Open the SQL and check both partial unique indexes end in `WHERE unlinked_at is null`.

- [ ] **Step 4: Client, migrate, testing, users, app state**

`packages/db/src/client.ts`:
```ts
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export function createDb(connectionString: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { db: db as unknown as Db, pool };
}

/** SET map for onConflictDoUpdate: every column takes the incoming value except `keep`. */
export function excluded(table: PgTable, keep: string[] = []): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (keep.includes(key)) continue;
    set[key] = sql.raw(`excluded."${column.name}"`);
  }
  return set;
}
```

`packages/db/src/migrate.ts`:
```ts
import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';
import type * as schema from './schema';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db as unknown as NodePgDatabase<typeof schema>, { migrationsFolder });
}
```

`packages/db/src/testing.ts`:
```ts
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Db } from './client';
import { migrationsFolder } from './migrate';
import * as schema from './schema';

export interface TestDb {
  db: Db;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
```

`packages/db/src/users.ts`:
```ts
import { hash, verify } from '@node-rs/argon2';
import type { Db } from './client';
import { users } from './schema';

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Creates the first admin only when the users table is empty. Returns true if created. */
export async function ensureAdminUser(db: Db, username: string, password: string): Promise<boolean> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return false;
  await db.insert(users).values({ username, passwordHash: await hashPassword(password), role: 'admin' });
  return true;
}
```

`packages/db/src/app-state.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { appState } from './schema';

export async function getAppState<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select({ value: appState.value }).from(appState).where(eq(appState.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function setAppState(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: new Date() } });
}
```

`packages/db/src/index.ts`:
```ts
export * from './schema';
export * from './client';
export * from './users';
export * from './app-state';
```

- [ ] **Step 5: Write tests**

`packages/db/src/schema.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppState, setAppState } from './app-state';
import { counterSnapshots, deviceLinks, drmsEquipment, linkIssues, vantageEquipment } from './schema';
import { createTestDb, type TestDb } from './testing';

describe('schema', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'd1', raw: {} },
      { drmsId: 'd2', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 10, raw: {} },
      { vantageId: 11, raw: {} },
    ]);
  });
  afterEach(() => t.close());

  it('allows only one active link per DRMS device, but keeps history', async () => {
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial', unlinkedAt: new Date() });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial' });
    await expect(
      t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 11, method: 'serial' }),
    ).rejects.toThrow();
  });

  it('allows only one active link per Vantage equipment', async () => {
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'erp_id' });
    await expect(
      t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd2', vantageEquipmentId: 10, method: 'serial' }),
    ).rejects.toThrow();
  });

  it('dedupes snapshots per device + CounterId', async () => {
    const row = { drmsEquipmentId: 'd1', counterId: 'c-1', raw: {} };
    await t.db.insert(counterSnapshots).values(row);
    const again = await t.db.insert(counterSnapshots).values(row).onConflictDoNothing().returning();
    expect(again).toHaveLength(0);
  });

  it('enforces a unique issue key', async () => {
    const row = { issueKey: 'no_match_drms|d1|', type: 'no_match_drms', drmsEquipmentId: 'd1' };
    await t.db.insert(linkIssues).values(row);
    await expect(t.db.insert(linkIssues).values(row)).rejects.toThrow();
  });

  it('stores and overwrites app state', async () => {
    expect(await getAppState(t.db, 'x')).toBeNull();
    await setAppState(t.db, 'x', { a: 1 });
    await setAppState(t.db, 'x', { a: 2 });
    expect(await getAppState<{ a: number }>(t.db, 'x')).toEqual({ a: 2 });
  });
});
```

`packages/db/src/users.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from './schema';
import { createTestDb, type TestDb } from './testing';
import { ensureAdminUser, hashPassword, verifyPassword } from './users';

describe('users', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).not.toContain('correct');
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('creates the admin only when no users exist', async () => {
    expect(await ensureAdminUser(t.db, 'admin', 'a-long-password')).toBe(true);
    expect(await ensureAdminUser(t.db, 'other', 'a-long-password')).toBe(false);
    const rows = await t.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ username: 'admin', role: 'admin', active: true });
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/db`, then `npm run typecheck`
Expected: PASS. (If a test fails because the migration is missing, rerun Step 3.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): add schema, migrations, test db, users and app state

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Linking rules (pure)

**Files:**
- Create: `packages/core/src/linking.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './linking';`)
- Test: `packages/core/src/linking.test.ts`

**Interfaces:**
- Consumes: `normaliseKey` (Task 1)
- Produces (`@mps/core`):
```ts
type LinkMethod = 'erp_id' | 'serial' | 'manual';
type IssueType = 'no_match_drms' | 'no_match_vantage' | 'serial_ambiguous' | 'erp_serial_disagree'
  | 'customer_mismatch' | 'link_broken' | 'duplicate_target';
interface DrmsDeviceInput { drmsId: string; erpId: string | null; serialNorm: string | null; status: string | null; customerErpId: string | null; missing: boolean }
interface VantageDeviceInput { vantageId: number; assetNumber: string | null; serialNorm: string | null; customerId: number | null; customerReference: string | null; deleted: boolean }
interface ActiveLink { drmsId: string; vantageId: number; method: LinkMethod }
interface LinkConfig { erpIdField: 'id' | 'assetNumber'; customerErpField: 'id' | 'reference' | 'none' }
interface PlannedIssue { type: IssueType; drmsId: string | null; vantageId: number | null; details: Record<string, unknown> }
interface LinkPlan { links: ActiveLink[]; issues: PlannedIssue[] }
function computeLinks(drms: DrmsDeviceInput[], vantage: VantageDeviceInput[], existing: ActiveLink[], config: LinkConfig): LinkPlan
function diffLinks<E extends ActiveLink>(existing: E[], desired: ActiveLink[]): { toCreate: ActiveLink[]; toClose: E[] }
function issueKey(issue: { type: IssueType | string; drmsId: string | null; vantageId: number | null }): string
```

Rules, in order, for each DRMS device:
1. The device is missing, or its status isn't Registered/PreRegistered/Discovered (case-insensitive): no link. If it had an active link → `link_broken` (`details.reason` = `drms_missing` or `drms_status`).
2. The existing link is `manual`: keep it if the Vantage target exists and isn't deleted; else `link_broken` (`reason: vantage_deleted`).
3. ERP key (`normaliseKey(erpId)`) matches exactly one active Vantage record on `config.erpIdField` → candidate `erp_id`. If exactly one serial match points at a different record → `erp_serial_disagree` (`details.serialVantageId`).
4. Else exactly one active Vantage record has the same `serialNorm` → candidate `serial`. 2+ matches → `serial_ambiguous` (`details.vantageIds` sorted ascending).
5. Else (any linkable status, including Discovered — most of the fleet is Discovered) → `no_match_drms`.
6. The device had an auto link, and its target is now deleted or gone → `link_broken` (`reason: vantage_deleted`).
Then candidates are sorted manual → erp_id → serial, then by drmsId. The first to claim a Vantage record wins, and later claims get `duplicate_target` (`details.linkedDrmsId`). For each final link, unless `customerErpField` is `none`, if both customer keys are non-empty and differ (`customerErpField` `id` → `customerId`, `reference` → `customerReference`, compared with `normaliseKey`) → `customer_mismatch`. (`none` is the default: Phase 0 showed DRMS `CustomerErpId` is a DRMS-side `CUST######` code matching no Vantage field.) Every active Vantage record without a link → `no_match_vantage`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/linking.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  computeLinks,
  diffLinks,
  issueKey,
  type ActiveLink,
  type DrmsDeviceInput,
  type LinkConfig,
  type LinkPlan,
  type VantageDeviceInput,
} from './linking';

const cfg: LinkConfig = { erpIdField: 'id', customerErpField: 'reference' };
const d = (o: Partial<DrmsDeviceInput> & { drmsId: string }): DrmsDeviceInput => ({
  erpId: null,
  serialNorm: null,
  status: 'Registered',
  customerErpId: null,
  missing: false,
  ...o,
});
const v = (o: Partial<VantageDeviceInput> & { vantageId: number }): VantageDeviceInput => ({
  assetNumber: null,
  serialNorm: null,
  customerId: null,
  customerReference: null,
  deleted: false,
  ...o,
});
const ofType = (plan: LinkPlan, type: string) => plan.issues.filter((i) => i.type === type);

describe('computeLinks', () => {
  it('links by ERP id against Vantage Id', () => {
    const plan = computeLinks([d({ drmsId: 'd1', erpId: '10' })], [v({ vantageId: 10 })], [], cfg);
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'erp_id' }]);
    expect(plan.issues).toEqual([]);
  });

  it('links by ERP id against AssetNumber when configured', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: 'eq-500' })],
      [v({ vantageId: 10, assetNumber: 'EQ-500' })],
      [],
      { ...cfg, erpIdField: 'assetNumber' },
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'erp_id' }]);
  });

  it('links by serial when there is no ERP id match', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: 'unknown', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'serial' }]);
  });

  it('flags ambiguous serials without linking', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', serialNorm: 'A1' })],
      [v({ vantageId: 11, serialNorm: 'A1' }), v({ vantageId: 10, serialNorm: 'A1' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(ofType(plan, 'serial_ambiguous')).toEqual([
      { type: 'serial_ambiguous', drmsId: 'd1', vantageId: null, details: { vantageIds: [10, 11] } },
    ]);
    expect(ofType(plan, 'no_match_vantage')).toHaveLength(2);
  });

  it('keeps the ERP link and flags when serial disagrees', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', serialNorm: 'B2' })],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 11, serialNorm: 'B2' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'erp_id' }]);
    expect(ofType(plan, 'erp_serial_disagree')).toEqual([
      { type: 'erp_serial_disagree', drmsId: 'd1', vantageId: 10, details: { serialVantageId: 11 } },
    ]);
  });

  it('raises no_match_drms for Registered, PreRegistered and Discovered', () => {
    const plan = computeLinks(
      [
        d({ drmsId: 'd1', status: 'Registered', serialNorm: 'X' }),
        d({ drmsId: 'd2', status: 'PreRegistered' }),
        d({ drmsId: 'd3', status: 'Discovered' }),
      ],
      [],
      [],
      cfg,
    );
    expect(ofType(plan, 'no_match_drms').map((i) => i.drmsId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('never overwrites a manual link', () => {
    const existing: ActiveLink[] = [{ drmsId: 'd1', vantageId: 20, method: 'manual' }];
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 20 })],
      existing,
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 20, method: 'manual' }]);
    expect(ofType(plan, 'no_match_vantage').map((i) => i.vantageId)).toEqual([10]);
  });

  it('breaks a manual link whose Vantage target was deleted', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1' })],
      [v({ vantageId: 20, deleted: true })],
      [{ drmsId: 'd1', vantageId: 20, method: 'manual' }],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(ofType(plan, 'link_broken')).toEqual([
      { type: 'link_broken', drmsId: 'd1', vantageId: 20, details: { reason: 'vantage_deleted' } },
    ]);
  });

  it('breaks links for missing or deleted DRMS devices', () => {
    const plan = computeLinks(
      [
        d({ drmsId: 'd1', missing: true, serialNorm: 'A1' }),
        d({ drmsId: 'd2', status: 'Deleted', serialNorm: 'B2' }),
      ],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 11, serialNorm: 'B2' })],
      [
        { drmsId: 'd1', vantageId: 10, method: 'serial' },
        { drmsId: 'd2', vantageId: 11, method: 'erp_id' },
      ],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(ofType(plan, 'link_broken')).toEqual([
      { type: 'link_broken', drmsId: 'd1', vantageId: 10, details: { reason: 'drms_missing', status: 'Registered' } },
      { type: 'link_broken', drmsId: 'd2', vantageId: 11, details: { reason: 'drms_status', status: 'Deleted' } },
    ]);
  });

  it('breaks an auto link whose Vantage target was deleted', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1', deleted: true })],
      [{ drmsId: 'd1', vantageId: 10, method: 'serial' }],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(plan.issues).toContainEqual({
      type: 'link_broken',
      drmsId: 'd1',
      vantageId: 10,
      details: { reason: 'vantage_deleted' },
    });
    expect(ofType(plan, 'no_match_vantage')).toEqual([]);
  });

  it('gives a contested Vantage record to ERP over serial, then lowest drmsId', () => {
    const plan = computeLinks(
      [
        d({ drmsId: 'a-serial', serialNorm: 'A1' }),
        d({ drmsId: 'z-erp', erpId: '10' }),
        d({ drmsId: 'b-serial', serialNorm: 'B2' }),
        d({ drmsId: 'c-serial', serialNorm: 'B2' }),
      ],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 11, serialNorm: 'B2' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([
      { drmsId: 'z-erp', vantageId: 10, method: 'erp_id' },
      { drmsId: 'b-serial', vantageId: 11, method: 'serial' },
    ]);
    expect(ofType(plan, 'duplicate_target')).toEqual([
      { type: 'duplicate_target', drmsId: 'a-serial', vantageId: 10, details: { linkedDrmsId: 'z-erp', method: 'serial' } },
      { type: 'duplicate_target', drmsId: 'c-serial', vantageId: 11, details: { linkedDrmsId: 'b-serial', method: 'serial' } },
    ]);
  });

  it('flags customer mismatch by reference, by id, and not when a side is empty', () => {
    const drms = [
      d({ drmsId: 'd1', erpId: '10', customerErpId: 'cust1' }),
      d({ drmsId: 'd2', erpId: '11', customerErpId: 'CUST9' }),
      d({ drmsId: 'd3', erpId: '12', customerErpId: null }),
    ];
    const vantage = [
      v({ vantageId: 10, customerId: 1, customerReference: 'CUST1' }),
      v({ vantageId: 11, customerId: 2, customerReference: 'CUST2' }),
      v({ vantageId: 12, customerId: 3, customerReference: 'CUST3' }),
    ];
    const byRef = computeLinks(drms, vantage, [], cfg);
    expect(ofType(byRef, 'customer_mismatch')).toEqual([
      {
        type: 'customer_mismatch',
        drmsId: 'd2',
        vantageId: 11,
        details: { drmsCustomerErpId: 'CUST9', vantageCustomerId: 2, vantageCustomerReference: 'CUST2' },
      },
    ]);
    const byId = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', customerErpId: '1' })],
      vantage,
      [],
      { ...cfg, customerErpField: 'id' },
    );
    expect(ofType(byId, 'customer_mismatch')).toEqual([]);
    const disabled = computeLinks(drms, vantage, [], { ...cfg, customerErpField: 'none' });
    expect(ofType(disabled, 'customer_mismatch')).toEqual([]);
  });

  it('does not match deleted Vantage records or report them as unmatched', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1', deleted: true })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(plan.issues.map((i) => i.type)).toEqual(['no_match_drms']);
  });
});

describe('diffLinks', () => {
  it('keeps identical links, closes changed ones, creates new ones', () => {
    const existing = [
      { id: 1, drmsId: 'd1', vantageId: 10, method: 'serial' as const },
      { id: 2, drmsId: 'd2', vantageId: 11, method: 'serial' as const },
      { id: 3, drmsId: 'd3', vantageId: 12, method: 'serial' as const },
    ];
    const desired: ActiveLink[] = [
      { drmsId: 'd1', vantageId: 10, method: 'serial' },
      { drmsId: 'd2', vantageId: 11, method: 'erp_id' },
      { drmsId: 'd4', vantageId: 13, method: 'serial' },
    ];
    const diff = diffLinks(existing, desired);
    expect(diff.toClose.map((l) => l.id)).toEqual([2, 3]);
    expect(diff.toCreate).toEqual([
      { drmsId: 'd2', vantageId: 11, method: 'erp_id' },
      { drmsId: 'd4', vantageId: 13, method: 'serial' },
    ]);
  });
});

describe('issueKey', () => {
  it('builds a stable key with empty parts for nulls', () => {
    expect(issueKey({ type: 'no_match_drms', drmsId: 'd1', vantageId: null })).toBe('no_match_drms|d1|');
    expect(issueKey({ type: 'no_match_vantage', drmsId: null, vantageId: 7 })).toBe('no_match_vantage||7');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/src/linking.test.ts`
Expected: FAIL, "Failed to resolve import './linking'".

- [ ] **Step 3: Implement**

`packages/core/src/linking.ts`:
```ts
import { normaliseKey } from './fields';

export type LinkMethod = 'erp_id' | 'serial' | 'manual';
export type IssueType =
  | 'no_match_drms'
  | 'no_match_vantage'
  | 'serial_ambiguous'
  | 'erp_serial_disagree'
  | 'customer_mismatch'
  | 'link_broken'
  | 'duplicate_target';

export interface DrmsDeviceInput {
  drmsId: string;
  erpId: string | null;
  serialNorm: string | null;
  status: string | null;
  customerErpId: string | null;
  missing: boolean;
}

export interface VantageDeviceInput {
  vantageId: number;
  assetNumber: string | null;
  serialNorm: string | null;
  customerId: number | null;
  customerReference: string | null;
  deleted: boolean;
}

export interface ActiveLink {
  drmsId: string;
  vantageId: number;
  method: LinkMethod;
}

export interface LinkConfig {
  erpIdField: 'id' | 'assetNumber';
  /** 'none' disables customer_mismatch checks. */
  customerErpField: 'id' | 'reference' | 'none';
}

export interface PlannedIssue {
  type: IssueType;
  drmsId: string | null;
  vantageId: number | null;
  details: Record<string, unknown>;
}

export interface LinkPlan {
  links: ActiveLink[];
  issues: PlannedIssue[];
}

const LINKABLE_STATUSES = new Set(['REGISTERED', 'PREREGISTERED', 'DISCOVERED']);
const METHOD_RANK: Record<LinkMethod, number> = { manual: 0, erp_id: 1, serial: 2 };

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function computeLinks(
  drms: DrmsDeviceInput[],
  vantage: VantageDeviceInput[],
  existing: ActiveLink[],
  config: LinkConfig,
): LinkPlan {
  const issues: PlannedIssue[] = [];
  const vantageById = new Map(vantage.map((x) => [x.vantageId, x]));
  const activeVantage = vantage.filter((x) => !x.deleted);
  const byErpKey = new Map<string, VantageDeviceInput[]>();
  const bySerial = new Map<string, VantageDeviceInput[]>();
  for (const x of activeVantage) {
    const key = normaliseKey(config.erpIdField === 'id' ? x.vantageId : x.assetNumber);
    if (key) addTo(byErpKey, key, x);
    if (x.serialNorm) addTo(bySerial, x.serialNorm, x);
  }
  const existingByDrms = new Map(existing.map((l) => [l.drmsId, l]));
  const candidates: ActiveLink[] = [];

  for (const device of drms) {
    const current = existingByDrms.get(device.drmsId);
    const status = (device.status ?? '').toUpperCase();

    if (device.missing || !LINKABLE_STATUSES.has(status)) {
      if (current) {
        issues.push({
          type: 'link_broken',
          drmsId: device.drmsId,
          vantageId: current.vantageId,
          details: { reason: device.missing ? 'drms_missing' : 'drms_status', status: device.status },
        });
      }
      continue;
    }

    if (current?.method === 'manual') {
      const target = vantageById.get(current.vantageId);
      if (target && !target.deleted) candidates.push(current);
      else
        issues.push({
          type: 'link_broken',
          drmsId: device.drmsId,
          vantageId: current.vantageId,
          details: { reason: 'vantage_deleted' },
        });
      continue;
    }

    const erpKey = normaliseKey(device.erpId);
    const erpMatches = erpKey ? (byErpKey.get(erpKey) ?? []) : [];
    const serialMatches = device.serialNorm ? (bySerial.get(device.serialNorm) ?? []) : [];
    // Ambiguous ERP key (duplicate AssetNumbers) falls through to serial matching.
    const erpMatch = erpMatches.length === 1 ? erpMatches[0] : undefined;

    if (erpMatch) {
      candidates.push({ drmsId: device.drmsId, vantageId: erpMatch.vantageId, method: 'erp_id' });
      const serialMatch = serialMatches.length === 1 ? serialMatches[0] : undefined;
      if (serialMatch && serialMatch.vantageId !== erpMatch.vantageId) {
        issues.push({
          type: 'erp_serial_disagree',
          drmsId: device.drmsId,
          vantageId: erpMatch.vantageId,
          details: { serialVantageId: serialMatch.vantageId },
        });
      }
    } else if (serialMatches.length === 1) {
      candidates.push({
        drmsId: device.drmsId,
        vantageId: (serialMatches[0] as VantageDeviceInput).vantageId,
        method: 'serial',
      });
    } else if (serialMatches.length > 1) {
      issues.push({
        type: 'serial_ambiguous',
        drmsId: device.drmsId,
        vantageId: null,
        details: { vantageIds: serialMatches.map((x) => x.vantageId).sort((a, b) => a - b) },
      });
    } else {
      issues.push({
        type: 'no_match_drms',
        drmsId: device.drmsId,
        vantageId: null,
        details: { erpId: device.erpId, serialNorm: device.serialNorm },
      });
    }

    if (current) {
      const target = vantageById.get(current.vantageId);
      if (!target || target.deleted) {
        issues.push({
          type: 'link_broken',
          drmsId: device.drmsId,
          vantageId: current.vantageId,
          details: { reason: 'vantage_deleted' },
        });
      }
    }
  }

  candidates.sort(
    (a, b) => METHOD_RANK[a.method] - METHOD_RANK[b.method] || a.drmsId.localeCompare(b.drmsId),
  );
  const holderByVantage = new Map<number, string>();
  const links: ActiveLink[] = [];
  for (const c of candidates) {
    const holder = holderByVantage.get(c.vantageId);
    if (holder !== undefined) {
      issues.push({
        type: 'duplicate_target',
        drmsId: c.drmsId,
        vantageId: c.vantageId,
        details: { linkedDrmsId: holder, method: c.method },
      });
      continue;
    }
    holderByVantage.set(c.vantageId, c.drmsId);
    links.push({ drmsId: c.drmsId, vantageId: c.vantageId, method: c.method });
  }

  const drmsById = new Map(drms.map((x) => [x.drmsId, x]));
  for (const link of config.customerErpField === 'none' ? [] : links) {
    const device = drmsById.get(link.drmsId) as DrmsDeviceInput;
    const target = vantageById.get(link.vantageId) as VantageDeviceInput;
    const drmsCustomer = normaliseKey(device.customerErpId);
    const vantageCustomer = normaliseKey(
      config.customerErpField === 'id' ? target.customerId : target.customerReference,
    );
    if (drmsCustomer && vantageCustomer && drmsCustomer !== vantageCustomer) {
      issues.push({
        type: 'customer_mismatch',
        drmsId: link.drmsId,
        vantageId: link.vantageId,
        details: {
          drmsCustomerErpId: device.customerErpId,
          vantageCustomerId: target.customerId,
          vantageCustomerReference: target.customerReference,
        },
      });
    }
  }

  for (const x of activeVantage) {
    if (!holderByVantage.has(x.vantageId)) {
      issues.push({
        type: 'no_match_vantage',
        drmsId: null,
        vantageId: x.vantageId,
        details: { serialNorm: x.serialNorm },
      });
    }
  }

  return { links, issues };
}

const linkId = (l: ActiveLink) => `${l.drmsId}|${l.vantageId}|${l.method}`;

export function diffLinks<E extends ActiveLink>(
  existing: E[],
  desired: ActiveLink[],
): { toCreate: ActiveLink[]; toClose: E[] } {
  const desiredIds = new Set(desired.map(linkId));
  const existingIds = new Set(existing.map(linkId));
  return {
    toClose: existing.filter((l) => !desiredIds.has(linkId(l))),
    toCreate: desired.filter((l) => !existingIds.has(linkId(l))),
  };
}

export function issueKey(issue: {
  type: string;
  drmsId: string | null;
  vantageId: number | null;
}): string {
  return `${issue.type}|${issue.drmsId ?? ''}|${issue.vantageId ?? ''}`;
}
```

Add `export * from './linking';` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/core`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add DRMS to Vantage linking rules

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Issue reconciliation + derived customer links (pure)

**Files:**
- Create: `packages/core/src/issues.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './issues';`)
- Test: `packages/core/src/issues.test.ts`

**Interfaces:**
- Consumes: `PlannedIssue`, `ActiveLink`, `DrmsDeviceInput`, `VantageDeviceInput`, `issueKey` (Task 4)
- Produces:
```ts
interface StoredIssue { id: number; key: string; status: 'open' | 'resolved' | 'ignored' }
interface IssueChanges { toInsert: PlannedIssue[]; toReopen: { id: number; issue: PlannedIssue }[]; toTouch: number[]; toResolve: number[] }
function reconcileIssues(stored: StoredIssue[], planned: PlannedIssue[]): IssueChanges
interface DerivedCustomerLink { customerErpId: string; vantageCustomerId: number; deviceCount: number }
function deriveCustomerLinks(links: ActiveLink[], drms: DrmsDeviceInput[], vantage: VantageDeviceInput[]): DerivedCustomerLink[]
```
Rules:
- Planned issues are deduped by key (the first one wins).
- Planned, not stored → insert. Stored `open` or `ignored` → touch (lastSeen only; ignored stays ignored). Stored `resolved` → reopen.
- Stored `open` issues not planned → resolve.
- Customer links: group the linked devices by trimmed DRMS `customerErpId` (skip empty ones and devices whose Vantage record has no `customerId`). Pick the Vantage customer with the most devices, breaking ties by the lowest id. Output is sorted by `customerErpId`.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/issues.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { deriveCustomerLinks, reconcileIssues, type StoredIssue } from './issues';
import type { DrmsDeviceInput, PlannedIssue, VantageDeviceInput } from './linking';

const issue = (type: PlannedIssue['type'], drmsId: string | null, vantageId: number | null): PlannedIssue => ({
  type,
  drmsId,
  vantageId,
  details: {},
});

describe('reconcileIssues', () => {
  it('inserts new, touches open/ignored, reopens resolved, resolves vanished', () => {
    const stored: StoredIssue[] = [
      { id: 1, key: 'no_match_drms|d1|', status: 'open' },
      { id: 2, key: 'no_match_drms|d2|', status: 'ignored' },
      { id: 3, key: 'no_match_drms|d3|', status: 'resolved' },
      { id: 4, key: 'no_match_drms|d4|', status: 'open' },
      { id: 5, key: 'no_match_drms|d5|', status: 'ignored' },
    ];
    const planned = [
      issue('no_match_drms', 'd1', null),
      issue('no_match_drms', 'd2', null),
      issue('no_match_drms', 'd3', null),
      issue('no_match_drms', 'd9', null),
      issue('no_match_drms', 'd9', null),
    ];
    const changes = reconcileIssues(stored, planned);
    expect(changes.toInsert).toEqual([issue('no_match_drms', 'd9', null)]);
    expect(changes.toTouch).toEqual([1, 2]);
    expect(changes.toReopen).toEqual([{ id: 3, issue: issue('no_match_drms', 'd3', null) }]);
    expect(changes.toResolve).toEqual([4]);
  });
});

describe('deriveCustomerLinks', () => {
  const drms = (drmsId: string, customerErpId: string | null): DrmsDeviceInput => ({
    drmsId,
    customerErpId,
    erpId: null,
    serialNorm: null,
    status: 'Registered',
    missing: false,
  });
  const vantage = (vantageId: number, customerId: number | null): VantageDeviceInput => ({
    vantageId,
    customerId,
    assetNumber: null,
    serialNorm: null,
    customerReference: null,
    deleted: false,
  });

  it('picks the most common Vantage customer per DRMS customer ERP id', () => {
    const result = deriveCustomerLinks(
      [
        { drmsId: 'a', vantageId: 1, method: 'serial' },
        { drmsId: 'b', vantageId: 2, method: 'serial' },
        { drmsId: 'c', vantageId: 3, method: 'erp_id' },
        { drmsId: 'd', vantageId: 4, method: 'serial' },
        { drmsId: 'e', vantageId: 5, method: 'serial' },
        { drmsId: 'f', vantageId: 6, method: 'serial' },
      ],
      [drms('a', ' C1 '), drms('b', 'C1'), drms('c', 'C1'), drms('d', 'C2'), drms('e', 'C2'), drms('f', '')],
      [vantage(1, 100), vantage(2, 100), vantage(3, 200), vantage(4, 300), vantage(5, 250), vantage(6, 999)],
    );
    expect(result).toEqual([
      { customerErpId: 'C1', vantageCustomerId: 100, deviceCount: 2 },
      { customerErpId: 'C2', vantageCustomerId: 250, deviceCount: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/src/issues.test.ts`
Expected: FAIL, "Failed to resolve import './issues'".

- [ ] **Step 3: Implement**

`packages/core/src/issues.ts`:
```ts
import {
  issueKey,
  type ActiveLink,
  type DrmsDeviceInput,
  type PlannedIssue,
  type VantageDeviceInput,
} from './linking';

export interface StoredIssue {
  id: number;
  key: string;
  status: 'open' | 'resolved' | 'ignored';
}

export interface IssueChanges {
  toInsert: PlannedIssue[];
  toReopen: { id: number; issue: PlannedIssue }[];
  toTouch: number[];
  toResolve: number[];
}

export function reconcileIssues(stored: StoredIssue[], planned: PlannedIssue[]): IssueChanges {
  const storedByKey = new Map(stored.map((s) => [s.key, s]));
  const plannedByKey = new Map<string, PlannedIssue>();
  for (const p of planned) {
    const key = issueKey(p);
    if (!plannedByKey.has(key)) plannedByKey.set(key, p);
  }
  const changes: IssueChanges = { toInsert: [], toReopen: [], toTouch: [], toResolve: [] };
  for (const [key, p] of plannedByKey) {
    const s = storedByKey.get(key);
    if (!s) changes.toInsert.push(p);
    else if (s.status === 'resolved') changes.toReopen.push({ id: s.id, issue: p });
    else changes.toTouch.push(s.id);
  }
  for (const s of stored) {
    if (s.status === 'open' && !plannedByKey.has(s.key)) changes.toResolve.push(s.id);
  }
  return changes;
}

export interface DerivedCustomerLink {
  customerErpId: string;
  vantageCustomerId: number;
  deviceCount: number;
}

export function deriveCustomerLinks(
  links: ActiveLink[],
  drms: DrmsDeviceInput[],
  vantage: VantageDeviceInput[],
): DerivedCustomerLink[] {
  const drmsById = new Map(drms.map((d) => [d.drmsId, d]));
  const vantageById = new Map(vantage.map((v) => [v.vantageId, v]));
  const counts = new Map<string, Map<number, number>>();
  for (const link of links) {
    const erp = drmsById.get(link.drmsId)?.customerErpId?.trim();
    const customerId = vantageById.get(link.vantageId)?.customerId;
    if (!erp || customerId == null) continue;
    const perCustomer = counts.get(erp) ?? new Map<number, number>();
    perCustomer.set(customerId, (perCustomer.get(customerId) ?? 0) + 1);
    counts.set(erp, perCustomer);
  }
  const result: DerivedCustomerLink[] = [];
  for (const [customerErpId, perCustomer] of counts) {
    let best: { id: number; n: number } | null = null;
    for (const [id, n] of perCustomer) {
      if (!best || n > best.n || (n === best.n && id < best.id)) best = { id, n };
    }
    if (best) result.push({ customerErpId, vantageCustomerId: best.id, deviceCount: best.n });
  }
  return result.sort((a, b) => a.customerErpId.localeCompare(b.customerErpId));
}
```

Add `export * from './issues';` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/core`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add issue reconciliation and derived customer links

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: DRMS3 client

**Files:**
- Create: `packages/drms/package.json`, `packages/drms/tsconfig.json`
- Create: `packages/drms/src/limiter.ts`, `jwt.ts`, `schemas.ts`, `client.ts`, `index.ts`
- Test: `packages/drms/src/limiter.test.ts`, `jwt.test.ts`, `client.test.ts`

**Interfaces:**
- Consumes: `AuthError`, `HttpError`, `ParseError`, `RateLimitError` (Task 1)
- Produces (`@mps/drms`):
```ts
interface Clock { now(): number; sleep(ms: number): Promise<void> }
const realClock: Clock
class MethodLimiter { constructor(perMinute: number, cooldownMs: number, clock?: Clock); acquire(method: string): Promise<void>; tripCooldown(method: string): Date }
function decodeJwtExpiry(token: string): Date | null
type DrmsEquipment  // zod-inferred: Id: string; ErpId, SerialNumber, ModelName, ProductName, ManufacturerName, Status, CommunicationType, CustomerErpId, CustomerName, CustomerCsrcId, RegistrationTime, InitialConnectionTime, LastCounterReceivedTime: string | null | undefined; plus unknown extra keys
type DrmsCustomer   // Id: string; Name, ErpId: string | null | undefined; CsrcIds: string[] | null | undefined
type DrmsCounter    // ItemNumber: string | number | null | undefined; Name: string; Value: number | string | null | undefined
type DrmsLatestCounters // Id?, CounterId: string, ReceivedTime?, Counters?: DrmsCounter[] | null, ModeSizeCounters?: { ColorMode?, Mode?, Counters?: DrmsCounter[] | null }[] | null
function createDrmsClient(opts: { baseUrl: string; token: string; fetch?: typeof fetch; limiter?: MethodLimiter }): DrmsClient
type DrmsClient = { testAuth(): Promise<string>; listEquipment(): Promise<DrmsEquipment[]>; listCustomers(): Promise<DrmsCustomer[]>; latestCounters(equipmentId: string): Promise<DrmsLatestCounters | null> }
```
Limiter method keys: `Test/Auth`, `Equipment`, `Customer`, `LatestCounters`. Paging starts at `FIRST_PAGE_NO = 1` (confirm in Phase 0; change the constant if the findings say 0). Stop when a page has fewer than 1000 items, **or** when a page adds no new `Id` (a guard against a server that ignores `pageNo`).

- [ ] **Step 1: Package + install**

`packages/drms/package.json`:
```json
{
  "name": "@mps/drms",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "@mps/core": "*" }
}
```
`packages/drms/tsconfig.json`: same as core.
Run: `npm i -w @mps/drms zod@^4`

- [ ] **Step 2: Write the failing tests**

`packages/drms/src/limiter.test.ts`:
```ts
import { RateLimitError } from '@mps/core';
import { describe, expect, it } from 'vitest';
import { MethodLimiter, type Clock } from './limiter';

function fakeClock(): Clock & { t: number; slept: number[] } {
  return {
    t: 0,
    slept: [],
    now() {
      return this.t;
    },
    async sleep(ms: number) {
      this.slept.push(ms);
      this.t += ms;
    },
  };
}

describe('MethodLimiter', () => {
  it('spaces calls per method at 60000/perMinute ms', async () => {
    const clock = fakeClock();
    const limiter = new MethodLimiter(1000, 600_000, clock);
    await limiter.acquire('Equipment');
    await limiter.acquire('Equipment');
    await limiter.acquire('Equipment');
    await limiter.acquire('Customer');
    expect(clock.slept).toEqual([60, 60]);
  });

  it('refuses calls during cooldown, then allows them after', async () => {
    const clock = fakeClock();
    const limiter = new MethodLimiter(1000, 600_000, clock);
    const until = limiter.tripCooldown('LatestCounters');
    expect(until.getTime()).toBe(600_000);
    await expect(limiter.acquire('LatestCounters')).rejects.toBeInstanceOf(RateLimitError);
    await expect(limiter.acquire('Equipment')).resolves.toBeUndefined();
    clock.t = 600_001;
    await expect(limiter.acquire('LatestCounters')).resolves.toBeUndefined();
  });
});
```

`packages/drms/src/jwt.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { decodeJwtExpiry } from './jwt';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('decodeJwtExpiry', () => {
  it('reads exp seconds', () => {
    const token = `${b64({ alg: 'none' })}.${b64({ exp: 1_800_000_000 })}.sig`;
    expect(decodeJwtExpiry(token)?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
  });
  it('returns null without exp or for junk', () => {
    expect(decodeJwtExpiry(`${b64({})}.${b64({ sub: 'x' })}.sig`)).toBeNull();
    expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
  });
});
```

`packages/drms/src/client.test.ts`:
```ts
import { AuthError, HttpError, RateLimitError } from '@mps/core';
import { describe, expect, it } from 'vitest';
import { createDrmsClient } from './client';
import { MethodLimiter, type Clock } from './limiter';

const noWait: Clock = { now: () => 0, sleep: async () => {} };

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (f: typeof fetch) =>
  createDrmsClient({
    baseUrl: 'https://drms.test/api/v8/',
    token: 'tok',
    fetch: f,
    limiter: new MethodLimiter(1000, 600_000, noWait),
  });

const devices = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ Id: `id-${from + i}`, SerialNumber: `S${from + i}`, Status: 'Registered' }));

describe('DRMS client', () => {
  it('sends the bearer token and paginates until a short page', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.searchParams.get('pageNo') === '1' ? json(devices(0, 1000)) : json(devices(1000, 3)),
    );
    const list = await client(fn).listEquipment();
    expect(list).toHaveLength(1003);
    expect(calls.map((c) => c.url.pathname + c.url.search)).toEqual([
      '/api/v8/Equipment?pageNo=1',
      '/api/v8/Equipment?pageNo=2',
    ]);
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('stops when a page repeats already-seen ids', async () => {
    const { fn, calls } = fakeFetch(() => json(devices(0, 1000)));
    const list = await client(fn).listEquipment();
    expect(list).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });

  it('keeps unknown fields on equipment', async () => {
    const { fn } = fakeFetch(() => json([{ Id: 'a', CsrcCenterId: 'GB500' }]));
    const [first] = await client(fn).listEquipment();
    expect(first).toMatchObject({ Id: 'a', CsrcCenterId: 'GB500' });
  });

  it('throws RateLimitError on 429 and blocks the method without calling again', async () => {
    const { fn, calls } = fakeFetch(() => new Response('', { status: 429 }));
    const c = client(fn);
    await expect(c.latestCounters('x')).rejects.toBeInstanceOf(RateLimitError);
    await expect(c.latestCounters('y')).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
  });

  it('maps 401 to AuthError and 500 to HttpError', async () => {
    await expect(client(fakeFetch(() => new Response('', { status: 401 })).fn).listCustomers()).rejects.toBeInstanceOf(AuthError);
    await expect(client(fakeFetch(() => new Response('boom', { status: 500 })).fn).listCustomers()).rejects.toBeInstanceOf(HttpError);
  });

  it('returns null for empty or 404 LatestCounters and parses a sample', async () => {
    expect(await client(fakeFetch(() => new Response('', { status: 200 })).fn).latestCounters('a')).toBeNull();
    expect(await client(fakeFetch(() => new Response('Not Found', { status: 404 })).fn).latestCounters('a')).toBeNull();
    const sample = {
      Id: 'a',
      CounterId: 'c1',
      ReceivedTime: '2026-09-17 02:00:00',
      Counters: [{ ItemNumber: 1, Name: 'BlackTonerLevel', Value: 58 }],
      ModeSizeCounters: [{ ColorMode: 'FullColor', Mode: 'CopyMode', Counters: [{ ItemNumber: '2', Name: 'A4 SEF Full', Value: '12' }] }],
    };
    const { fn, calls } = fakeFetch(() => json(sample));
    expect(await client(fn).latestCounters('a b')).toMatchObject(sample);
    expect(calls[0]?.url.pathname).toBe('/api/v8/Equipment/a%20b/LatestCounters');
  });

  it('testAuth returns the raw text', async () => {
    const { fn } = fakeFetch(() => new Response('"Ok(28.11.2021 14: 48: 30)"'));
    expect(await client(fn).testAuth()).toBe('"Ok(28.11.2021 14: 48: 30)"');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/drms`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`packages/drms/src/limiter.ts`:
```ts
import { RateLimitError } from '@mps/core';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Per-method pacing + cooldown. DRMS counts limits per method; retrying during a block extends it. */
export class MethodLimiter {
  private readonly nextSlot = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly perMinute: number,
    private readonly cooldownMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  async acquire(method: string): Promise<void> {
    const until = this.cooldownUntil.get(method);
    if (until !== undefined && this.clock.now() < until) {
      throw new RateLimitError(`DRMS ${method} is cooling down after a 429`, new Date(until));
    }
    const now = this.clock.now();
    const slot = Math.max(now, this.nextSlot.get(method) ?? 0);
    this.nextSlot.set(method, slot + 60_000 / this.perMinute);
    if (slot > now) await this.clock.sleep(slot - now);
  }

  tripCooldown(method: string): Date {
    const until = this.clock.now() + this.cooldownMs;
    this.cooldownUntil.set(method, until);
    return new Date(until);
  }
}
```

`packages/drms/src/jwt.ts`:
```ts
export function decodeJwtExpiry(token: string): Date | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}
```

`packages/drms/src/schemas.ts`:
```ts
import { z } from 'zod';

const str = z.string().nullish();

export const drmsEquipmentSchema = z.looseObject({
  Id: z.string(),
  Name: str,
  ErpId: str,
  SerialNumber: str,
  ManufacturerName: str,
  ModelName: str,
  ProductName: str,
  Status: str,
  CommunicationType: str,
  CustomerErpId: str,
  CustomerName: str,
  CustomerCsrcId: str,
  RegistrationTime: str,
  InitialConnectionTime: str,
  LastCounterReceivedTime: str,
});

export const drmsCustomerSchema = z.looseObject({
  Id: z.string(),
  Name: str,
  ErpId: str,
  CsrcIds: z.array(z.string()).nullish(),
});

export const drmsCounterSchema = z.looseObject({
  ItemNumber: z.union([z.string(), z.number()]).nullish(),
  Name: z.string(),
  Value: z.union([z.number(), z.string()]).nullish(),
});

export const drmsLatestCountersSchema = z.looseObject({
  Id: str,
  CounterId: z.string(),
  ReceivedTime: str,
  Counters: z.array(drmsCounterSchema).nullish(),
  ModeSizeCounters: z
    .array(z.looseObject({ ColorMode: str, Mode: str, Counters: z.array(drmsCounterSchema).nullish() }))
    .nullish(),
});

export type DrmsEquipment = z.infer<typeof drmsEquipmentSchema>;
export type DrmsCustomer = z.infer<typeof drmsCustomerSchema>;
export type DrmsCounter = z.infer<typeof drmsCounterSchema>;
export type DrmsLatestCounters = z.infer<typeof drmsLatestCountersSchema>;
```

`packages/drms/src/client.ts`:
```ts
import { AuthError, HttpError, ParseError, RateLimitError } from '@mps/core';
import type { z } from 'zod';
import { MethodLimiter } from './limiter';
import {
  drmsCustomerSchema,
  drmsEquipmentSchema,
  drmsLatestCountersSchema,
  type DrmsCustomer,
  type DrmsEquipment,
  type DrmsLatestCounters,
} from './schemas';

export const DRMS_PAGE_SIZE = 1000;
/** Confirmed in Phase 0 findings (spec). */
export const FIRST_PAGE_NO = 1;

export interface DrmsClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  limiter?: MethodLimiter;
}

export function createDrmsClient(opts: DrmsClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const limiter = opts.limiter ?? new MethodLimiter(1000, 10 * 60_000);
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function requestText(
    method: string,
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<string> {
    await limiter.acquire(method);
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
    });
    if (res.status === 429) {
      const until = limiter.tripCooldown(method);
      throw new RateLimitError(`DRMS ${method} returned 429`, until);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`DRMS ${method} auth failed (${res.status})`, res.status);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(`DRMS ${method} failed (${res.status})`, res.status, text.slice(0, 500));
    return text;
  }

  async function requestJson(method: string, path: string, query?: Record<string, string | number>) {
    const text = await requestText(method, path, query);
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ParseError(`DRMS ${method} returned non-JSON`, 200, text.slice(0, 500));
    }
  }

  function parseItem<T>(method: string, schema: z.ZodType<T>, item: unknown): T {
    const result = schema.safeParse(item);
    if (!result.success) {
      throw new ParseError(`DRMS ${method} item failed validation: ${result.error.message}`, 200);
    }
    return result.data;
  }

  async function listPaged<T extends { Id: string }>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    for (let pageNo = FIRST_PAGE_NO; ; pageNo++) {
      const body = await requestJson(method, path, { pageNo });
      if (body === null) return out;
      if (!Array.isArray(body)) throw new ParseError(`DRMS ${method} did not return an array`, 200);
      let added = 0;
      for (const raw of body) {
        const item = parseItem(method, schema, raw);
        if (seen.has(item.Id)) continue;
        seen.add(item.Id);
        out.push(item);
        added++;
      }
      if (body.length < DRMS_PAGE_SIZE || added === 0) return out;
    }
  }

  return {
    testAuth: () => requestText('Test/Auth', 'Test/Auth'),
    listEquipment: (): Promise<DrmsEquipment[]> =>
      listPaged('Equipment', 'Equipment', drmsEquipmentSchema),
    listCustomers: (): Promise<DrmsCustomer[]> =>
      listPaged('Customer', 'Customer', drmsCustomerSchema),
    /** null when DRMS has no counters: empty body, or 404 (Discovered devices return 404 — Phase 0). */
    async latestCounters(equipmentId: string): Promise<DrmsLatestCounters | null> {
      let body: unknown;
      try {
        body = await requestJson(
          'LatestCounters',
          `Equipment/${encodeURIComponent(equipmentId)}/LatestCounters`,
        );
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
      return body === null ? null : parseItem('LatestCounters', drmsLatestCountersSchema, body);
    },
  };
}

export type DrmsClient = ReturnType<typeof createDrmsClient>;
```

`packages/drms/src/index.ts`:
```ts
export * from './client';
export * from './jwt';
export * from './limiter';
export * from './schemas';
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/drms`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(drms): add read-only DRMS3 client with per-method throttle

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Vantage client

**Files:**
- Create: `packages/vantage/package.json`, `packages/vantage/tsconfig.json`
- Create: `packages/vantage/src/client.ts`, `packages/vantage/src/index.ts`
- Test: `packages/vantage/src/client.test.ts`

**Interfaces:**
- Consumes: `AuthError`, `HttpError`, `ParseError`, `getField`, `getNumber`, `getString`, `parseApiDate` (Task 1)
- Produces (`@mps/vantage`):
```ts
interface VantageClientOptions { baseUrl: string; username: string; password: string; apiVersion: string; fetch?: typeof fetch; now?: () => number; pageSize?: number }
interface ListOptions { since?: Date; includeDeleted?: boolean }
type VantageRecord = Record<string, unknown>
function createVantageClient(opts): VantageClient
type VantageClient = {
  odataList(entity: string, o?: { filter?: string[]; expand?: string; includeDeleted?: boolean }): Promise<VantageRecord[]>;
  listCustomers(o?: ListOptions): Promise<VantageRecord[]>;   // entity 'customer'
  listEquipment(o?: ListOptions): Promise<VantageRecord[]>;   // entity 'Equipment', $expand=Item,Customer
}
```
Behaviour:
- Login is `POST {base}/application/loginsingle` with `authorization: Basic …` and `api-version`. The token is read case-insensitively (`Token`) and the expiry from `TokenExpiryDate` (default now + 25 min).
- Reissue (`POST {base}/application/reissue`, Bearer) when less than 5 min is left. If the reissue fails, log in again.
- On a 401 from a GET, log in again once and retry once. A second 401 → `AuthError`.
- Paging uses `$top=pageSize` (default 500), `$skip=<fetched so far>`, `$orderby=Id`, `$count=true`.
  - A response is an array or `{ value, @odata.count }`.
  - Stop on an empty page, or when fetched ≥ count.
  - If there's no count, stop when a page is shorter than `$top`.
  - If a count exists and a page is short, lower `$top` to that page length (the server cap) and continue.
- Filters: prepend `deleteddate eq null` unless `includeDeleted`, add `modifieddate gt <ISO>` for `since`, wrap each in parentheses and join with ` and `.
- Query values are encoded with `encodeURIComponent`, so spaces become `%20`, not `+`.

- [ ] **Step 1: Package + install**

`packages/vantage/package.json`:
```json
{
  "name": "@mps/vantage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" },
  "dependencies": { "@mps/core": "*" }
}
```
`packages/vantage/tsconfig.json`: same as core. (No extra deps.)

- [ ] **Step 2: Write the failing tests**

`packages/vantage/src/client.test.ts`:
```ts
import { AuthError } from '@mps/core';
import { describe, expect, it } from 'vitest';
import { createVantageClient } from './client';

type Handler = (req: { url: URL; method: string; headers: Record<string, string> }) => Response;

function fakeFetch(handler: Handler) {
  const calls: { url: URL; method: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const session = (token: string, expiry: string) => json({ Token: token, TokenExpiryDate: expiry });
const T0 = Date.parse('2026-09-17T10:00:00Z');

function make(handler: Handler, now = () => T0, pageSize = 2) {
  const f = fakeFetch(handler);
  const client = createVantageClient({
    baseUrl: 'https://api.vantage.test/',
    username: 'u',
    password: 'p',
    apiVersion: '1.22',
    fetch: f.fn,
    now,
    pageSize,
  });
  return { client, calls: f.calls };
}

describe('Vantage client', () => {
  it('logs in with Basic auth, then GETs with Bearer and api-version', async () => {
    const { client, calls } = make(({ url }) =>
      url.pathname === '/application/loginsingle'
        ? session('t1', '2026-09-17T10:30:00Z')
        : json({ value: [{ Id: 1 }] }),
    );
    expect(await client.listCustomers()).toEqual([{ Id: 1 }]);
    const [login, get] = calls;
    expect(login?.method).toBe('POST');
    expect(login?.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(login?.headers['api-version']).toBe('1.22');
    expect(get?.url.pathname).toBe('/customer');
    expect(get?.headers.authorization).toBe('Bearer t1');
    expect(get?.headers['api-version']).toBe('1.22');
  });

  it('builds filters with the deleted guard and since, encoded with %20', async () => {
    const { client, calls } = make(({ url }) =>
      url.pathname.startsWith('/application') ? session('t', '2026-09-17T10:30:00Z') : json([]),
    );
    await client.listEquipment({ since: new Date('2026-09-01T00:00:00Z') });
    const get = calls[1]!;
    expect(get.url.search).toContain(
      '$filter=(deleteddate%20eq%20null)%20and%20(modifieddate%20gt%202026-09-01T00%3A00%3A00.000Z)',
    );
    expect(get.url.searchParams.get('$expand')).toBe('Item,Customer');

    await client.listEquipment({ includeDeleted: true });
    expect(calls[2]!.url.searchParams.get('$filter')).toBeNull();
  });

  it('pages with $skip until a short page when there is no count', async () => {
    const pages: Record<string, unknown[]> = { '0': [{ Id: 1 }, { Id: 2 }], '2': [{ Id: 3 }] };
    const { client, calls } = make(({ url }) =>
      url.pathname.startsWith('/application')
        ? session('t', '2026-09-17T10:30:00Z')
        : json(pages[url.searchParams.get('$skip') ?? ''] ?? []),
    );
    expect((await client.listCustomers()).map((r) => r.Id)).toEqual([1, 2, 3]);
    expect(calls.slice(1).map((c) => c.url.searchParams.get('$skip'))).toEqual(['0', '2']);
  });

  it('adapts to a server-side cap using @odata.count', async () => {
    const all = [1, 2, 3, 4, 5].map((Id) => ({ Id }));
    const { client, calls } = make(
      ({ url }) => {
        if (url.pathname.startsWith('/application')) return session('t', '2026-09-17T10:30:00Z');
        const skip = Number(url.searchParams.get('$skip'));
        return json({ '@odata.count': 5, value: all.slice(skip, skip + 2) });
      },
      () => T0,
      10,
    );
    expect((await client.listCustomers()).map((r) => r.Id)).toEqual([1, 2, 3, 4, 5]);
    expect(calls.slice(1).map((c) => c.url.searchParams.get('$top'))).toEqual(['10', '2', '2']);
  });

  it('reissues when the token is near expiry', async () => {
    let now = T0;
    const { client, calls } = make(
      ({ url }) => {
        if (url.pathname === '/application/loginsingle') return session('t1', '2026-09-17T10:30:00Z');
        if (url.pathname === '/application/reissue') return session('t2', '2026-09-17T11:00:00Z');
        return json([]);
      },
      () => now,
    );
    await client.listCustomers();
    now = Date.parse('2026-09-17T10:26:00Z');
    await client.listCustomers();
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/application/loginsingle',
      '/customer',
      '/application/reissue',
      '/customer',
    ]);
    expect(calls[2]?.headers.authorization).toBe('Bearer t1');
    expect(calls[3]?.headers.authorization).toBe('Bearer t2');
  });

  it('re-logs in once on 401, then gives up with AuthError', async () => {
    let getCount = 0;
    const { client } = make(({ url }) => {
      if (url.pathname.startsWith('/application')) return session('t', '2026-09-17T10:30:00Z');
      getCount++;
      return new Response('', { status: 401 });
    });
    await expect(client.listCustomers()).rejects.toBeInstanceOf(AuthError);
    expect(getCount).toBe(2);
  });

  it('throws AuthError when login fails', async () => {
    const { client } = make(() => json({ error: { message: 'bad' } }, 400));
    await expect(client.listCustomers()).rejects.toBeInstanceOf(AuthError);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/vantage`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`packages/vantage/src/client.ts`:
```ts
import { AuthError, HttpError, ParseError, getField, getNumber, getString, parseApiDate } from '@mps/core';

export interface VantageClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  apiVersion: string;
  fetch?: typeof fetch;
  now?: () => number;
  pageSize?: number;
}

export interface ListOptions {
  since?: Date;
  includeDeleted?: boolean;
}

export type VantageRecord = Record<string, unknown>;

const REISSUE_WINDOW_MS = 5 * 60_000;

function buildQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function parseJson(text: string, what: string, status: number): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ParseError(`Vantage ${what} returned non-JSON`, status, text.slice(0, 500));
  }
}

export function createVantageClient(opts: VantageClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const defaultPageSize = opts.pageSize ?? 500;
  let token: string | null = null;
  let expiresAt = 0;

  async function openSession(kind: 'loginsingle' | 'reissue'): Promise<void> {
    const authorization =
      kind === 'loginsingle'
        ? `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`
        : `Bearer ${token}`;
    const res = await doFetch(`${base}/application/${kind}`, {
      method: 'POST',
      headers: { authorization, 'api-version': opts.apiVersion, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new AuthError(`Vantage ${kind} failed (${res.status})`, res.status, text.slice(0, 500));
    const body = parseJson(text, kind, res.status);
    const newToken = getString(body, 'Token');
    if (!newToken) throw new ParseError(`Vantage ${kind} returned no token`, res.status);
    token = newToken;
    expiresAt = parseApiDate(getField(body, 'TokenExpiryDate'))?.getTime() ?? now() + 25 * 60_000;
  }

  async function ensureToken(): Promise<void> {
    if (!token) return openSession('loginsingle');
    if (expiresAt - now() < REISSUE_WINDOW_MS) {
      try {
        await openSession('reissue');
      } catch {
        token = null;
        await openSession('loginsingle');
      }
    }
  }

  async function get(path: string, params: Record<string, string | number>): Promise<unknown> {
    const send = () =>
      doFetch(`${base}/${path}?${buildQuery(params)}`, {
        headers: { authorization: `Bearer ${token}`, 'api-version': opts.apiVersion, Accept: 'application/json' },
      });
    await ensureToken();
    let res = await send();
    if (res.status === 401) {
      token = null;
      await ensureToken();
      res = await send();
      if (res.status === 401) throw new AuthError(`Vantage GET ${path} unauthorised after re-login`, 401);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(`Vantage GET ${path} failed (${res.status})`, res.status, text.slice(0, 500));
    return parseJson(text, `GET ${path}`, res.status);
  }

  async function odataList(
    entity: string,
    o: { filter?: string[]; expand?: string; includeDeleted?: boolean } = {},
  ): Promise<VantageRecord[]> {
    const filters = [...(o.filter ?? [])];
    if (!o.includeDeleted) filters.unshift('deleteddate eq null');
    const out: VantageRecord[] = [];
    let top = defaultPageSize;
    for (;;) {
      const params: Record<string, string | number> = {
        $top: top,
        $skip: out.length,
        $orderby: 'Id',
        $count: 'true',
      };
      if (filters.length > 0) params.$filter = filters.map((f) => `(${f})`).join(' and ');
      if (o.expand) params.$expand = o.expand;
      const body = await get(entity, params);
      const items = Array.isArray(body) ? body : getField(body, 'value');
      if (!Array.isArray(items)) throw new ParseError(`Vantage ${entity} response has no value array`, 200);
      if (items.length === 0) return out;
      out.push(...(items as VantageRecord[]));
      const total = Array.isArray(body) ? null : getNumber(body, '@odata.count');
      if (total !== null) {
        if (out.length >= total) return out;
        if (items.length < top) top = items.length;
        continue;
      }
      if (items.length < top) return out;
    }
  }

  const listFilters = (o: ListOptions) =>
    o.since ? [`modifieddate gt ${o.since.toISOString()}`] : [];

  return {
    odataList,
    listCustomers: (o: ListOptions = {}) =>
      odataList('customer', { filter: listFilters(o), includeDeleted: o.includeDeleted }),
    listEquipment: (o: ListOptions = {}) =>
      odataList('Equipment', {
        filter: listFilters(o),
        includeDeleted: o.includeDeleted,
        expand: 'Item,Customer',
      }),
  };
}

export type VantageClient = ReturnType<typeof createVantageClient>;
```

`packages/vantage/src/index.ts`:
```ts
export * from './client';
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/vantage`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vantage): add OData client with session reissue and paging

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Queue package + worker foundations (env, sync runs, time helpers)

**Files:**
- Create: `packages/queue/package.json`, `packages/queue/tsconfig.json`, `packages/queue/src/index.ts`
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/env.ts`, `apps/worker/src/sync-runs.ts`, `apps/worker/src/time.ts`
- Test: `apps/worker/src/sync-runs.test.ts`, `apps/worker/src/time.test.ts`, `apps/worker/src/env.test.ts`

**Interfaces:**
- Consumes: `Db`, `syncRuns` (Task 3); `errorMessage` (Task 1)
- Produces:
  - `@mps/queue`: `QUEUES = { vantagePull: 'vantage-pull', drmsPull: 'drms-pull', linkRun: 'link-run', drmsSnapshot: 'drms-snapshot' }`, `type QueueName`, `createBoss(connectionString: string, role: 'worker' | 'client'): PgBoss`
  - `apps/worker/src/env.ts`: `loadEnv(src?: NodeJS.ProcessEnv): Env`, `type Env`
  - `apps/worker/src/sync-runs.ts`: `type RunStatus = 'success' | 'partial' | 'failed'`, `interface JobResult { status: RunStatus; stats: Record<string, number>; errorSample?: string }`, `withSyncRun(db, job, fn): Promise<JobResult>`, `lastSuccessfulStart(db, job): Promise<Date | null>`, `failStaleRuns(db): Promise<number>`
  - `apps/worker/src/time.ts`: `isSundayIn(timeZone: string, at: Date): boolean`, `startOfUtcDay(at: Date): Date`

- [ ] **Step 1: Packages + install**

`packages/queue/package.json`:
```json
{
  "name": "@mps/queue",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit" }
}
```
`apps/worker/package.json`:
```json
{
  "name": "@mps/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=../../.env src/main.ts",
    "start": "tsx src/main.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mps/core": "*",
    "@mps/db": "*",
    "@mps/drms": "*",
    "@mps/queue": "*",
    "@mps/vantage": "*"
  }
}
```
Both `tsconfig.json` files: same content as core (`"extends": "../../tsconfig.base.json"`).
Run: `npm i -w @mps/queue pg-boss@^10 && npm i -w @mps/worker zod@^4 drizzle-orm@^0.44 tsx@^4`

`packages/queue/src/index.ts`:
```ts
import PgBoss from 'pg-boss';

export const QUEUES = {
  vantagePull: 'vantage-pull',
  drmsPull: 'drms-pull',
  linkRun: 'link-run',
  drmsSnapshot: 'drms-snapshot',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** 'client' = send-only (web app): no maintenance or cron supervision. */
export function createBoss(connectionString: string, role: 'worker' | 'client'): PgBoss {
  return role === 'worker'
    ? new PgBoss({ connectionString })
    : new PgBoss({ connectionString, supervise: false, schedule: false });
}
```

- [ ] **Step 2: Write the failing tests**

`apps/worker/src/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isSundayIn, startOfUtcDay } from './time';

describe('time helpers', () => {
  it('detects Sunday in the given zone', () => {
    // 23:30 UTC Saturday = 00:30 BST Sunday
    expect(isSundayIn('Europe/London', new Date('2026-09-19T23:30:00Z'))).toBe(true);
    expect(isSundayIn('UTC', new Date('2026-09-19T23:30:00Z'))).toBe(false);
  });
  it('truncates to UTC midnight', () => {
    expect(startOfUtcDay(new Date('2026-09-17T15:04:05Z')).toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });
});
```

`apps/worker/src/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://x',
  DRMS_BASE_URL: 'https://drms.test/api/v8',
  DRMS_TOKEN: 't',
  VANTAGE_BASE_URL: 'https://api.vantage.online',
  VANTAGE_USER: 'u',
  VANTAGE_PASS: 'p',
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      VANTAGE_API_VERSION: '1.22',
      LINK_ERP_ID_FIELD: 'id',
      LINK_CUSTOMER_ERP_FIELD: 'none',
      SNAPSHOT_CRON: '0 6 * * *',
      TZ_SCHEDULE: 'Europe/London',
      ADMIN_USERNAME: 'admin',
    });
  });
  it('rejects missing secrets and bad enum values', () => {
    expect(() => loadEnv({ ...base, DRMS_TOKEN: '' })).toThrow();
    expect(() => loadEnv({ ...base, LINK_ERP_ID_FIELD: 'serial' })).toThrow();
    expect(() => loadEnv({ ...base, ADMIN_PASSWORD: 'short' })).toThrow();
  });
});
```

`apps/worker/src/sync-runs.test.ts`:
```ts
import { syncRuns } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failStaleRuns, lastSuccessfulStart, withSyncRun } from './sync-runs';

describe('sync runs', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('records a successful run with stats', async () => {
    const result = await withSyncRun(t.db, 'job-a', async () => ({ status: 'partial', stats: { n: 3 }, errorSample: 'x' }));
    expect(result.status).toBe('partial');
    const [row] = await t.db.select().from(syncRuns);
    expect(row).toMatchObject({ job: 'job-a', status: 'partial', stats: { n: 3 }, errorSample: 'x' });
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('records a failed run and rethrows', async () => {
    await expect(
      withSyncRun(t.db, 'job-a', async () => {
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
    const [row] = await t.db.select().from(syncRuns);
    expect(row).toMatchObject({ status: 'failed', errorSample: 'Error: kaboom' });
  });

  it('finds the latest successful start for a job', async () => {
    await t.db.insert(syncRuns).values([
      { job: 'job-a', status: 'success', startedAt: new Date('2026-09-15T02:00:00Z') },
      { job: 'job-a', status: 'success', startedAt: new Date('2026-09-16T02:00:00Z') },
      { job: 'job-a', status: 'failed', startedAt: new Date('2026-09-17T02:00:00Z') },
      { job: 'job-b', status: 'success', startedAt: new Date('2026-09-18T02:00:00Z') },
    ]);
    expect((await lastSuccessfulStart(t.db, 'job-a'))?.toISOString()).toBe('2026-09-16T02:00:00.000Z');
    expect(await lastSuccessfulStart(t.db, 'job-c')).toBeNull();
  });

  it('marks stale running runs as failed', async () => {
    await t.db.insert(syncRuns).values([{ job: 'a', status: 'running' }, { job: 'b', status: 'success' }]);
    expect(await failStaleRuns(t.db)).toBe(1);
    const rows = await t.db.select().from(syncRuns);
    expect(rows.find((r) => r.job === 'a')).toMatchObject({ status: 'failed', errorSample: 'worker restarted during run' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run apps/worker`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement**

`apps/worker/src/time.ts`:
```ts
export function isSundayIn(timeZone: string, at: Date): boolean {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at) === 'Sun';
}

export function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
```

`apps/worker/src/env.ts`:
```ts
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DRMS_BASE_URL: z.url(),
  DRMS_TOKEN: z.string().min(1),
  VANTAGE_BASE_URL: z.url(),
  VANTAGE_USER: z.string().min(1),
  VANTAGE_PASS: z.string().min(1),
  VANTAGE_API_VERSION: z.string().min(1).default('1.22'),
  LINK_ERP_ID_FIELD: z.enum(['id', 'assetNumber']).default('id'),
  LINK_CUSTOMER_ERP_FIELD: z.enum(['id', 'reference', 'none']).default('none'),
  SNAPSHOT_CRON: z.string().min(1).default('0 6 * * *'),
  TZ_SCHEDULE: z.string().min(1).default('Europe/London'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(12).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(src: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined && v !== ''));
  // Keep explicitly-empty required secrets failing: re-add them as ''.
  for (const key of ['DRMS_TOKEN', 'VANTAGE_USER', 'VANTAGE_PASS', 'DATABASE_URL'] as const) {
    if (src[key] === '') cleaned[key] = '';
  }
  return envSchema.parse(cleaned);
}
```

`apps/worker/src/sync-runs.ts`:
```ts
import { errorMessage } from '@mps/core';
import { syncRuns, type Db } from '@mps/db';
import { and, desc, eq } from 'drizzle-orm';

export type RunStatus = 'success' | 'partial' | 'failed';

export interface JobResult {
  status: RunStatus;
  stats: Record<string, number>;
  errorSample?: string;
}

export async function withSyncRun(db: Db, job: string, fn: () => Promise<JobResult>): Promise<JobResult> {
  const [run] = await db.insert(syncRuns).values({ job, status: 'running' }).returning({ id: syncRuns.id });
  const runId = (run as { id: number }).id;
  try {
    const result = await fn();
    await db
      .update(syncRuns)
      .set({
        status: result.status,
        stats: result.stats,
        errorSample: result.errorSample ?? null,
        finishedAt: new Date(),
      })
      .where(eq(syncRuns.id, runId));
    return result;
  } catch (err) {
    await db
      .update(syncRuns)
      .set({ status: 'failed', errorSample: errorMessage(err), finishedAt: new Date() })
      .where(eq(syncRuns.id, runId));
    throw err;
  }
}

export async function lastSuccessfulStart(db: Db, job: string): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.job, job), eq(syncRuns.status, 'success')))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

export async function failStaleRuns(db: Db): Promise<number> {
  const rows = await db
    .update(syncRuns)
    .set({ status: 'failed', errorSample: 'worker restarted during run', finishedAt: new Date() })
    .where(eq(syncRuns.status, 'running'))
    .returning({ id: syncRuns.id });
  return rows.length;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/worker`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): add queue names, env loading and sync run tracking

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `vantage-pull` job

**Files:**
- Create: `apps/worker/src/jobs/vantage-pull.ts`, `apps/worker/src/test-helpers.ts`
- Test: `apps/worker/src/jobs/vantage-pull.test.ts`

**Interfaces:**
- Consumes: `VantageClient`, `VantageRecord` (Task 7); `vantageCustomers`, `vantageEquipment`, `excluded`, `Db` (Task 3); `lastSuccessfulStart`, `JobResult` (Task 8); `QUEUES` (Task 8); `chunk`, `getField`, `getNumber`, `getString`, `getBool`, `parseApiDate`, `normaliseSerial`, `ParseError` (Task 1)
- Produces:
  - `mapVantageCustomer(raw: VantageRecord, syncedAt: Date): typeof vantageCustomers.$inferInsert`
  - `mapVantageEquipment(raw: VantageRecord, syncedAt: Date): typeof vantageEquipment.$inferInsert`
  - `runVantagePull(deps: { db: Db; vantage: Pick<VantageClient, 'listCustomers' | 'listEquipment'>; now?: () => Date }, opts: { full: boolean }): Promise<JobResult>`
  - `test-helpers.ts`: `fakeVantage(customers: VantageRecord[], equipment: VantageRecord[])`, which returns `{ client, calls: ListOptions[] }`

Behaviour:
- `since` is the last successful `vantage-pull` start minus 10 min. The run is **full** when `opts.full` is set or there's no previous success.
- A full run lists with `includeDeleted: false` and no `since`, upserts everything, then sets `deletedDate = startedAt` on rows where `deletedDate is null and syncedAt < startedAt` (they vanished from Vantage).
- An incremental run lists with `since` and `includeDeleted: true`, so soft deletes arrive with their `DeletedDate`.
- Upserts go in chunks of 500, `onConflictDoUpdate` on the PK, with `excluded(table, ['vantageId'])`.
- Stats: `customers`, `equipment`, `customersMarkedDeleted`, `equipmentMarkedDeleted`, `full` (1/0). Status is `success`.

- [ ] **Step 1: Test helper**

`apps/worker/src/test-helpers.ts`:
```ts
import type { ListOptions, VantageRecord } from '@mps/vantage';

export function fakeVantage(customers: VantageRecord[], equipment: VantageRecord[]) {
  const calls: { entity: 'customer' | 'equipment'; opts: ListOptions }[] = [];
  return {
    calls,
    client: {
      async listCustomers(opts: ListOptions = {}) {
        calls.push({ entity: 'customer', opts });
        return customers;
      },
      async listEquipment(opts: ListOptions = {}) {
        calls.push({ entity: 'equipment', opts });
        return equipment;
      },
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/worker/src/jobs/vantage-pull.test.ts`:
```ts
import { syncRuns, vantageCustomers, vantageEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantage } from '../test-helpers';
import { mapVantageEquipment, runVantagePull } from './vantage-pull';

const customer = (Id: number, extra: object = {}) => ({ Id, Reference: `C${Id}`, Name: `Cust ${Id}`, IsActive: true, ...extra });
const equipment = (Id: number, extra: object = {}) => ({
  Id,
  SerialNumber: `ab-${Id}`,
  AssetNumber: `EQ${Id}`,
  Description: 'bizhub',
  Item: { PartNumber: 'C300i', Description: 'bizhub C300i' },
  Customer: { Id: 1, Reference: 'C1', Name: 'Cust 1' },
  ModifiedDate: '2026-09-10T08:00:00Z',
  ...extra,
});

describe('mapVantageEquipment', () => {
  it('maps expanded item and customer, normalises serial, keeps raw', () => {
    const raw = equipment(5);
    const row = mapVantageEquipment(raw, new Date('2026-09-17T02:00:00Z'));
    expect(row).toMatchObject({
      vantageId: 5,
      serial: 'ab-5',
      serialNorm: 'AB5',
      assetNumber: 'EQ5',
      itemPartNumber: 'C300i',
      vantageCustomerId: 1,
      customerReference: 'C1',
      customerName: 'Cust 1',
      deletedDate: null,
      raw,
    });
    expect(row.modifiedDate?.toISOString()).toBe('2026-09-10T08:00:00.000Z');
  });
  it('rejects a record without Id', () => {
    expect(() => mapVantageEquipment({ SerialNumber: 'x' }, new Date())).toThrow();
  });
});

describe('runVantagePull', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('does a full pull when there is no previous success', async () => {
    const v = fakeVantage([customer(1)], [equipment(10), equipment(11)]);
    const result = await runVantagePull({ db: t.db, vantage: v.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: false });
    expect(result).toMatchObject({ status: 'success', stats: { customers: 1, equipment: 2, full: 1 } });
    expect(v.calls.map((c) => c.opts)).toEqual([{ includeDeleted: false }, { includeDeleted: false }]);
    expect(await t.db.select().from(vantageEquipment)).toHaveLength(2);
  });

  it('does an incremental pull including deleted rows since last success minus 10 minutes', async () => {
    await t.db.insert(syncRuns).values({ job: 'vantage-pull', status: 'success', startedAt: new Date('2026-09-16T02:00:00Z') });
    const v = fakeVantage([], [equipment(10, { DeletedDate: '2026-09-16T12:00:00Z' })]);
    const result = await runVantagePull({ db: t.db, vantage: v.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: false });
    expect(result.stats.full).toBe(0);
    expect(v.calls[1]?.opts).toEqual({ since: new Date('2026-09-16T01:50:00Z'), includeDeleted: true });
    const [row] = await t.db.select().from(vantageEquipment);
    expect(row?.deletedDate?.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });

  it('updates existing rows and marks vanished rows deleted on a full pull', async () => {
    const first = fakeVantage([customer(1), customer(2)], [equipment(10), equipment(11)]);
    await runVantagePull({ db: t.db, vantage: first.client, now: () => new Date('2026-09-16T02:00:00Z') }, { full: true });
    const second = fakeVantage([customer(1, { Name: 'Renamed' })], [equipment(10, { SerialNumber: 'NEW' })]);
    const result = await runVantagePull({ db: t.db, vantage: second.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: true });
    expect(result.stats).toMatchObject({ customersMarkedDeleted: 1, equipmentMarkedDeleted: 1 });
    const [c1] = await t.db.select().from(vantageCustomers).where(eq(vantageCustomers.vantageId, 1));
    expect(c1?.name).toBe('Renamed');
    const [e10] = await t.db.select().from(vantageEquipment).where(eq(vantageEquipment.vantageId, 10));
    expect(e10).toMatchObject({ serialNorm: 'NEW', deletedDate: null });
    const [e11] = await t.db.select().from(vantageEquipment).where(eq(vantageEquipment.vantageId, 11));
    expect(e11?.deletedDate?.toISOString()).toBe('2026-09-17T02:00:00.000Z');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run apps/worker/src/jobs/vantage-pull.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`apps/worker/src/jobs/vantage-pull.ts`:
```ts
import {
  ParseError,
  chunk,
  getBool,
  getField,
  getNumber,
  getString,
  normaliseSerial,
  parseApiDate,
} from '@mps/core';
import { excluded, vantageCustomers, vantageEquipment, type Db } from '@mps/db';
import { QUEUES } from '@mps/queue';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import { and, isNull, lt } from 'drizzle-orm';
import { lastSuccessfulStart, type JobResult } from '../sync-runs';

const OVERLAP_MS = 10 * 60_000;
const CHUNK = 500;

function requireId(raw: VantageRecord, what: string): number {
  const id = getNumber(raw, 'Id');
  if (id === null) throw new ParseError(`Vantage ${what} without Id`, null);
  return id;
}

export function mapVantageCustomer(raw: VantageRecord, syncedAt: Date): typeof vantageCustomers.$inferInsert {
  return {
    vantageId: requireId(raw, 'customer'),
    reference: getString(raw, 'Reference'),
    name: getString(raw, 'Name'),
    isActive: getBool(raw, 'IsActive'),
    isOnStop: getBool(raw, 'IsOnStop'),
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
    deletedDate: parseApiDate(getField(raw, 'DeletedDate')),
    raw,
    syncedAt,
  };
}

export function mapVantageEquipment(raw: VantageRecord, syncedAt: Date): typeof vantageEquipment.$inferInsert {
  const customer = getField(raw, 'Customer');
  const item = getField(raw, 'Item');
  const serial = getString(raw, 'SerialNumber');
  return {
    vantageId: requireId(raw, 'equipment'),
    serial,
    serialNorm: normaliseSerial(serial),
    assetNumber: getString(raw, 'AssetNumber'),
    description: getString(raw, 'Description'),
    itemPartNumber: getString(item, 'PartNumber'),
    vantageCustomerId: getNumber(customer, 'Id') ?? getNumber(raw, 'CustomerId'),
    customerReference: getString(customer, 'Reference'),
    customerName: getString(customer, 'Name'),
    location: getString(raw, 'Location'),
    installDate: parseApiDate(getField(raw, 'InstallDate')),
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
    deletedDate: parseApiDate(getField(raw, 'DeletedDate')),
    raw,
    syncedAt,
  };
}

export interface VantagePullDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listCustomers' | 'listEquipment'>;
  now?: () => Date;
}

export async function runVantagePull(deps: VantagePullDeps, opts: { full: boolean }): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();
  const lastStart = opts.full ? null : await lastSuccessfulStart(db, QUEUES.vantagePull);
  const full = lastStart === null;
  const listOpts = full
    ? { includeDeleted: false }
    : { since: new Date(lastStart.getTime() - OVERLAP_MS), includeDeleted: true };

  const customers = (await vantage.listCustomers(listOpts)).map((r) => mapVantageCustomer(r, startedAt));
  const equipment = (await vantage.listEquipment(listOpts)).map((r) => mapVantageEquipment(r, startedAt));

  for (const rows of chunk(customers, CHUNK)) {
    await db
      .insert(vantageCustomers)
      .values(rows)
      .onConflictDoUpdate({ target: vantageCustomers.vantageId, set: excluded(vantageCustomers, ['vantageId']) });
  }
  for (const rows of chunk(equipment, CHUNK)) {
    await db
      .insert(vantageEquipment)
      .values(rows)
      .onConflictDoUpdate({ target: vantageEquipment.vantageId, set: excluded(vantageEquipment, ['vantageId']) });
  }

  let customersMarkedDeleted = 0;
  let equipmentMarkedDeleted = 0;
  if (full) {
    customersMarkedDeleted = (
      await db
        .update(vantageCustomers)
        .set({ deletedDate: startedAt })
        .where(and(isNull(vantageCustomers.deletedDate), lt(vantageCustomers.syncedAt, startedAt)))
        .returning({ id: vantageCustomers.vantageId })
    ).length;
    equipmentMarkedDeleted = (
      await db
        .update(vantageEquipment)
        .set({ deletedDate: startedAt })
        .where(and(isNull(vantageEquipment.deletedDate), lt(vantageEquipment.syncedAt, startedAt)))
        .returning({ id: vantageEquipment.vantageId })
    ).length;
  }

  return {
    status: 'success',
    stats: {
      customers: customers.length,
      equipment: equipment.length,
      customersMarkedDeleted,
      equipmentMarkedDeleted,
      full: full ? 1 : 0,
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/worker`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): add vantage-pull job

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `drms-pull` job

**Files:**
- Create: `apps/worker/src/jobs/drms-pull.ts`
- Modify: `apps/worker/src/test-helpers.ts` (add `drmsDevice`)
- Test: `apps/worker/src/jobs/drms-pull.test.ts`

**Interfaces:**
- Consumes: `DrmsClient`, `DrmsEquipment`, `DrmsCustomer` (Task 6); `drmsEquipment`, `drmsCustomers`, `excluded`, `Db` (Task 3); `JobResult` (Task 8); `chunk`, `normaliseSerial`, `parseApiDate`, `errorMessage`, `AuthError`, `RateLimitError` (Task 1)
- Produces:
  - `mapDrmsEquipment(e: DrmsEquipment, seenAt: Date): typeof drmsEquipment.$inferInsert`
  - `runDrmsPull(deps: { db: Db; drms: Pick<DrmsClient, 'listEquipment' | 'listCustomers'>; now?: () => Date }): Promise<JobResult>`
  - test helper `drmsDevice(id: string, extra?: Partial<DrmsEquipment>): DrmsEquipment`

Behaviour:
- If `listEquipment()` returns 0 devices while `drms_equipment` already has rows, throw `Error('DRMS returned 0 devices; refusing to mark the fleet missing')`.
- Upsert on `drmsId`, keeping `drmsId`, `firstSeenAt` and `lastSnapshotFetchAt`. Every upserted row gets `lastSeenAt = seenAt` and `missingSince = null`.
- Rows with `lastSeenAt < seenAt` and `missingSince is null` → `missingSince = seenAt`.
- Customers: call `listCustomers()` and upsert on `drmsId`. If it throws, status is `partial`, `errorSample = 'customers: ' + errorMessage(err)`, and equipment results are kept.
- Stats: `equipment`, `markedMissing`, `customers`.

- [ ] **Step 1: Extend the test helper**

Append to `apps/worker/src/test-helpers.ts`:
```ts
import type { DrmsEquipment } from '@mps/drms';

export function drmsDevice(id: string, extra: Partial<DrmsEquipment> = {}): DrmsEquipment {
  return {
    Id: id,
    ErpId: null,
    SerialNumber: `ser-${id}`,
    ModelName: 'bizhub C300i',
    Status: 'Registered',
    CustomerErpId: 'C1',
    CustomerName: 'Cust 1',
    ...extra,
  };
}
```
(Move the new `import type` line to the top of the file with the other import.)

- [ ] **Step 2: Write the failing tests**

`apps/worker/src/jobs/drms-pull.test.ts`:
```ts
import { drmsCustomers, drmsEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsCustomer, DrmsEquipment } from '@mps/drms';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drmsDevice } from '../test-helpers';
import { mapDrmsEquipment, runDrmsPull } from './drms-pull';

function fakeDrms(equipment: DrmsEquipment[], customers: DrmsCustomer[] | Error) {
  return {
    listEquipment: async () => equipment,
    listCustomers: async () => {
      if (customers instanceof Error) throw customers;
      return customers;
    },
  };
}

describe('mapDrmsEquipment', () => {
  it('maps fields, normalises serial and parses DRMS dates', () => {
    const e = drmsDevice('g1', { SerialNumber: 'a1b-2', RegistrationTime: '2026-01-02 03:04:05', ErpId: '77' });
    const row = mapDrmsEquipment(e, new Date('2026-09-17T02:15:00Z'));
    expect(row).toMatchObject({ drmsId: 'g1', erpId: '77', serialNorm: 'A1B2', status: 'Registered', customerErpId: 'C1', missingSince: null, raw: e });
    expect(row.registrationTime?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('runDrmsPull', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('upserts devices and customers, keeping first-seen, flagging missing', async () => {
    const day1 = new Date('2026-09-16T02:15:00Z');
    const day2 = new Date('2026-09-17T02:15:00Z');
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1'), drmsDevice('g2')], [{ Id: 'c1', Name: 'Cust', ErpId: 'C1', CsrcIds: ['X'] }]), now: () => day1 });
    const result = await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1', { Status: 'PreRegistered' })], []), now: () => day2 });

    expect(result).toMatchObject({ status: 'success', stats: { equipment: 1, markedMissing: 1, customers: 0 } });
    const [g1] = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'g1'));
    expect(g1).toMatchObject({ status: 'PreRegistered', missingSince: null });
    expect(g1?.firstSeenAt.toISOString()).toBe(day1.toISOString());
    expect(g1?.lastSeenAt.toISOString()).toBe(day2.toISOString());
    const [g2] = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'g2'));
    expect(g2?.missingSince?.toISOString()).toBe(day2.toISOString());
    const [c1] = await t.db.select().from(drmsCustomers);
    expect(c1).toMatchObject({ drmsId: 'c1', erpId: 'C1', csrcIds: ['X'] });
  });

  it('clears missingSince when a device returns', async () => {
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1'), drmsDevice('g2')], []), now: () => new Date('2026-09-15T02:15:00Z') });
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-16T02:15:00Z') });
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1'), drmsDevice('g2')], []), now: () => new Date('2026-09-17T02:15:00Z') });
    const [g2] = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'g2'));
    expect(g2?.missingSince).toBeNull();
  });

  it('keeps lastSnapshotFetchAt across pulls', async () => {
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-16T02:15:00Z') });
    await t.db.update(drmsEquipment).set({ lastSnapshotFetchAt: new Date('2026-09-16T06:00:00Z') });
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-17T02:15:00Z') });
    const [g1] = await t.db.select().from(drmsEquipment);
    expect(g1?.lastSnapshotFetchAt?.toISOString()).toBe('2026-09-16T06:00:00.000Z');
  });

  it('refuses to mark everything missing when DRMS returns nothing', async () => {
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-16T02:15:00Z') });
    await expect(runDrmsPull({ db: t.db, drms: fakeDrms([], []), now: () => new Date('2026-09-17T02:15:00Z') })).rejects.toThrow('refusing');
  });

  it('is partial when customers fail but equipment succeeds', async () => {
    const result = await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], new Error('nope')), now: () => new Date() });
    expect(result.status).toBe('partial');
    expect(result.errorSample).toBe('customers: Error: nope');
    expect(await t.db.select().from(drmsEquipment)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run apps/worker/src/jobs/drms-pull.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`apps/worker/src/jobs/drms-pull.ts`:
```ts
import { chunk, errorMessage, normaliseSerial, parseApiDate } from '@mps/core';
import { drmsCustomers, drmsEquipment, excluded, type Db } from '@mps/db';
import type { DrmsClient, DrmsCustomer, DrmsEquipment } from '@mps/drms';
import { and, isNull, lt, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

const CHUNK = 500;

export function mapDrmsEquipment(e: DrmsEquipment, seenAt: Date): typeof drmsEquipment.$inferInsert {
  return {
    drmsId: e.Id,
    erpId: e.ErpId ?? null,
    serial: e.SerialNumber ?? null,
    serialNorm: normaliseSerial(e.SerialNumber),
    modelName: e.ModelName ?? null,
    productName: e.ProductName ?? null,
    status: e.Status ?? null,
    communicationType: e.CommunicationType ?? null,
    customerErpId: e.CustomerErpId ?? null,
    customerName: e.CustomerName ?? null,
    customerCsrcId: e.CustomerCsrcId ?? null,
    registrationTime: parseApiDate(e.RegistrationTime),
    initialConnectionTime: parseApiDate(e.InitialConnectionTime),
    lastCounterReceivedTime: parseApiDate(e.LastCounterReceivedTime),
    lastSeenAt: seenAt,
    missingSince: null,
    raw: e,
    syncedAt: seenAt,
  };
}

function mapDrmsCustomer(c: DrmsCustomer, syncedAt: Date): typeof drmsCustomers.$inferInsert {
  return {
    drmsId: c.Id,
    erpId: c.ErpId ?? null,
    name: c.Name ?? null,
    csrcIds: c.CsrcIds ?? null,
    raw: c,
    syncedAt,
  };
}

export interface DrmsPullDeps {
  db: Db;
  drms: Pick<DrmsClient, 'listEquipment' | 'listCustomers'>;
  now?: () => Date;
}

export async function runDrmsPull(deps: DrmsPullDeps): Promise<JobResult> {
  const { db, drms } = deps;
  const seenAt = (deps.now ?? (() => new Date()))();

  const equipment = await drms.listEquipment();
  if (equipment.length === 0) {
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(drmsEquipment);
    if (n > 0) throw new Error('DRMS returned 0 devices; refusing to mark the fleet missing');
  }

  for (const rows of chunk(equipment.map((e) => mapDrmsEquipment(e, seenAt)), CHUNK)) {
    await db
      .insert(drmsEquipment)
      .values(rows)
      .onConflictDoUpdate({
        target: drmsEquipment.drmsId,
        set: excluded(drmsEquipment, ['drmsId', 'firstSeenAt', 'lastSnapshotFetchAt']),
      });
  }

  const markedMissing = (
    await db
      .update(drmsEquipment)
      .set({ missingSince: seenAt })
      .where(and(lt(drmsEquipment.lastSeenAt, seenAt), isNull(drmsEquipment.missingSince)))
      .returning({ id: drmsEquipment.drmsId })
  ).length;

  let customers = 0;
  let errorSample: string | undefined;
  try {
    const list = await drms.listCustomers();
    for (const rows of chunk(list.map((c) => mapDrmsCustomer(c, seenAt)), CHUNK)) {
      await db
        .insert(drmsCustomers)
        .values(rows)
        .onConflictDoUpdate({ target: drmsCustomers.drmsId, set: excluded(drmsCustomers, ['drmsId']) });
    }
    customers = list.length;
  } catch (err) {
    errorSample = `customers: ${errorMessage(err)}`;
  }

  return {
    status: errorSample ? 'partial' : 'success',
    stats: { equipment: equipment.length, markedMissing, customers },
    errorSample,
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/worker`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): add drms-pull job

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `link-run` job

**Files:**
- Create: `apps/worker/src/jobs/link-run.ts`
- Modify: `apps/worker/src/test-helpers.ts` (add `seedDrms`, `seedVantage`)
- Test: `apps/worker/src/jobs/link-run.test.ts`

**Interfaces:**
- Consumes: `computeLinks`, `diffLinks`, `issueKey`, `reconcileIssues`, `deriveCustomerLinks`, `LinkConfig`, `ActiveLink` (Tasks 4–5); `deviceLinks`, `customerLinks`, `linkIssues`, `drmsEquipment`, `vantageEquipment`, `Db` (Task 3); `JobResult` (Task 8); `chunk` (Task 1)
- Produces:
  - `runLinkRun(deps: { db: Db; config: LinkConfig; now?: () => Date }): Promise<JobResult>`
  - test helpers `seedDrms(db, rows: Array<Partial<typeof drmsEquipment.$inferInsert> & { drmsId: string }>)` and `seedVantage(db, rows: Array<Partial<typeof vantageEquipment.$inferInsert> & { vantageId: number }>)`. Both set `serialNorm` from `serial` and `raw: {}`.

Behaviour, in one transaction:
1. Load inputs: DRMS `missing = missingSince != null`, Vantage `deleted = deletedDate != null`, and active links (`unlinkedAt is null`).
2. `computeLinks`, then `diffLinks`. First close links (`unlinkedAt = now`, `unlinkedReason = 'auto'`), then insert new ones (`linkedBy` null).
3. Customer links: upsert the derived ones on `customerErpId`, updating only where `method = 'derived'`. Delete derived rows whose `customerErpId` is no longer derived.
4. Issues: load `{id, issueKey, status}`, then `reconcileIssues`.
   - Insert with `issueKey(issue)`, `status 'open'`, `firstSeen/lastSeen = now`.
   - Touch sets `lastSeen = now` (chunks of 500 ids).
   - Reopen sets `status 'open'`, `details`, `lastSeen`, `resolvedAt null`, `resolvedBy null`.
   - Resolve sets `status 'resolved'`, `resolvedAt = now` (chunks).
5. Stats: `linksCreated`, `linksClosed`, `activeLinks`, `issuesOpened` (inserted + reopened), `issuesResolved`, `customerLinks`. Status is `success`.

- [ ] **Step 1: Extend test helpers**

Append to `apps/worker/src/test-helpers.ts` (merge imports at the top):
```ts
import { normaliseSerial } from '@mps/core';
import { drmsEquipment, vantageEquipment, type Db } from '@mps/db';

export async function seedDrms(
  db: Db,
  rows: Array<Partial<typeof drmsEquipment.$inferInsert> & { drmsId: string }>,
): Promise<void> {
  await db.insert(drmsEquipment).values(
    rows.map((r) => ({ status: 'Registered', raw: {}, ...r, serialNorm: normaliseSerial(r.serial) })),
  );
}

export async function seedVantage(
  db: Db,
  rows: Array<Partial<typeof vantageEquipment.$inferInsert> & { vantageId: number }>,
): Promise<void> {
  await db.insert(vantageEquipment).values(rows.map((r) => ({ raw: {}, ...r, serialNorm: normaliseSerial(r.serial) })));
}
```

- [ ] **Step 2: Write the failing tests**

`apps/worker/src/jobs/link-run.test.ts`:
```ts
import type { LinkConfig } from '@mps/core';
import { customerLinks, deviceLinks, drmsEquipment, linkIssues } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms, seedVantage } from '../test-helpers';
import { runLinkRun } from './link-run';

const config: LinkConfig = { erpIdField: 'id', customerErpField: 'reference' };

describe('runLinkRun', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const activeLinks = () => t.db.select().from(deviceLinks).where(isNull(deviceLinks.unlinkedAt));
  const openIssues = () => t.db.select().from(linkIssues).where(eq(linkIssues.status, 'open'));

  it('creates links and is idempotent', async () => {
    await seedVantage(t.db, [{ vantageId: 10, serial: 'A1B2C3D4E', vantageCustomerId: 1, customerReference: 'CUST1' }]);
    await seedDrms(t.db, [{ drmsId: 'd1', serial: 'a1b2-c3d4e', customerErpId: 'CUST1' }]);

    const first = await runLinkRun({ db: t.db, config });
    expect(first.stats).toMatchObject({ linksCreated: 1, linksClosed: 0, activeLinks: 1, customerLinks: 1 });
    expect(await activeLinks()).toMatchObject([{ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial' }]);
    expect(await t.db.select().from(customerLinks)).toMatchObject([{ customerErpId: 'CUST1', vantageCustomerId: 1, method: 'derived', deviceCount: 1 }]);

    const second = await runLinkRun({ db: t.db, config });
    expect(second.stats).toMatchObject({ linksCreated: 0, linksClosed: 0, issuesOpened: 0 });
    expect(await t.db.select().from(deviceLinks)).toHaveLength(1);
  });

  it('keeps manual links and does not overwrite manual customer links', async () => {
    await seedVantage(t.db, [
      { vantageId: 10, serial: 'A1', vantageCustomerId: 1 },
      { vantageId: 20, vantageCustomerId: 2 },
    ]);
    await seedDrms(t.db, [{ drmsId: 'd1', serial: 'A1', customerErpId: 'CUST1' }]);
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 20, method: 'manual' });
    await t.db.insert(customerLinks).values({ customerErpId: 'CUST1', vantageCustomerId: 99, method: 'manual' });

    await runLinkRun({ db: t.db, config });
    expect(await activeLinks()).toMatchObject([{ vantageEquipmentId: 20, method: 'manual' }]);
    expect(await t.db.select().from(customerLinks)).toMatchObject([{ vantageCustomerId: 99, method: 'manual' }]);
    expect((await openIssues()).map((i) => i.issueKey)).toEqual(['no_match_vantage||10']);
  });

  it('opens issues and auto-resolves them when fixed', async () => {
    await seedDrms(t.db, [{ drmsId: 'd2', serial: 'ZZ9' }]);
    await runLinkRun({ db: t.db, config });
    expect((await openIssues()).map((i) => i.issueKey)).toEqual(['no_match_drms|d2|']);

    await seedVantage(t.db, [{ vantageId: 30, serial: 'zz-9' }]);
    const result = await runLinkRun({ db: t.db, config });
    expect(result.stats).toMatchObject({ linksCreated: 1, issuesResolved: 1 });
    expect(await openIssues()).toEqual([]);
    const [resolved] = await t.db.select().from(linkIssues);
    expect(resolved).toMatchObject({ status: 'resolved' });
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
  });

  it('leaves ignored issues ignored and reopens resolved ones', async () => {
    await seedDrms(t.db, [{ drmsId: 'd3', serial: 'Q1' }]);
    await runLinkRun({ db: t.db, config });
    await t.db.update(linkIssues).set({ status: 'ignored' });
    await runLinkRun({ db: t.db, config });
    expect((await t.db.select().from(linkIssues))[0]?.status).toBe('ignored');

    await t.db.update(linkIssues).set({ status: 'resolved' });
    const result = await runLinkRun({ db: t.db, config });
    expect(result.stats.issuesOpened).toBe(1);
    expect((await t.db.select().from(linkIssues))[0]?.status).toBe('open');
  });

  it('closes a link when the DRMS device goes missing', async () => {
    await seedVantage(t.db, [{ vantageId: 10, serial: 'A1' }]);
    await seedDrms(t.db, [{ drmsId: 'd1', serial: 'A1' }]);
    await runLinkRun({ db: t.db, config });
    await t.db.update(drmsEquipment).set({ missingSince: new Date() });

    const result = await runLinkRun({ db: t.db, config });
    expect(result.stats).toMatchObject({ linksClosed: 1, activeLinks: 0 });
    const [closed] = await t.db.select().from(deviceLinks);
    expect(closed).toMatchObject({ unlinkedReason: 'auto' });
    expect((await openIssues()).map((i) => i.type).sort()).toEqual(['link_broken', 'no_match_vantage']);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run apps/worker/src/jobs/link-run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`apps/worker/src/jobs/link-run.ts`:
```ts
import {
  chunk,
  computeLinks,
  deriveCustomerLinks,
  diffLinks,
  issueKey,
  reconcileIssues,
  type DrmsDeviceInput,
  type LinkConfig,
  type LinkMethod,
  type VantageDeviceInput,
} from '@mps/core';
import { customerLinks, deviceLinks, drmsEquipment, linkIssues, vantageEquipment, type Db } from '@mps/db';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

const CHUNK = 500;

export interface LinkRunDeps {
  db: Db;
  config: LinkConfig;
  now?: () => Date;
}

export async function runLinkRun(deps: LinkRunDeps): Promise<JobResult> {
  const { db, config } = deps;
  const now = (deps.now ?? (() => new Date()))();

  return db.transaction(async (tx) => {
    const drmsRows = await tx
      .select({
        drmsId: drmsEquipment.drmsId,
        erpId: drmsEquipment.erpId,
        serialNorm: drmsEquipment.serialNorm,
        status: drmsEquipment.status,
        customerErpId: drmsEquipment.customerErpId,
        missingSince: drmsEquipment.missingSince,
      })
      .from(drmsEquipment);
    const drms: DrmsDeviceInput[] = drmsRows.map(({ missingSince, ...r }) => ({ ...r, missing: missingSince !== null }));

    const vantageRows = await tx
      .select({
        vantageId: vantageEquipment.vantageId,
        assetNumber: vantageEquipment.assetNumber,
        serialNorm: vantageEquipment.serialNorm,
        customerId: vantageEquipment.vantageCustomerId,
        customerReference: vantageEquipment.customerReference,
        deletedDate: vantageEquipment.deletedDate,
      })
      .from(vantageEquipment);
    const vantage: VantageDeviceInput[] = vantageRows.map(({ deletedDate, ...r }) => ({ ...r, deleted: deletedDate !== null }));

    const existing = (
      await tx
        .select({
          id: deviceLinks.id,
          drmsId: deviceLinks.drmsEquipmentId,
          vantageId: deviceLinks.vantageEquipmentId,
          method: deviceLinks.method,
        })
        .from(deviceLinks)
        .where(isNull(deviceLinks.unlinkedAt))
    ).map((l) => ({ ...l, method: l.method as LinkMethod }));

    const plan = computeLinks(drms, vantage, existing, config);
    const { toCreate, toClose } = diffLinks(existing, plan.links);

    for (const ids of chunk(toClose.map((l) => l.id), CHUNK)) {
      await tx.update(deviceLinks).set({ unlinkedAt: now, unlinkedReason: 'auto' }).where(inArray(deviceLinks.id, ids));
    }
    for (const rows of chunk(toCreate, CHUNK)) {
      await tx.insert(deviceLinks).values(
        rows.map((l) => ({ drmsEquipmentId: l.drmsId, vantageEquipmentId: l.vantageId, method: l.method, linkedAt: now })),
      );
    }

    const derived = deriveCustomerLinks(plan.links, drms, vantage);
    for (const rows of chunk(derived, CHUNK)) {
      await tx
        .insert(customerLinks)
        .values(rows.map((c) => ({ ...c, method: 'derived' as const, updatedAt: now })))
        .onConflictDoUpdate({
          target: customerLinks.customerErpId,
          set: {
            vantageCustomerId: sql.raw('excluded."vantage_customer_id"'),
            deviceCount: sql.raw('excluded."device_count"'),
            updatedAt: now,
          },
          setWhere: eq(customerLinks.method, 'derived'),
        });
    }
    const derivedIds = derived.map((c) => c.customerErpId);
    await tx
      .delete(customerLinks)
      .where(
        derivedIds.length > 0
          ? and(eq(customerLinks.method, 'derived'), notInArray(customerLinks.customerErpId, derivedIds))
          : eq(customerLinks.method, 'derived'),
      );

    const stored = (
      await tx.select({ id: linkIssues.id, key: linkIssues.issueKey, status: linkIssues.status }).from(linkIssues)
    ).map((s) => ({ ...s, status: s.status as 'open' | 'resolved' | 'ignored' }));
    const changes = reconcileIssues(stored, plan.issues);

    for (const rows of chunk(changes.toInsert, CHUNK)) {
      await tx.insert(linkIssues).values(
        rows.map((i) => ({
          issueKey: issueKey(i),
          type: i.type,
          drmsEquipmentId: i.drmsId,
          vantageEquipmentId: i.vantageId,
          details: i.details,
          status: 'open' as const,
          firstSeen: now,
          lastSeen: now,
        })),
      );
    }
    for (const ids of chunk(changes.toTouch, CHUNK)) {
      await tx.update(linkIssues).set({ lastSeen: now }).where(inArray(linkIssues.id, ids));
    }
    for (const { id, issue } of changes.toReopen) {
      await tx
        .update(linkIssues)
        .set({ status: 'open', details: issue.details, lastSeen: now, resolvedAt: null, resolvedBy: null })
        .where(eq(linkIssues.id, id));
    }
    for (const ids of chunk(changes.toResolve, CHUNK)) {
      await tx.update(linkIssues).set({ status: 'resolved', resolvedAt: now }).where(inArray(linkIssues.id, ids));
    }

    return {
      status: 'success',
      stats: {
        linksCreated: toCreate.length,
        linksClosed: toClose.length,
        activeLinks: plan.links.length,
        issuesOpened: changes.toInsert.length + changes.toReopen.length,
        issuesResolved: changes.toResolve.length,
        customerLinks: derived.length,
      },
    } satisfies JobResult;
  });
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/worker`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): add link-run job persisting links, customer links and issues

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: `drms-snapshot` job

**Files:**
- Create: `apps/worker/src/jobs/drms-snapshot.ts`
- Test: `apps/worker/src/jobs/drms-snapshot.test.ts`

**Interfaces:**
- Consumes: `DrmsClient`, `DrmsLatestCounters`, `DrmsCounter` (Task 6); `counterSnapshots`, `counterValues`, `counterNames`, `drmsEquipment`, `Db` (Task 3); `JobResult` (Task 8); `startOfUtcDay` (Task 8); `mapPool`, `chunk`, `parseApiDate`, `ErrorCollector`, `RateLimitError`, `AuthError`, `errorMessage` (Task 1); `seedDrms` (Task 11)
- Produces:
  - `flattenCounters(c: DrmsLatestCounters): FlatCounter[]`, where `interface FlatCounter { itemNumber: string | null; name: string; value: number | null; colorMode: string | null; mode: string | null }`
  - `saveSnapshot(db: Db, drmsId: string, c: DrmsLatestCounters, fetchedAt: Date): Promise<boolean>` (true if a new snapshot was inserted)
  - `runDrmsSnapshot(deps: { db: Db; drms: Pick<DrmsClient, 'latestCounters'>; now?: () => Date; concurrency?: number }): Promise<JobResult>`

Behaviour:
- Devices to fetch: `upper(status) in ('REGISTERED', 'DISCOVERED')` (Discovered is most of the fleet; PreRegistered has no CSRC connection yet), `missingSince is null`, and (`lastSnapshotFetchAt is null` or `< startOfUtcDay(now)`), ordered by `drmsId`.
- For each device, in a pool (default concurrency 5):
  - Call `latestCounters`. `null` (no counters yet, e.g. a Discovered device's 404) → `stats.empty++`.
  - Otherwise `saveSnapshot`: inserted → `stats.inserted++`, else `stats.unchanged++`.
  - Then set `lastSnapshotFetchAt = now()`.
- `RateLimitError` or `AuthError` → remember it and stop picking new devices. Any other error → `ErrorCollector.add(drmsId, err)`, and don't update `lastSnapshotFetchAt`, so a rerun retries that device.
- `saveSnapshot` runs in one transaction:
  - Insert the snapshot `onConflictDoNothing` on (device, counterId), returning the id. No row → false.
  - Insert the flattened values in chunks of 500.
  - Upsert `counter_names` (deduped by name, using the first value), updating `sampleValue` and `updatedAt`. `category` is never touched.
- Status: stopped → `partial` with `errorSample = 'stopped: ' + errorMessage(stopErr)`. Else errors → `partial` with `errorCollector.sample`. Else `success`.
- Stats: `devices`, `inserted`, `unchanged`, `empty`, `errors`, `skippedAfterStop` (devices never attempted).

- [ ] **Step 1: Write the failing tests**

`apps/worker/src/jobs/drms-snapshot.test.ts`:
```ts
import { RateLimitError } from '@mps/core';
import { counterNames, counterSnapshots, counterValues, drmsEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsLatestCounters } from '@mps/drms';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms } from '../test-helpers';
import { flattenCounters, runDrmsSnapshot } from './drms-snapshot';

const counters = (counterId: string, black = 58): DrmsLatestCounters => ({
  Id: 'x',
  CounterId: counterId,
  ReceivedTime: '2026-09-17 01:30:00',
  Counters: [
    { ItemNumber: 1, Name: 'BlackTonerLevel', Value: black },
    { ItemNumber: 2, Name: 'A3COPIERCOLOR', Value: '1234' },
  ],
  ModeSizeCounters: [
    { ColorMode: 'FullColor', Mode: 'CopyMode', Counters: [{ ItemNumber: '3', Name: 'A4 SEF Full', Value: 'n/a' }] },
  ],
});

describe('flattenCounters', () => {
  it('flattens plain and mode-size counters, coercing values', () => {
    expect(flattenCounters(counters('c1'))).toEqual([
      { itemNumber: '1', name: 'BlackTonerLevel', value: 58, colorMode: null, mode: null },
      { itemNumber: '2', name: 'A3COPIERCOLOR', value: 1234, colorMode: null, mode: null },
      { itemNumber: '3', name: 'A4 SEF Full', value: null, colorMode: 'FullColor', mode: 'CopyMode' },
    ]);
    expect(flattenCounters({ CounterId: 'c', Counters: null, ModeSizeCounters: null })).toEqual([]);
  });
});

describe('runDrmsSnapshot', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await seedDrms(t.db, [
      { drmsId: 'd1' },
      { drmsId: 'd2', status: 'registered' },
      { drmsId: 'd3', status: 'PreRegistered' },
      { drmsId: 'd4', missingSince: new Date() },
      { drmsId: 'd5', status: 'Discovered' },
    ]);
  });
  afterEach(() => t.close());

  const day = (iso: string) => () => new Date(iso);

  it('stores snapshots, values and counter names for registered and discovered present devices', async () => {
    const asked: string[] = [];
    const drms = { latestCounters: async (id: string) => (asked.push(id), counters(`${id}-c1`)) };
    const result = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });

    expect(asked).toEqual(['d1', 'd2', 'd5']);
    expect(result).toMatchObject({ status: 'success', stats: { devices: 3, inserted: 3, unchanged: 0, errors: 0 } });
    expect(await t.db.select().from(counterSnapshots)).toHaveLength(3);
    expect(await t.db.select().from(counterValues)).toHaveLength(9);
    const names = await t.db.select().from(counterNames);
    expect(names.map((n) => n.name).sort()).toEqual(['A3COPIERCOLOR', 'A4 SEF Full', 'BlackTonerLevel']);
    const [snap] = await t.db.select().from(counterSnapshots).where(eq(counterSnapshots.drmsEquipmentId, 'd1'));
    expect(snap?.receivedTime?.toISOString()).toBe('2026-09-17T01:30:00.000Z');
  });

  it('skips devices already fetched today and dedupes an unchanged CounterId next day', async () => {
    const drms = { latestCounters: async (id: string) => counters(`${id}-c1`) };
    await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });

    const sameDay = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T09:00:00Z'), concurrency: 1 });
    expect(sameDay.stats.devices).toBe(0);

    const nextDay = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-18T06:00:00Z'), concurrency: 1 });
    expect(nextDay.stats).toMatchObject({ devices: 3, inserted: 0, unchanged: 3 });
    expect(await t.db.select().from(counterSnapshots)).toHaveLength(3);
  });

  it('keeps a user-set counter category when the name is seen again', async () => {
    const drms = { latestCounters: async (id: string) => counters(`${id}-c1`) };
    await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });
    await t.db.update(counterNames).set({ category: 'supply' }).where(eq(counterNames.name, 'BlackTonerLevel'));
    const drms2 = { latestCounters: async (id: string) => counters(`${id}-c2`, 12) };
    await runDrmsSnapshot({ db: t.db, drms: drms2, now: day('2026-09-18T06:00:00Z'), concurrency: 1 });
    const [row] = await t.db.select().from(counterNames).where(eq(counterNames.name, 'BlackTonerLevel'));
    expect(row).toMatchObject({ category: 'supply', sampleValue: 12 });
  });

  it('stops on RateLimitError, reports partial, and leaves the rest for a resume', async () => {
    let calls = 0;
    const drms = {
      latestCounters: async (id: string) => {
        calls++;
        if (id === 'd1') throw new RateLimitError('429', new Date());
        return counters(`${id}-c1`);
      },
    };
    const result = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });
    expect(calls).toBe(1);
    expect(result.status).toBe('partial');
    expect(result.errorSample).toContain('stopped: RateLimitError');
    expect(result.stats.skippedAfterStop).toBe(2);
    const rows = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'd2'));
    expect(rows[0]?.lastSnapshotFetchAt).toBeNull();
  });

  it('counts per-device errors without stopping and retries them next run', async () => {
    const drms = {
      latestCounters: async (id: string) => {
        if (id === 'd1') throw new Error('bad payload');
        return counters(`${id}-c1`);
      },
    };
    const result = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });
    expect(result).toMatchObject({ status: 'partial', stats: { errors: 1, inserted: 2 } });
    expect(result.errorSample).toContain('d1: Error: bad payload');

    const retry = await runDrmsSnapshot({ db: t.db, drms: { latestCounters: async (id: string) => counters(`${id}-c1`) }, now: day('2026-09-17T07:00:00Z'), concurrency: 1 });
    expect(retry.stats).toMatchObject({ devices: 1, inserted: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/worker/src/jobs/drms-snapshot.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`apps/worker/src/jobs/drms-snapshot.ts`:
```ts
import {
  AuthError,
  ErrorCollector,
  RateLimitError,
  chunk,
  errorMessage,
  mapPool,
  parseApiDate,
} from '@mps/core';
import { counterNames, counterSnapshots, counterValues, drmsEquipment, type Db } from '@mps/db';
import type { DrmsClient, DrmsCounter, DrmsLatestCounters } from '@mps/drms';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';
import { startOfUtcDay } from '../time';

const CHUNK = 500;

export interface FlatCounter {
  itemNumber: string | null;
  name: string;
  value: number | null;
  colorMode: string | null;
  mode: string | null;
}

function toNumber(v: DrmsCounter['Value']): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function flattenCounters(c: DrmsLatestCounters): FlatCounter[] {
  const flat = (x: DrmsCounter, colorMode: string | null, mode: string | null): FlatCounter => ({
    itemNumber: x.ItemNumber == null ? null : String(x.ItemNumber),
    name: x.Name,
    value: toNumber(x.Value),
    colorMode,
    mode,
  });
  const out = (c.Counters ?? []).map((x) => flat(x, null, null));
  for (const group of c.ModeSizeCounters ?? []) {
    for (const x of group.Counters ?? []) out.push(flat(x, group.ColorMode ?? null, group.Mode ?? null));
  }
  return out;
}

export async function saveSnapshot(db: Db, drmsId: string, c: DrmsLatestCounters, fetchedAt: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .insert(counterSnapshots)
      .values({
        drmsEquipmentId: drmsId,
        counterId: c.CounterId,
        receivedTime: parseApiDate(c.ReceivedTime),
        fetchedAt,
        raw: c,
      })
      .onConflictDoNothing({ target: [counterSnapshots.drmsEquipmentId, counterSnapshots.counterId] })
      .returning({ id: counterSnapshots.id });
    if (!snap) return false;

    const values = flattenCounters(c);
    for (const rows of chunk(values, CHUNK)) {
      await tx.insert(counterValues).values(rows.map((v) => ({ ...v, snapshotId: snap.id })));
    }

    const firstByName = new Map<string, FlatCounter>();
    for (const v of values) if (!firstByName.has(v.name)) firstByName.set(v.name, v);
    for (const rows of chunk([...firstByName.values()], CHUNK)) {
      await tx
        .insert(counterNames)
        .values(rows.map((v) => ({ name: v.name, firstSeen: fetchedAt, sampleValue: v.value, updatedAt: fetchedAt })))
        .onConflictDoUpdate({
          target: counterNames.name,
          set: { sampleValue: sql.raw('excluded."sample_value"'), updatedAt: fetchedAt },
        });
    }
    return true;
  });
}

export interface DrmsSnapshotDeps {
  db: Db;
  drms: Pick<DrmsClient, 'latestCounters'>;
  now?: () => Date;
  concurrency?: number;
}

export async function runDrmsSnapshot(deps: DrmsSnapshotDeps): Promise<JobResult> {
  const { db, drms } = deps;
  const now = deps.now ?? (() => new Date());
  const dayStart = startOfUtcDay(now());

  const devices = await db
    .select({ drmsId: drmsEquipment.drmsId })
    .from(drmsEquipment)
    .where(
      and(
        sql`upper(${drmsEquipment.status}) in ('REGISTERED', 'DISCOVERED')`,
        isNull(drmsEquipment.missingSince),
        or(isNull(drmsEquipment.lastSnapshotFetchAt), lt(drmsEquipment.lastSnapshotFetchAt, dayStart)),
      ),
    )
    .orderBy(asc(drmsEquipment.drmsId));

  const stats = { devices: devices.length, inserted: 0, unchanged: 0, empty: 0, errors: 0, skippedAfterStop: 0 };
  const errors = new ErrorCollector();
  let stopError: unknown = null;
  let attempted = 0;

  await mapPool(
    devices,
    deps.concurrency ?? 5,
    async ({ drmsId }) => {
      attempted++;
      try {
        const counters = await drms.latestCounters(drmsId);
        if (!counters) stats.empty++;
        else if (await saveSnapshot(db, drmsId, counters, now())) stats.inserted++;
        else stats.unchanged++;
        await db.update(drmsEquipment).set({ lastSnapshotFetchAt: now() }).where(eq(drmsEquipment.drmsId, drmsId));
      } catch (err) {
        if (err instanceof RateLimitError || err instanceof AuthError) {
          stopError ??= err;
          return;
        }
        errors.add(drmsId, err);
      }
    },
    () => stopError !== null,
  );

  stats.errors = errors.count;
  stats.skippedAfterStop = devices.length - attempted;
  if (stopError) {
    return { status: 'partial', stats, errorSample: `stopped: ${errorMessage(stopError)}` };
  }
  return { status: errors.count > 0 ? 'partial' : 'success', stats, errorSample: errors.sample };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/worker`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): add drms-snapshot job with dedupe and resume

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Worker entrypoint (pg-boss wiring) + local run

**Files:**
- Create: `apps/worker/src/main.ts`, `apps/worker/src/handlers.ts`
- Test: `apps/worker/src/handlers.test.ts`

**Interfaces:**
- Consumes: everything above; `createDb`, `ensureAdminUser`, `setAppState` (Task 3); `runMigrations` (`@mps/db/migrate`); `createDrmsClient`, `decodeJwtExpiry` (Task 6); `createVantageClient` (Task 7); `QUEUES`, `createBoss` (Task 8); `loadEnv`, `withSyncRun`, `failStaleRuns`, `isSundayIn` (Task 8); the job run functions (Tasks 9–12)
- Produces:
  - `buildHandlers(deps: HandlerDeps): Record<QueueName, (data: { full?: boolean }) => Promise<void>>`, where `interface HandlerDeps { db: Db; drms: DrmsClient; vantage: VantageClient; linkConfig: LinkConfig; tz: string; queueLinkRun: () => Promise<unknown>; now?: () => Date }`
  - App state key `drms_token_expiry` (ISO string or null), read by the web dashboard in Part 2.

Behaviour:
- Each handler wraps its job in `withSyncRun(db, queueName, …)`.
- vantage-pull: `full = data.full === true || isSundayIn(tz, now())`, then `queueLinkRun()`.
- drms-pull: after the run, `queueLinkRun()`.
- link-run and drms-snapshot: just run.
- `queueLinkRun` is also called when a pull throws? **No**: only after it completes (partial counts as complete).

- [ ] **Step 1: Write the failing test**

`apps/worker/src/handlers.test.ts`:
```ts
import { syncRuns } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsClient } from '@mps/drms';
import type { VantageClient } from '@mps/vantage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHandlers } from './handlers';
import { drmsDevice, fakeVantage } from './test-helpers';

describe('buildHandlers', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  function setup(now: Date) {
    const vantage = fakeVantage([], []);
    let linkRunsQueued = 0;
    const drms = {
      listEquipment: async () => [drmsDevice('g1')],
      listCustomers: async () => [],
      latestCounters: async () => null,
      testAuth: async () => 'Ok',
    } as DrmsClient;
    const handlers = buildHandlers({
      db: t.db,
      drms,
      vantage: vantage.client as unknown as VantageClient,
      linkConfig: { erpIdField: 'id', customerErpField: 'reference' },
      tz: 'Europe/London',
      queueLinkRun: async () => {
        linkRunsQueued++;
      },
      now: () => now,
    });
    return { handlers, vantage, queued: () => linkRunsQueued };
  }

  it('records runs and queues link-run after pulls', async () => {
    const { handlers, queued } = setup(new Date('2026-09-17T02:00:00Z'));
    await handlers['drms-pull']({});
    await handlers['vantage-pull']({});
    await handlers['link-run']({});
    await handlers['drms-snapshot']({});
    expect(queued()).toBe(2);
    const runs = await t.db.select().from(syncRuns);
    expect(runs.map((r) => [r.job, r.status])).toEqual([
      ['drms-pull', 'success'],
      ['vantage-pull', 'success'],
      ['link-run', 'success'],
      ['drms-snapshot', 'success'],
    ]);
  });

  it('forces a full vantage pull on Sundays (London time)', async () => {
    const { handlers, vantage } = setup(new Date('2026-09-20T01:00:00Z'));
    await t.db.insert(syncRuns).values({ job: 'vantage-pull', status: 'success', startedAt: new Date('2026-09-19T01:00:00Z') });
    await handlers['vantage-pull']({});
    expect(vantage.calls[0]?.opts).toEqual({ includeDeleted: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/worker/src/handlers.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement handlers and main**

`apps/worker/src/handlers.ts`:
```ts
import type { LinkConfig } from '@mps/core';
import type { Db } from '@mps/db';
import type { DrmsClient } from '@mps/drms';
import { QUEUES, type QueueName } from '@mps/queue';
import type { VantageClient } from '@mps/vantage';
import { runDrmsPull } from './jobs/drms-pull';
import { runDrmsSnapshot } from './jobs/drms-snapshot';
import { runLinkRun } from './jobs/link-run';
import { runVantagePull } from './jobs/vantage-pull';
import { withSyncRun } from './sync-runs';
import { isSundayIn } from './time';

export interface HandlerDeps {
  db: Db;
  drms: DrmsClient;
  vantage: VantageClient;
  linkConfig: LinkConfig;
  tz: string;
  queueLinkRun: () => Promise<unknown>;
  now?: () => Date;
}

export type JobData = { full?: boolean };

export function buildHandlers(deps: HandlerDeps): Record<QueueName, (data: JobData) => Promise<void>> {
  const { db, drms, vantage, linkConfig, tz, queueLinkRun } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    [QUEUES.vantagePull]: async (data) => {
      const full = data.full === true || isSundayIn(tz, now());
      await withSyncRun(db, QUEUES.vantagePull, () => runVantagePull({ db, vantage, now }, { full }));
      await queueLinkRun();
    },
    [QUEUES.drmsPull]: async () => {
      await withSyncRun(db, QUEUES.drmsPull, () => runDrmsPull({ db, drms, now }));
      await queueLinkRun();
    },
    [QUEUES.linkRun]: async () => {
      await withSyncRun(db, QUEUES.linkRun, () => runLinkRun({ db, config: linkConfig, now }));
    },
    [QUEUES.drmsSnapshot]: async () => {
      await withSyncRun(db, QUEUES.drmsSnapshot, () => runDrmsSnapshot({ db, drms, now }));
    },
  };
}
```

`apps/worker/src/main.ts`:
```ts
import { createDb, ensureAdminUser, setAppState } from '@mps/db';
import { runMigrations } from '@mps/db/migrate';
import { createDrmsClient, decodeJwtExpiry } from '@mps/drms';
import { QUEUES, createBoss, type QueueName } from '@mps/queue';
import { createVantageClient } from '@mps/vantage';
import { loadEnv } from './env';
import { buildHandlers, type JobData } from './handlers';
import { failStaleRuns } from './sync-runs';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);

  await runMigrations(db);
  const stale = await failStaleRuns(db);
  if (stale > 0) console.warn(`[worker] marked ${stale} stale run(s) as failed`);
  if (env.ADMIN_PASSWORD && (await ensureAdminUser(db, env.ADMIN_USERNAME, env.ADMIN_PASSWORD))) {
    console.log(`[worker] created admin user "${env.ADMIN_USERNAME}"`);
  }
  await setAppState(db, 'drms_token_expiry', decodeJwtExpiry(env.DRMS_TOKEN)?.toISOString() ?? null);

  const drms = createDrmsClient({ baseUrl: env.DRMS_BASE_URL, token: env.DRMS_TOKEN });
  const vantage = createVantageClient({
    baseUrl: env.VANTAGE_BASE_URL,
    username: env.VANTAGE_USER,
    password: env.VANTAGE_PASS,
    apiVersion: env.VANTAGE_API_VERSION,
  });

  const boss = createBoss(env.DATABASE_URL, 'worker');
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();

  for (const name of Object.values(QUEUES)) {
    await boss.createQueue(name, { name, policy: 'stately', retryLimit: 0 });
  }
  const tz = env.TZ_SCHEDULE;
  await boss.schedule(QUEUES.vantagePull, '0 2 * * *', {}, { tz });
  await boss.schedule(QUEUES.drmsPull, '15 2 * * *', {}, { tz });
  await boss.schedule(QUEUES.drmsSnapshot, env.SNAPSHOT_CRON, {}, { tz });

  const handlers = buildHandlers({
    db,
    drms,
    vantage,
    linkConfig: { erpIdField: env.LINK_ERP_ID_FIELD, customerErpField: env.LINK_CUSTOMER_ERP_FIELD },
    tz,
    queueLinkRun: () => boss.send(QUEUES.linkRun, {}, { startAfter: 120 }),
  });

  for (const [name, handler] of Object.entries(handlers) as [QueueName, (d: JobData) => Promise<void>][]) {
    await boss.work<JobData>(name, async ([job]) => {
      console.log(`[worker] ${name} started`);
      await handler(job?.data ?? {});
      console.log(`[worker] ${name} finished`);
    });
  }
  console.log('[worker] ready');

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, stopping`);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS, and lint shows no errors (fix any it reports).

- [ ] **Step 5: Local smoke run (needs Postgres + `.env`)**

Prerequisite: a running Postgres. Either `docker compose -f docker-compose.dev.yml up -d` (Docker Desktop) or a local Postgres 17 with the `mps` user/db. Docker isn't on PATH on the dev machine as of 2026-09-17, so ask the user which option to use.
Run: `npm run dev -w @mps/worker`
Expected: log lines `[worker] ready`, no fatal error, and the tables exist (`psql $DATABASE_URL -c '\dt'`).
Trigger jobs manually from a second shell:
```bash
npx tsx --env-file=.env -e "import {createBoss,QUEUES} from '@mps/queue'; const b=createBoss(process.env.DATABASE_URL!,'client'); await b.start(); await b.send(QUEUES.drmsPull,{}); await b.send(QUEUES.vantagePull,{full:true}); await b.stop();"
```
Expected: the worker logs both jobs finishing, `link-run` runs ~2 min later, and `select job,status,stats from sync_runs order by id` shows success/partial rows with plausible counts. Then send `QUEUES.drmsSnapshot` and check `counter_snapshots` rows.
If this can't be run (no DB/creds), say so in the task report. Don't claim it passed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker): wire pg-boss schedules and job handlers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Part 1 done criteria

- `npm test`, `npm run typecheck`, `npm run lint` all green.
- The worker starts, migrates, schedules and runs all four jobs against real or QA APIs (Task 13 Step 5), or the report explicitly says what couldn't be verified.
- Part 2 (`2026-09-17-foundation-part2-web-deploy.md`) covers: the Next.js web app (login, dashboard, devices, link issues, counter names, users, manual job triggers) and the Dockerfiles, compose file and Portainer deploy.
