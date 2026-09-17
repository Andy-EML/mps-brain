# Handoff — end of 2026-09-17

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
- `npm test` 91 tests green, typecheck and lint clean.
- Final whole-branch review (Opus) was **still running at handoff**. Its verdict is recorded at the end of the ledger. If it isn't there, re-run the final review before merging.
- Smoke run against local Postgres, QA DRMS and live Vantage: all 4 jobs succeeded. Results: 836 DRMS devices, 1,826 Vantage equipment, 830 active links (791 serial / 39 ERP ID), 1,001 open link issues (996 are Vantage kit not in DRMS), 35 snapshots, 83 counter names.
- The worker is **not running** (stopped after the smoke run). Start it with `npm run dev -w @mps/worker`. Send a job manually with `apps/worker/scripts/send-job.ts`.

**Next build steps:**
1. Act on the final review findings, then finish the branch (merge to main).
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

## 5. Documents

- KM questions (Word): `F:\dev\API Docs Etc\KM DRMS3 questions - BGB Elmdale.docx`. Q1–Q9, not sent yet. Fill in the name/role/email placeholder. Q2–Q4 are partly answered by the pilot and could be updated.
- API reference docs: `F:\dev\API Docs Etc\`
- Local Postgres 17 service `postgresql-x64-17`, db/role `mps`, creds in `.env`.
