# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

**MPS brain** for BGB – Elmdale Maintenance (a Konica Minolta MPS dealer). It's a web app and worker that sit between **Vantage Online** (ERP) and **KM DRMS3/CSRC** (device monitoring) to automate toner replenishment, site stock, notifications and meter sync.

Built as 5 sub-projects. Each one gets a spec in `docs/superpowers/specs/` and a plan in `docs/superpowers/plans/`:
1. **Foundation** (in progress): DB, DRMS↔Vantage device/customer linking, nightly counter snapshots
2. Meter sync DRMS → Vantage
3. Replenishment engine + operator review queue → Vantage sales order
4. Site stock tracking
5. Notifications

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
packages/drms     DRMS3 v8 read-only client (per-method throttle, 429 cooldown)
packages/vantage  Vantage OData client (login/reissue, paging, deleted filter)
packages/queue    pg-boss queue names + createBoss
apps/worker       pg-boss schedules → jobs in src/jobs/*, each wrapped in withSyncRun
apps/web          Next.js UI (Foundation Part 2)
```

Data flow: `vantage-pull` and `drms-pull` upsert raw records, then each queues `link-run` (+120 s), which computes links and issues in `@mps/core` and persists them. `drms-snapshot` stores `LatestCounters` for each Registered device, deduped on `(device, CounterId)`. Every job writes a `sync_runs` row.

Job functions take injected deps (`db`, the client, `now`) and return a `JobResult`. Test them against `createTestDb()` with fake clients, never live APIs.

## Rules that aren't obvious from the code

- **DRMS is read-only** until a later sub-project says otherwise. No `EquipmentRequest/*` calls.
- **DRMS rate limits are per method** (2,000/min, 100,000/h). We throttle at 1,000/min. **Never retry a 429**, because retrying extends the block. The cooldown is 10 min.
- DRMS has no "changed since" filter and no bulk counters endpoint. It collects counters **nightly** and only exposes the latest, which is why we keep our own snapshot history.
- DRMS auth is a static bearer JWT (no login). Its expiry is saved to `app_state.drms_token_expiry`.
- Vantage: send `api-version` on **every** call. Soft deletes aren't filtered automatically, so the client adds `deleteddate eq null`. Tokens last 30 min, and the client reissues when less than 5 min is left.
- Vantage field casing varies (docs vs samples), so read API records with `getField/getString/getNumber` (case-insensitive).
- **Manual links are never overwritten** by auto-linking. Link issues are keyed by `type|drmsId|vantageId`: `ignored` stays ignored, and auto issues resolve themselves.
- What DRMS `ErpId` and `CustomerErpId` hold is set by config (`LINK_ERP_ID_FIELD`, `LINK_CUSTOMER_ERP_FIELD`). Phase 0 findings go in the spec.
- Keep the full API payload in `raw jsonb` on synced rows, since later sub-projects need fields we haven't modelled.
- Dealer fixed values (for later registration work): `GB500`, `OFC580`, COM servers `COM_GB501/502/503`, DCA `DEFCNTCOM_GB500`.
- Secrets only come from env (`.env` locally, Portainer stack env in prod). Never log tokens, and never commit `.env` or `fixtures/raw/`.

## Deploy target

Docker stack (`web`, `worker`, `postgres`) managed through Portainer. Details are in Foundation Part 2.
