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

## Phase 0 findings (2026-09-17)

- DRMS pageNo first page: **1**, not 0. `Equipment?pageNo=0` returned HTTP 500; `Equipment?pageNo=1` returned HTTP 200 with 837 records. Paging must start at 1.
- DRMS equipment status counts (page 1, 837 total devices): `Discovered: 802`, `Registered: 35`. No other statuses present on this page.
- DRMS `ErpId` holds: **other/mixed — flag as concern, does not cleanly match either listed option.** Of 837 equipment records, 508 have an empty `ErpId`. Of the 329 non-empty: 324 equal that same record's `SerialNumber` verbatim (all across mixed statuses — looks like a default/placeholder value, not an ERP link), and only 5 are short numeric strings (3–5 digits, e.g. `875`, `10243`, `215`, `37262`, `37257`) — all 5 restricted to `Registered`-status devices. Those 5 numeric values are the right shape to be a Vantage `Equipment.Id` (samples elsewhere in the run showed Vantage `Equipment.Id` values of 23, 24, 224, 331, 867 for unrelated serials), but this was **not directly confirmed** — the script's serial-number cross-check sampled the first 5 page-1 rows, which happened to be `Discovered`/empty-`ErpId` devices, not the 5 numeric-`ErpId` `Registered` ones. → `LINK_ERP_ID_FIELD=inconclusive, likely Vantage Id only for Registered devices, needs a targeted re-check next session`.
- DRMS `CustomerErpId` holds: **other — flag as concern, does not match either listed option.** Examples (patterns, not real values): dealer-issued codes of the form `CUST` + 6 digits. These do **not** match Vantage `Customer.Id` (small integers, e.g. 161, 27, 295 in the sample) or Vantage `Customer.Reference` (short mnemonic codes, e.g. one 6-char code and one with a `/1` suffix in the sample). Cross-checked against DRMS's own `/Customer` list: the same `CUST######` value appears as that endpoint's `ErpId` field for the matching customer — so `CustomerErpId` on Equipment is DRMS's internal/dealer customer code, sourced from DRMS `Customer.ErpId`, and is **not populated with a Vantage identifier at all** in this QA data. → `LINK_CUSTOMER_ERP_FIELD=inconclusive, DRMS-side code not currently populated with a Vantage Id/Reference — customer linking will need a different key (e.g. CustomerName match) until this is populated correctly`.
- DRMS `/Customer` returns: **end customers**, not just the single dealer/client. Page 1 returned 245 records, all with unique `ErpId` values and all with a non-empty `CsrcIds` array. One sampled `CustomerErpId` from the Equipment list was confirmed present among these 245 `ErpId` values, confirming the two endpoints reference the same customer codes.
- Counter names seen (67 distinct names across 5 sampled `Registered` devices' `LatestCounters`): includes `BlackTonerLevel`, `CyanTonerLevel`, `MagentaTonerLevel`, `YellowTonerLevel`, plus paper-size/mode counters (`Total`, `Copy:*`, `Printer:*`, `Scanner/FAX:*`, `Discharge*`, `Billing total*`, etc.). **No waste-toner counter name was observed** in this 5-device sample — none of the 67 names contain "Waste". This may be model-dependent (only some MFPs report a waste-toner counter) or may need a larger sample; treat as inconclusive rather than "absent from the API."
- DRMS token exp: `2100-01-14T23:00:00.000Z` — effectively non-expiring QA token, no near-term rotation concern for this spike.
- Vantage list response shape: **`{"@odata.context", "value", ["@odata.count"]}`, never a bare array** — confirmed on `customer?$top=5`, `Equipment?$top=5&$expand=...`, and `Equipment?$top=1000&$count=true`. Client code must always unwrap `.value`.
- Vantage server cap on `$top`: **none observed at N=1000** — requesting `$top=1000` returned exactly 1000 rows (of `@odata.count`=1843 total available), i.e. the server honored the requested page size up to 1000; no evidence of a lower forced cap. Not tested above 1000.
- Vantage Equipment customer FK: **both** — `Equipment` has a scalar `CustomerId` plus a `$expand=Customer` navigation property exposing `Customer.Id` and `Customer.Reference`. In the 5 serial-matched samples, 2 records had `CustomerId`/`Customer` undefined (no customer attached on those particular Vantage equipment rows) and 3 had it populated normally.
- Extra: `GET $metadata?api-version=1.22` returned **HTTP 400** (`Error.Code: "UnsupportedApiVersion"` — the docs' example version isn't accepted on this endpoint on this tenant). Not retried (single-run constraint); a later phase should try `api-version=1.19` (the value used elsewhere in the docs) or query `$metadata` without assuming 1.22 works everywhere.

### Concerns for the controller
1. Neither `ErpId` nor `CustomerErpId` matched the three listed candidate meanings cleanly — both need a follow-up targeted check (a handful of extra read-only Vantage GETs against the 5 numeric-`ErpId` `Registered` serials) before `LINK_ERP_ID_FIELD`/`LINK_CUSTOMER_ERP_FIELD` are finalized. This spike deliberately did not make those extra calls, to stay within "run once" scope; recommend a short dedicated follow-up task.
2. `CustomerErpId` appears to hold a DRMS-side code that is not currently populated with any Vantage identifier for this dealer's QA data — customer-side linking may need to fall back to `CustomerName` matching (already noted as the primary path in "Open items" above) rather than `CustomerErpId`.
3. Waste-toner counter name wasn't observed in the 5-device sample; don't hardcode its absence into `counter_names` seed data.

## Phase 0 follow-up (2026-09-17)

Targeted, read-only follow-up (`scripts/phase0-probe2.ts`) resolving the four concerns above, run once against the same QA credentials. All 5 of the `Registered`-status devices with a numeric DRMS `ErpId` (identified from the already-saved `fixtures/raw/drms-equipment-page1.json`, no new DRMS list call) and up to 5 distinct `CUST######` codes were probed against Vantage.

- **Check 1 — numeric `ErpId`**: **`ErpId` = Vantage `Equipment.Id`, confirmed 5/5.** For all 5 sampled devices, `GET Equipment(<ErpId>)?$expand=Customer` returned 200 with a normalised `SerialNumber` match to the DRMS record, and an independent `GET Equipment?$filter=serialnumber eq '<serial>'` lookup returned the identical `Id`. `AssetNumber` was `null` on all 5 Vantage rows, so `ErpId` cannot be `AssetNumber` — it is the Vantage `Equipment.Id`. → **`LINK_ERP_ID_FIELD=VantageEquipmentId`** (only reliable for `Registered`-status devices; `Discovered`/other statuses mostly carry an empty `ErpId` or a `SerialNumber`-placeholder, per the original spike).
- **Check 2 — customer codes**: **`CustomerErpId` does NOT map to any queried Vantage customer field — confirmed, not just suspected.** `customer?$filter=externalaccountnumber eq '<code>'` and `customer?$filter=reference eq '<code>'` both returned HTTP 200 with **0 matches** for all 5 sampled `CUST######` codes (no 400s). Check 2b cross-checked the other direction too: for the same 5 devices from Check 1, the Vantage `Customer` expanded on the *matched* equipment row (found via the confirmed `ErpId`→`Id` link) had its `Reference` and `ExternalAccountNumber` compared against that device's DRMS `CustomerErpId` — **0/5 matched** on either field. → **`LINK_CUSTOMER_ERP_FIELD=none — DRMS `CustomerErpId` has no confirmed counterpart among Vantage `Customer.Id`, `.Reference`, or `.ExternalAccountNumber` in this QA data; customer linking must use `CustomerName` matching (already the documented primary/fallback path), not `CustomerErpId`.**
- **Check 3 — `$metadata` access**: **Resolved — the earlier CLAUDE.md guidance for this endpoint doesn't hold on this tenant.** `GET $metadata?api-version=1.19` (query param) → HTTP 400. `GET $metadata` with `api-version: 1.22` sent as a **header** (no query param) → HTTP 200 (1.5 MB), successfully retrieved and parsed. So `$metadata` on this tenant needs `api-version` as a header like every other endpoint, not a query param as the docs/CLAUDE.md state — flagging this as a documentation correction for later phases. From the retrieved schema: `Equipment` has 79 properties (`Customer` link fields: `CustomerId` scalar + `Customer` nav property, confirming the earlier spike's finding); interesting `Equipment` fields: `CollectionMethod`, `CollectionSchemaId`, `CollectionSchema`, `IsRemotelyMonitored`, `RemoteIP`; `Customer` has 170 properties, and of the Remote/Dca/Collection/External set, only `ExternalAccountNumber` exists on `Customer` (also checked directly in Check 2, with 0 matches).
- **Check 4 — Discovered-device counters**: **Resolved — `LatestCounters` is unavailable for `Discovered` devices, confirmed 3/3.** `GET Equipment/<Id>/LatestCounters` returned **HTTP 404** (not 200 with empty data) for all 3 sampled `Discovered`-status devices. → **Toner/meter automation can only cover `Registered` devices; `Discovered`/`PreRegistered` devices must be excluded from `drms.snapshot`/consumable-alarm polling until they reach `Registered` status** (consistent with CLAUDE.md's note that a device only becomes `Registered` after the first CSRC connection).

### Follow-up conclusions
- `LINK_ERP_ID_FIELD` = **Vantage `Equipment.Id`** (confirmed, `Registered` devices only).
- Customer-code mapping = **no confirmed Vantage field for `CustomerErpId`** (checked `Customer.Id`, `.Reference`, `.ExternalAccountNumber` — all 0/5); fall back to `CustomerName` matching.
- `$metadata` access = **works with `api-version` as a request header, not a query param** (contrary to the existing CLAUDE.md guidance for that one endpoint — worth a doc correction).
- Discovered-device counters = **`LatestCounters` returns 404 for `Discovered` devices; only `Registered` devices have counter data available.**

## Added requirements (2026-09-17, from user)

### Offline alert on the dashboard (Foundation Part 2)
- The dashboard shows an alert when a device that **was previously reporting** has not reported for **more than 24 hours**.
- Signal: DRMS `LastCounterReceivedTime` (fallback: `LastCounterBackboneReceivedTime`) on `drms_equipment`. Only `Registered` devices have it. `Discovered` devices have no heartbeat field (only `LastAlarmReceivedTime`, which is event-driven and missing on about a third of them).
- "Previously active" means the device has had a non-null `LastCounterReceivedTime` at least once. Devices that never reported don't alert. They show in a separate "never reported" list.
- Freshness: `drms-pull` currently runs once a day. For a 24-hour alert it must run more often (e.g. hourly: one `GET Equipment` call per page, well under the rate limits). Add an hourly schedule for `drms-pull` in Part 2.
- Caveat: DRMS collects counters once a night, so a device that misses one collection shows as roughly 24 to 48 hours stale. The alert threshold is configurable (`OFFLINE_ALERT_HOURS`, default 24). Alerts are cleared automatically when the device reports again, and can be acknowledged in the UI.
- Store state so alerts aren't recomputed noisily: `device_alerts` (drms_equipment_id, type `offline`, first_detected_at, last_seen_report_at, acknowledged_by/at, cleared_at).

### Registration batches
- Devices flagged as a customer mismatch are usually machines moved to a new location or customer. They are still active, so they're registered with the customer DRMS holds and listed for KM.
- Devices that haven't checked in for a while are skipped.

### Meter mapping (found 2026-09-17, needed by sub-project 2)
- Vantage RMB equipment uses `CollectionSchemaId = 3` ("Konica/Olivetti CS Remote"). Each Vantage `Meter` has `Type` (Black=1, Colour=2, Scan=3) and `Column` (a `MeterCollectionSchemaColumn`). **The column names are exactly the DRMS `LatestCounters` counter names**:
  - Black ← `Black:Total`
  - Colour ← `Full Color:Total`
  - Scan ← `Scanner/FAX:Scan`
- Totals confirmed by user and verified on 4 sampled devices (sums exact):
  - `Full Color:Total` [10] = `Copy:Full Color` [1] + `Printer:Full Color` [2] + `Scanner/FAX:Print(Full Color)` [3]
  - `Black:Total` [11] = `Copy:Black` [4] + `Printer:Black` [5] + `Scanner/FAX:Print(Black)` [6]
  - Bracket numbers are the user's CSRC counter numbers, **not** the DRMS `ItemNumber` field (which repeats across counters). Use counter `Name`.
  - Use the totals directly. Optionally flag a device whose total ≠ sum of parts. 2-colour/mono-colour counters (`Copy:2C Color`, `Printer:2C Color`, `Copy:Mono Color`) are **not** in either total (small counts seen).
- Meter sync maps **per device**: `GET Equipment(id)?$expand=Meters($expand=Type,Column)`, then for each meter take the DRMS counter whose `Name` equals `Column.Name`. Ignore all other DRMS counters (about 70 paper-size/mode counters). Not every device has all 3 meters (e.g. no Scan meter on some).
- Other Vantage meter types exist (coverage-band colour types, `Black A3` id 12). They aren't mapped to DRMS columns on the sampled devices, so treat them as out of scope unless a device's meter points at a schema-3 column.
- In the UI, the `counter_names` category editor can pre-mark these 3 as `meter` and the 4 `*TonerLevel` as `supply`.

### Scope notes from user (2026-09-17)
- Jams and error events (e.g. J-31) are **not needed** on the dashboard.
- Drum/imaging-unit status is nice-to-have, not critical. DRMS `LatestCounters` has **no** drum, imaging-unit or waste-box counters (only C/M/Y/K toner levels and page counters). The only possible source is DRMS alarms. KM Q7 asks about waste toner.
- Mockups (`mockups of dashboard/`): Fleet overview, Device detail, Toner orders. Part 2 copies the visual style and builds Fleet overview + Device detail from real data. Ordering and auto-reorder UI belong to sub-project 3. Uptime, IP, engineer, "Run diagnostic" and "Book an engineer" have no data source yet.
