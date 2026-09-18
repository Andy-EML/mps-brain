# Handoff — end of 2026-09-17 (updated 2026-09-18)

## 0a. Update — 2026-09-18 16:20 (supersedes 0b below where they disagree)

- **DRMS registration is finished.** 258 of 260 selected devices registered across five
  batches. The DB now holds 293 Registered, 541 Discovered, 2 Deleted. The two failures were
  both "already registered in CSRC backbone" (A7PY321200377, AA7R021035348) and need nothing.
- **The counter outage resolved itself.** DRMS resumed collecting on 18 Sep; 198 devices now
  expect readings and 175 have one inside 24h. 195 devices have toner levels, against 32
  before registration. Nothing to escalate to KM on that front.
- **Tasks 9C and 3B are complete and reviewed.** 9C replaced "Offline" with "No meter
  reading", added a fleet-wide outage banner, and after a live miss was changed to a
  proportional rule: outage when `stale / expecting >= 0.7` (`COLLECTION_OUTAGE_STALE_RATIO`),
  shared by the worker and the web so they cannot disagree. Alerts now stand at 21 open, all
  genuine.
- **Task 9D is in flight:** mono devices have no colour cartridges. A device is colour only
  if its model name carries `C` before the model number, a `+` (Develop `ineo+`), or `MF`;
  everything else is mono. `isColourModel` in `packages/core/src/models.ts` is the single
  source of truth, verified against the fleet. The task adds `is_colour` to `drms_equipment`,
  nulls CMY inside `counterPivotSubquery` (which fixes needs-toner, urgency sort and fleet
  toner health at once) and drops the colour bars, tiles and meter column on mono devices.
- **Order from here:** 9D → 9B full test pass → sub-project 3 (replenishment: threshold
  cascade, `auto_replenish`, bulk settings, operator review queue, real Vantage orders) →
  4 site stock → 2 meter sync → 5 notifications → **Task 10 deploy last**.
- **The "Needs toner" tile must open the toner order queue**, not a filtered device list.
  That screen belongs to sub-project 3.
- **Stop the worker while an implementer is editing `apps/worker`** — tsx watch restarts it
  on every save and will interrupt a running job.

## 0b. Update — 2026-09-18 13:20

- **Part 1 merged to `main`** and pushed to `github.com/Andy-EML/mps-brain` (private), along with `feat/foundation-web`.
- **Part 2 (web + deploy)** is on `feat/foundation-web`, plan `docs/superpowers/plans/2026-09-18-foundation-part2-web-deploy.md`, live status in the SDD ledger `.superpowers/sdd/2026-09-18-foundation-part2-web-deploy/progress.md`.
  - Done and reviewed: alerts table, query layer, offline alerts + hourly DRMS pull, **alarm pull** (waste toner, drums, imaging units), web scaffold/login/shell, fleet overview + devices list, device detail, link issues queue, alerts page, admin. ~295 tests.
  - Remaining: **9A** review follow-ups → **3B** Vantage sales-order history (read-only, colour chips per order line) → **9B** full test pass (worker end-to-end + page-by-page UI, writes `docs/TEST-REPORT-*.md`) → **10** Docker/Portainer deploy.
- **Dashboard runs locally:** `npm run dev -w @mps/web` → http://localhost:3000 (admin credentials from `.env`).
- **Registration:** batch-04 (50 devices) started 2026-09-18 ~13:15. Totals before it: 47 registered, 1 failed/Deleted, 7 skipped.
- **Open issue:** no device in the fleet has collected counters since 2026-09-17 12:01 UTC — including the 35 that were reporting before. So it isn't caused by our registrations. Re-check; escalate to KM if the older devices resume and ours don't.
- **Decisions since yesterday:** sub-project 3 creates real Vantage orders (not provisional); order status comes from `CompletedDate`; colour of an order line comes from its `Details` text (MISC = machines another reseller supplies); no jams/service events on the dashboard; test thoroughly before deploying.

Where to pick up tomorrow. Read this first, then `CLAUDE.md`, then the spec.

## 1. First thing tomorrow (2026-09-18): counter check

DRMS collects counters overnight. **Check that the devices registered today now return counters.**

```bash
cd /c/dev/mps-brain
# read-only: LatestCounters for every Registered device in the batch CSVs
```
- Devices: every row with `drms_status_after` starting `Registered` in `F:\dev\API Docs Etc\DRMS registration batches\pilot-01.csv`, `batch-02.csv`, `batch-03.csv` (use `drms_equipment_id`).
- Expected: HTTP 200 with `Counters` containing `BlackTonerLevel` etc. and `Black:Total` / `Full Color:Total` / `Scanner/FAX:Scan`.
- If they return counters → registration works end to end, so carry on registering in batches (section 3).
- If still 404 → raise with KM (the questions doc already asks, Q1–Q3) before registering more.

## 2. State of the build

**Foundation Part 1 (backend): all 13 tasks implemented and reviewed** on branch `feat/foundation-backend` (not merged, not pushed).
- Plan: `docs/superpowers/plans/2026-09-17-foundation-part1-backend.md`
- Spec: `docs/superpowers/specs/2026-09-17-mps-foundation-design.md`. Read the Phase 0 findings, follow-up and "Added requirements" sections.
- SDD ledger (rulings, deferred minors): `.superpowers/sdd/2026-09-17-foundation-part1-backend/progress.md` (gitignored)
- `npm test` 100 tests green, typecheck and lint clean.
- Final whole-branch review (Opus): **ready to merge with fixes**. The findings and the fix scope are in `.superpowers/sdd/2026-09-17-foundation-part1-backend/final-review-findings.md`:
  - F1: `link_broken` issues resolve themselves on the next run
  - F2: a full Vantage refresh has no guard, and `$skip` paging can skip rows
  - F3: the incremental filter is too narrow
  - F4: pg-boss's 15-min job expiry
  - F5: `counter_names` deadlock
  - F6: missing test for Discovered devices with no counters
  - M1–M5: minors
  **All fixed and re-reviewed clean** (11 commits `c7b26de..54a9b75`, tests now 100/100, typecheck and lint clean). **Next: finish the branch (merge `feat/foundation-backend` into `main`), with the user's OK.**
- Still to do (not in the fix wave):
  - **Live Vantage check:** do `ModifiedDate`/`CreatedDate`/`DeletedDate` change on create and soft delete, and are dates UTC or UK local? This affects the incremental pull.
  - **Part 2 deploy notes from the review:**
    - worker `replicas: 1` (the DRMS limiter and cooldown are in memory; `failStaleRuns` fails all running rows)
    - only the worker runs migrations
    - `stop_grace_period: 45s`
    - the image must include `packages/*/src`, `packages/db/drizzle` and `tsx`
    - consider persisting the 429 cooldown
  - **Snapshot retention/storage growth:** plan it (about 15 GB/yr at 3,000 Registered devices).
- Smoke run against local Postgres, QA DRMS and live Vantage: all 4 jobs succeeded. Results: 836 DRMS devices, 1,826 Vantage equipment, 830 active links (791 serial / 39 ERP ID), 1,001 open link issues (996 are Vantage kit not in DRMS), 35 snapshots, 83 counter names.
- The worker is **not running** (stopped after the smoke run). Start it with `npm run dev -w @mps/worker`. Send a job manually with `apps/worker/scripts/send-job.ts`.

**Next build steps:**
1. Finish the branch: merge to main (final review fixes are done).
2. Write the **Part 2 plan** (web + deploy). Scope:
   - Next.js UI in the style of the mockups (`mockups of dashboard/`: Fleet overview + Device detail first)
   - Login (local accounts; admin already seeded from `.env`)
   - Devices list with toner bars, link issues queue, counter names editor, users
   - **Offline alert** (a previously reporting device silent >24h; needs `drms-pull` hourly and a `device_alerts` table)
   - Dockerfiles, compose file and Portainer deploy
3. Then testing.
4. Later sub-projects: 2 meter sync (the mapping is already known, see spec), 3 replenishment/orders (the Toner orders mockup), 4 site stock, 5 notifications.

## 3. DRMS device registration (outside the app, scripts)

Folder: `F:\dev\API Docs Etc\DRMS registration batches\`
- `select-batch.mjs`: **read-only**. Picks N eligible Discovered devices from live DRMS and Vantage and writes a CSV.
- `register.mjs`: registers **one** device from a CSV:
  - prechecks that the device is still Discovered
  - sends `EquipmentRequest/Register` with the CSRC values DRMS holds + `EquipmentErpId` = Vantage `Equipment.Id`
  - polls, writes the result into the CSV, logs to `<csv>-log.jsonl`
  - never resends if the CSV already has a request ID; exits non-zero on non-success
- Run from the repo root so `.env` is used:
  ```bash
  cd /c/dev/mps-brain
  node --env-file=.env "/f/dev/API Docs Etc/DRMS registration batches/select-batch.mjs" "F:/dev/API Docs Etc/DRMS registration batches/batch-04.csv" batch-04 25
  CSV="F:/dev/API Docs Etc/DRMS registration batches/batch-04.csv"; for s in $(python -c "import csv;print(' '.join(r['serial_number'] for r in csv.DictReader(open('$CSV',encoding='utf-8-sig')) if r['include_in_pilot']=='yes' and r['register_result']!='ProcessedSuccessful'))"); do node --env-file=.env "/f/dev/API Docs Etc/DRMS registration batches/register.mjs" "$CSV" $s || break; done
  ```
  Don't edit or save the CSV while a batch is running.

**Totals so far:** 47 registered (pilot 5, batch-02 19, batch-03 23), 1 failed → DRMS Deleted (left alone by decision), 7 skipped.

**Selection rules agreed with the user:**
- Discovered, `CSRC_HTTP` on `COM_GB502`/`COM_GB503`, has a CSRC ID, product ID and `CUST` customer code
- DRMS `ErpId` **empty** (288 devices have ErpId = serial number: untested, KM Q4, skipped so far)
- Checked in: DRMS `LastAlarmReceivedTime` within **30 days**
- Name not refurb/unsold/awaiting/demo/loan
- **Exclude Abacus Direct / Primaflow**
- Exactly one Vantage equipment with the same serial, with a customer, and an **Active** contract (status 1, not on hold, not cancelled)
- Customer mismatches (DRMS customer ≠ Vantage customer): **register anyway and flag in CSV**. These are machines moved to new locations or customers, and the app links by ERP ID/serial.

**Known failure:** A7PY321200377 (Allmakes, DRMS customer John Rankin): CSRC Backbone error → DRMS set it to Deleted. It's still active in CSRC. The user chose not to retry (customer orders toner manually). Retry option: register with `CUST108727` Allmakes PR2 4x4 Ltd (ALLM01).

## 4. Key facts learned today

- QA DRMS (`drmsqa.konicaminolta.eu`) holds the real fleet. The user has **no production DRMS access**; KM controls it.
- Discovered devices: **no counters** (LatestCounters 404) and no heartbeat field. Registration via the API moves them straight to Registered, with no technician reconnect.
- DRMS `EquipmentRequest/Register` returns the request ID as a **bare JSON string**.
- Customer moves done in the CSRC portal don't appear in DRMS (e.g. A93E027053412). Such devices still register with the DRMS-held customer. KM Q9.
- **Meters (confirmed against CSRC by the user):** Black = `Black:Total`, Colour = `Full Color:Total`, Scan = `Scanner/FAX:Scan`. Vantage schema 3 column names = DRMS counter names.
- DRMS has no drum/imaging-unit/waste counters. Jams and errors are not wanted on the dashboard.
- Vantage `$metadata` needs `api-version` as a **header**.

## 5. Snapshot timing
`SNAPSHOT_CRON` is `30 13 * * *` (13:30 London). CSRC collects across Europe in the morning, so counters aren't there earlier (user, 2026-09-18).

## 5. Documents

- KM questions (Word): `F:\dev\API Docs Etc\KM DRMS3 questions - BGB Elmdale.docx`. Q1–Q9, not sent yet. Fill in the name/role/email placeholder. Q2–Q4 are partly answered by the pilot and could be updated.
- API reference docs: `F:\dev\API Docs Etc\`
- Local Postgres 17 service `postgresql-x64-17`, db/role `mps`, creds in `.env`.
