# MPS Brain — Sub-project 1: Foundation

> Status: approved 2026-09-17. Field names verified against the docs (DRMS spec v1.7.0 page refs, Vantage doc line refs). Nothing has been built yet.

## Context

BGB – Elmdale Maintenance (a Konica Minolta MPS reseller) wants an "MPS brain" web app between **Vantage Online** (ERP) and **KM DRMS3/CSRC** (device monitoring) to automate toner replenishment, track site stock, send notifications and sync meters. The idea is split into 5 sub-projects:
1. **Foundation** (this plan): DB, DRMS ↔ Vantage device/customer linking, nightly counter snapshots
2. Meter sync DRMS → Vantage
3. Replenishment engine + operator review queue → Vantage sales order
4. Site stock tracking
5. Notifications

Sub-projects 2–5 all need the Foundation. DRMS only exposes the **latest** counters (the history endpoint is TBD, p.43) and has no "toner replaced" event. So the Foundation must build its own reliable snapshot history and a trusted device link, and later sub-projects work out replacements and usage from those.

## Decisions (agreed with user)

| Topic | Decision |
|---|---|
| Root folder | `C:\dev\mps-brain`: own git repo, separate from the docs folder (`F:\dev\API Docs Etc`) |
| Hosting | Local first, then a Docker stack in **Portainer** |
| DB | PostgreSQL |
| Stack | TypeScript full-stack |
| Architecture | One repo; containers `web` (Next.js UI + API), `worker` (jobs), `postgres`. Queue/scheduler = **pg-boss** (in Postgres, no Redis) |
| DRMS scope | **Read + link only.** No Register/Edit/Delete |
| Fleet | 500–3,000 devices |
| Login | Local accounts (argon2 hashes in Postgres, admin creates users) |
| Auto-linking | **All automatic** (ERP ID or exact serial). Only no-match or conflicts go to the operator queue |
| Existing state | Mixed: some DRMS devices have ERP IDs, some don't, some aren't registered |

## Repo layout

```
C:\dev\mps-brain/
  apps/web/          Next.js (App Router): pages + route handlers, session auth
  apps/worker/       pg-boss schedules + job handlers
  packages/db/       Drizzle ORM schema, migrations, seed (admin user)
  packages/drms/     DRMS3 v8 client
  packages/vantage/  Vantage OData client
  packages/core/     Pure logic: linking, normalisation, snapshot diff helpers
  fixtures/          Recorded API responses (secrets scrubbed) for tests
  docker-compose.yml web, worker, postgres (+ named volume)
  .env.example       DRMS_BASE_URL, DRMS_TOKEN, VANTAGE_BASE_URL, VANTAGE_USER, VANTAGE_PASS, VANTAGE_API_VERSION, DATABASE_URL, SESSION_SECRET
  docs/superpowers/specs/2026-09-17-mps-foundation-design.md   (copy of this plan)
```
npm workspaces, Vitest, ESLint + Prettier. `.gitignore` covers `.env*`, `fixtures/raw/`.

## API clients

**packages/drms** (DRMS3 v8)
- Auth: a static bearer JWT from env (no login endpoint, p.8). On startup, decode `exp` and show a warning on the dashboard 14 days before expiry.
- `listEquipment()`: `GET Equipment` with `pageNo` loop. Stop when a page returns fewer than 1000 items.
- `listCustomers()`: `GET Customer?pageNo=`. The scope may be the "client" (p.56), so store it but don't depend on it.
- `latestCounters(id)`: `GET Equipment/{id}/LatestCounters`, all flags on.
- `testAuth()`: `GET Test/Auth`.
- **Throttle per method** at 1,000/min (half the limit). On a 429, stop all calls to that method for 10 min and don't retry sooner (retrying extends the block). No error body is documented, so errors are typed by HTTP status.

**packages/vantage**
- `POST /application/loginsingle` (Basic auth + `api-version`), which returns `Token` and `TokenExpiryDate`. Call `POST /application/reissue` when less than 5 min is left, and log in again on a 401.
- `api-version` is pinned from env (start at `1.22`) and sent on every call.
- A generic `odataList(entity, {filter, select, expand})` pages with `$top=500&$skip`, always adds `deleteddate eq null` (unless you ask for deleted records), and supports a `modifieddate gt X` incremental filter.
- `listCustomers(since?)`: `/customer` with `Id, Reference, Name, IsActive, IsOnStop, ExternalAccountNumber, ModifiedDate, DeletedDate`
- `listEquipment(since?)`: `/Equipment` with `Id, SerialNumber, AssetNumber, Description, Location, InstallDate, ModifiedDate, DeletedDate`, expanding `Item($select=PartNumber,Description)` and `Customer($select=Id,Reference,Name)`

## Data model (Drizzle / Postgres)

Every synced row keeps `raw jsonb` (the full payload) + `synced_at`.

- `users`: id, username, password_hash, role (`admin`/`operator`), active, created_at
- `vantage_customers`: vantage_id PK, reference, name, is_active, is_on_stop, modified_date, deleted_date
- `vantage_equipment`: vantage_id PK, serial, serial_norm, asset_number, description, item_part_number, vantage_customer_id, location, install_date, modified_date, deleted_date
- `drms_equipment`: drms_id (Guid) PK, erp_id, serial, serial_norm, model_name, product_name, status, communication_type, customer_erp_id, customer_name, customer_csrc_id, registration_time, initial_connection_time, last_counter_received_time, first_seen_at, last_seen_at, missing_since (set when a device disappears from `GET Equipment`)
- `drms_customers`: drms_id PK, erp_id, name, csrc_ids text[]
- `device_links`: id, drms_equipment_id (unique while active), vantage_equipment_id, method (`erp_id`/`serial`/`manual`), linked_by (null = auto), linked_at, unlinked_at
- `customer_links`: drms customer_erp_id ↔ vantage_customer_id, method (`derived`/`manual`), with derived = most common Vantage customer among linked devices
- `link_issues`: id, type (`no_match_drms`, `no_match_vantage`, `serial_ambiguous`, `erp_serial_disagree`, `customer_mismatch`, `link_broken`), drms_equipment_id?, vantage_equipment_id?, details jsonb, status (`open`/`resolved`/`ignored`), first_seen, last_seen, resolved_by/at. Unique on the open (type, drms, vantage) combination so re-runs don't create duplicates.
- `counter_snapshots`: id, drms_equipment_id, counter_id (DRMS `CounterId`), received_time (DRMS `ReceivedTime`), fetched_at, raw jsonb. **Unique (drms_equipment_id, counter_id)**, so a device with no new collection adds no row
- `counter_values`: snapshot_id, item_number, name, value numeric, color_mode?, mode? (flattened `Counters` + `ModeSizeCounters`). Index (name), (snapshot_id)
- `counter_names`: name PK, first_seen, sample_value, category (`meter`/`supply`/`other`/null). Found automatically; supply and meter classification (e.g. `BlackTonerLevel`) is edited in the UI. Needed by sub-projects 2–4
- `sync_runs`: id, job, started_at, finished_at, status, stats jsonb (fetched/inserted/updated/errors), error_sample text

## Linking rules (packages/core, pure functions)

Normalise serials with trim, upper case, and removing spaces and dashes.
1. **Manual links are never overwritten** by auto-linking.
2. **ERP ID:** DRMS `ErpId` equals the Vantage equipment key → link `erp_id`. Which Vantage field DRMS `ErpId` holds (`Id` vs `AssetNumber`) is set by the config `LINK_ERP_ID_FIELD`, which Phase 0 fills in.
3. **Serial:** exactly one active Vantage equipment has the same `serial_norm` → link `serial`.
   - 2+ Vantage matches → `serial_ambiguous` issue, no link.
4. The ERP ID match and the serial match point at different Vantage records → `erp_serial_disagree` issue. Keep the ERP ID link.
5. A DRMS device with no match (status Registered/PreRegistered) → `no_match_drms`. An active Vantage equipment with no DRMS device → `no_match_vantage` (report only, filterable, since many devices won't be monitored).
6. A linked Vantage equipment soft-deleted, or a DRMS device `Deleted`/missing → unlink + `link_broken` issue.
7. The linked device's DRMS `CustomerErpId` doesn't match the Vantage customer (via `customer_links` or `LINK_CUSTOMER_ERP_FIELD` = `Id`/`Reference`) → `customer_mismatch` issue. The link stays.
8. When the condition goes away, auto issues resolve themselves on the next run.

## Jobs (apps/worker, pg-boss, all singleton, all write `sync_runs`)

| Job | Schedule (Europe/London) | What |
|---|---|---|
| `vantage.pull` | 02:00 daily (incremental on `ModifiedDate`); Sun full refresh | upsert customers + equipment |
| `drms.pull` | 02:15 daily | full `GET Equipment` (no incremental filter exists) + `GET Customer`; set `missing_since` |
| `link.run` | after both pulls complete (chained) | apply linking rules, update issues |
| `drms.snapshot` | 06:00 daily (after DRMS nightly collection; time configurable) | `LatestCounters` for every `Registered` device, concurrency 5, throttle 1,000/min. Insert only a new `CounterId`. Upsert `counter_names`. Per-device errors are counted and don't stop the run. Resumable: devices already fetched today are skipped |

At 3,000 devices, one snapshot run is about 3–5 min, far under the limits. Every job can also be started from the UI (admin).

## UI (apps/web), Foundation only

- **Login** (iron-session cookie). Seed the admin from env on first run.
- **Dashboard:** last run for each job (status, counts, errors), link stats (linked by erp_id/serial/manual, unmatched, open issues), DRMS token expiry warning.
- **Devices:** a table joining DRMS + Vantage (serial, model, customer, DRMS status, link method, last counter time), with filters and search. The detail page shows both raw records, link history, and the latest snapshot with counter history (table).
- **Link issues queue:** filter by type. Actions: pick a Vantage equipment (search) → manual link, ignore, or unlink.
- **Counter names:** set the category for each counter name.
- **Users** (admin): create, disable, reset password.

Server-rendered tables (no heavy client state). Tailwind + shadcn/ui.

## Error handling

- Clients throw typed errors (`AuthError`, `RateLimitError`, `HttpError`, `ParseError`), and jobs catch them for each item.
- DRMS 429 → a job-wide cooldown for that method. The job stops early with `partial` status. It never hammers.
- A Vantage 401 → one re-login, then fail.
- Zod schemas check the fields we map. Unknown extra fields are kept in `raw`.
- Secrets only come from env / Portainer stack env. Never log tokens.

## Build order

0. **Phase 0 spike (read-only, throwaway script):** with real creds in local `.env` (user fills it in; the app never reads `API Keys.txt`), call QA DRMS `Test/Auth`, `Equipment` (page 1), `Customer`, and `LatestCounters` for ~5 devices, plus Vantage login, `$metadata`, and `/customer` + `/Equipment` with `$top=5`. Save scrubbed fixtures. Answer:
   - What does DRMS `ErpId` hold (Vantage `Id` or `AssetNumber`)? What does `CustomerErpId` hold (`Id` or `Reference`)?
   - The real counter names (waste toner? CMY levels?)
   - The Vantage `$top` cap, the customer foreign key on Equipment in `$metadata`, and the JWT `exp`
   - Record the answers in the spec.
1. Scaffold monorepo, docker-compose, Drizzle schema + migrations, seed admin.
2. `packages/core` linking rules (tests first, from fixtures and hand-written cases).
3. `packages/drms` + `packages/vantage` clients (tests against fixtures with mocked fetch).
4. Worker jobs + pg-boss schedules.
5. Web: login, dashboard, devices, issues, counter names, users.
6. Dockerfiles (multi-stage), a compose file that works in Portainer, and a README with deploy steps.

## Verification

1. `npm test`: core linking cases (erp match, serial match, ambiguous, disagree, manual kept, broken, customer mismatch, issues resolving themselves) + client paging/throttle/429/reissue tests all pass.
2. `docker compose up --build` → web on :3000, migrations applied, admin login works.
3. Run `vantage.pull` and `drms.pull` from the UI against QA/live → `sync_runs` success, row counts plausible.
4. Run `link.run` → dashboard shows linked counts by method, and issues appear in the queue. Manually link one device, run `link.run` again, and the manual link persists.
5. Run `drms.snapshot` → one snapshot per Registered device. Run again the same day → 0 new rows (same `CounterId`). `counter_names` populated.
6. SQL spot check: `BlackTonerLevel` values for a known device match the DRMS WebUI.
7. Stop the worker partway through a snapshot and restart → it resumes, no duplicates.
8. Deploy the same compose file as a Portainer stack with env vars. The jobs run on schedule overnight.

## Open items (resolved in Phase 0, not blockers)
- `ErpId` / `CustomerErpId` field meaning → config values `LINK_ERP_ID_FIELD`, `LINK_CUSTOMER_ERP_FIELD`
- DRMS `/Customer` may be client-scoped → fallback: derive customers from equipment `CustomerErpId`/`CustomerName` (already the primary path)
- Exact supply counter names → handled by the `counter_names` catalogue, no code change needed
