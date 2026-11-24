# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

**MPS brain** for BGB – Elmdale Maintenance (a Konica Minolta MPS dealer). It's a web app and worker that sit between **Vantage Online** (ERP) and **KM DRMS3/CSRC** (device monitoring) to automate toner replenishment, site stock, notifications and meter sync.

Built as 5 sub-projects. Each one gets a spec in `docs/superpowers/specs/` and a plan in `docs/superpowers/plans/`:
1. **Foundation** (in progress): DB, DRMS↔Vantage device/customer linking, nightly counter snapshots
2. Meter sync DRMS → Vantage
3. Replenishment engine + operator review queue (approvals are tracked against sales orders people raise by hand in Vantage)
4. Site stock tracking
5. Notifications

**Resuming work? Read `docs/HANDOFF.md` first.** It has the latest state, next steps and the DRMS registration batch process.

Read the current spec and plan before changing anything. Plans use `- [ ]` checkboxes, so tick them off as tasks land.

API reference docs (not in this repo): `F:\dev\API Docs Etc` (Vantage docs, DRMS3 spec PDF, the dealer's DRMS docx). Its `CLAUDE.md` explains how to extract the PDF and docx text. **Never read or copy `API Keys.txt`, or the JWT inside the docx.**

## Commands

```bash
npm test                               # Vitest, all packages (DB tests use in-process PGlite, no Docker needed)
npx vitest run packages/core           # one package
npx vitest run apps/worker/src/jobs/link-run.test.ts   # one file
npx vitest run -t "creates links"      # one test by name
npm run typecheck                      # tsc --noEmit in every workspace
npm run lint
npm run dev -w @mps/worker             # worker with .env (needs Postgres)
cd packages/db && npx drizzle-kit generate --name <change>   # after editing schema.ts; commit drizzle/
npx tsx --env-file=.env scripts/phase0-spike.ts            # read-only API discovery
```

Local Postgres: a native **PostgreSQL 17** Windows service (`postgresql-x64-17`, port 5432) with database and role `mps`. Credentials are in `.env` (`DATABASE_URL`, `PG_SUPERUSER_PASSWORD`). psql is at `C:\Program Files\PostgreSQL\17\bin\psql.exe` and isn't on PATH. Docker isn't installed, so `docker-compose.dev.yml` is only for machines that have it.

## Architecture

npm-workspaces TypeScript monorepo, ESM. Packages export `./src/index.ts` directly (no build step). The worker runs under `tsx`, and Next.js transpiles the packages.

```
packages/core     pure logic: field helpers, errors, linking rules, issue reconciliation (no I/O)
packages/db       Drizzle schema + migrations; subpaths @mps/db/migrate, @mps/db/testing
packages/drms     DRMS3 v8 client (per-method throttle, 429 cooldown); reads, plus the one Register POST
packages/vantage  Vantage OData client (login/reissue, paging, deleted filter)
packages/queue    pg-boss queue names + createBoss
apps/worker       pg-boss schedules → jobs in src/jobs/*, each wrapped in withSyncRun
apps/web          Next.js UI (Foundation Part 2)
```

Data flow: `vantage-pull` and `drms-pull` upsert raw records, then each queues `link-run` (+120 s), which computes links and issues in `@mps/core` and persists them. `drms-snapshot` stores `LatestCounters` for each Registered or Discovered device (most of the fleet is Discovered; there is no production DRMS access, KM controls it), deduped on `(device, CounterId)`. Every job writes a `sync_runs` row.

PM planner (`/pm/planner`, migrations `0021`-`0023`): `vantage-schedule` (`*/30 6-19 * * *`) copies engineers' booked calls for today/tomorrow into `vantage_scheduled_units`, `vantage-engineers` (nightly) copies engineer names, and `postcode-lookup` (nightly, 100 districts per run) caches outward-code county and centroid in `postcode_districts`. After a first deploy, use *Run now* on `postcode-lookup` until every district is cached. The planner opens on the Map (`/pm/planner`, or `?view=map`); the Board is `/pm/planner?view=board`, with columns PMs in area → Planned → Booked (no Asked engineer or Done column; Done cards are hidden, and `pm_plan.board_column` still stores to_plan/asked/done). The Map reads the same data (`loadMapPins`, `loadUpcoming`), writes only `pm_plan` (+ audit) through `map-actions.ts`, and adds no jobs. Its only outside request is map tiles from OpenStreetMap.

Job functions take injected deps (`db`, the client, `now`) and return a `JobResult`. Test them against `createTestDb()` with fake clients, never live APIs.

## Rules that aren't obvious from the code

- **DRMS is read-only except for one approved write.** The only DRMS write is `POST EquipmentRequest/Register` (plus reading `EquipmentRequest/{id}` and `Equipment/{id}` around it), made **only** by the `drms-registration-submit` worker job, **only** for rows a person approved on `/registrations`. It sends one device at a time with `AUTO_REGISTER_PAUSE_SECONDS` (90) between registrations and at most `AUTO_REGISTER_MAX_PER_RUN` (40) per run, never retries the POST, never re-sends a row that has a request id (it only polls it), records a 5xx/timeout/interrupted send as failed for a person to check, and stops the run on a 429 or auth error. No other `EquipmentRequest/*` call (Edit, Delete) exists; the web app and every other job never write to DRMS. The nightly `drms-registration-scan` only fills the approval queue (it reads our DRMS copy and Vantage).
- **Vantage is read-only. The app never places an order.** `packages/vantage` has no write call. People raise toner orders by hand in Vantage; *Approve* on `/orders` only records the intent and queues the order. The `vantage-orders` worker job pulls sales orders hourly, and its watcher (`matchSalesOrders` in `packages/db/src/queries/order-watch.ts`) moves queued orders on when the sales order shows up. Match rules: same Vantage equipment and colour; the sales order's date is on or after the approval day minus 2 (people sometimes raise it first); one sales-order line closes one proposal; a site-stock top-up matches a line for any device on its shelf; a partly matched order stays *In progress* until every colour has a line. A person can also use *Mark ordered* (types the reference), *Back to review* or *Delete* on a queued order. `replenishment_orders.request` is still written on approval (the column is NOT NULL) but nothing sends it.
- **DRMS rate limits are per method** (2,000/min, 100,000/h). We throttle at 1,000/min. **Never retry a 429**, because retrying extends the block. The cooldown is 10 min.
- DRMS has no "changed since" filter and no bulk counters endpoint. It collects counters **nightly** and only exposes the latest, which is why we keep our own snapshot history.
- DRMS auth is a static bearer JWT (no login). Its expiry is saved to `app_state.drms_token_expiry`.
- Vantage: send `api-version` on **every** call. Soft deletes aren't filtered automatically, so the client adds `deleteddate eq null`. Tokens last 30 min, and the client reissues when less than 5 min is left.
- Vantage field casing varies (docs vs samples), so read API records with `getField/getString/getNumber` (case-insensitive).
- **Manual links are never overwritten** by auto-linking. Link issues are keyed by `type|drmsId|vantageId`: `ignored` stays ignored, and auto issues resolve themselves.
- Phase 0 (see spec): DRMS `ErpId` = Vantage `Equipment.Id` when set (mostly empty or a copy of the serial, so serial is the main key). `CustomerErpId` is a DRMS-side `CUST
- Keep the full API payload in `raw jsonb` on synced rows, since later sub-projects need fields we haven't modelled.
- Dealer fixed values (for later registration work): `GB500`, `OFC580`, COM servers in use: **`COM_GB502` and `COM_GB503`** (not GB501). Almost every device is configured by hand to connect straight to CSRC; a handful go through the DCA (`DEFCNTCOM_GB500`).
- **postcodes.io is the one other external dependency** (read-only, no key): `postcode-lookup` sends outward codes only (e.g. `GU14`), never full postcodes or customer data. The worker must be able to reach `api.postcodes.io` (`POSTCODES_BASE_URL`).
- Secrets only come from env (`.env` locally, Portainer stack env in prod). Never log tokens, and never commit `.env` or `fixtures/raw/`.

## Deploy target

Docker stack (`web`, `worker`, `postgres`) managed through Portainer. Details are in Foundation Part 2.
