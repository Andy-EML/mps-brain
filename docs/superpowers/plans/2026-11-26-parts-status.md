# Parts status (drums, developers, ITB, fuser, toner) — plan

User asks (2026-11-26): drum / developer / ITB / fuser state plus toner levels on the device page and in the PM details; a
"Device details" expander on the PM map popup and the planner's "PMs in area" cards (page count, pages since last visit,
parts state); Copy serial + Dismiss on the "PMs in area" cards too; a device page link in the /pm row detail.
User picked: alarm state + last fitted + pages since + **estimated % life** from rated part lives per cartridge family.

## Facts (checked live, read-only)
- DRMS `LatestCounters` has toner levels only (`BlackTonerLevel` … `YellowTonerLevel`, category `supply`). No part life %.
  The spec (v1.7.0) has no other parts endpoint.
- DRMS alarms (`device_alarms`, category `parts`) carry part life: description `PartsLife(<part>) 1st Call` (near end),
  `PartsLife(<part>) 2nd Call` (end of life), `PartsLifePrediction(<part>) 1st Call` (predicted soon). `<part>` seen:
  `IU_K/C/M/Y` (imaging unit = drum), `DC_K/C/M/Y` (developer), `Transfer belt unit`, `Transfer roller unit`.
  Fuser alarm names not seen yet — match `Fus` loosely. `PM Warning(PM Count)` (category other) = machine's own PM counter.
  Also `TZ-04 Missing:(Parts Missing Drum (K))`.
- Vantage visits (`vantage_work_visits.raw.WorkItems`, Status "Used", `Item.Description`/`PartNumber`, already parsed by
  `usedParts` in `packages/db/src/queries/pm-queries.ts`) record fitted parts. Descriptions are free text, e.g.
  "IUP35K - Black IU C3350i", "DD Colour Drum MF254/…", "Katun C450/550/650i CMY Drum Unit",
  "C250i/300i/450i/… Transfer Belt", "Konica C3350i/C4050i Fuser Unit", "Konica C450i/550i/650i Black Developing Unit",
  "MF3301 / MF3801 Transfer Unit". Exclude: rollers other than transfer roller (pick up, separation, DF sep), "IU Chip",
  "cleaning blade".
- Meter history: DRMS snapshots + Vantage meter readings are already merged for toner yield
  (`packages/db/src/queries/toner-yield.ts`). Pages convention: K / shared parts = Black:Total + Full Color:Total;
  C/M/Y parts = Full Color:Total.

## Rules
- Parts: `drum` (IU), `developer` (DC), `transfer_belt`, `transfer_roller`, `fuser`; colour K/C/M/Y for drum + developer
  (mono model: K only; colour word missing on a mono machine = K; "Colour"/"CMY"/"C,M,Y" = C+M+Y; no colour on a colour
  machine's drum/developer = unknown colour → ignore for per-colour, record nothing).
- Last fitted = latest visit date (London day) where that part (+colour) was Used.
- Alarm state per part = latest parts alarm for it: `end` (2nd Call) > `near_end` (1st Call) > `predicted`
  (Prediction); **cleared** when a fit of that part is on or after the alarm's received day; else OK.
- Pages since fitted = meter now − meter at fit day (interpolate as toner-yield does; null when no meter at/near fit,
  ≤45 days). No fit known → pages since = null, show "not seen in 36 months".
- Est. % left = max(0, 1 − pagesSince / ratedLife) when rated life set and pagesSince known; else null. Shown as "~12%".
- Rated lives: per cartridge family, nullable integers: drum K, drum CMY, developer K, developer CMY, transfer belt,
  transfer roller, fuser. Edited on /settings/cartridge-families like the toner yields.

## Tasks
1. **Core + db (Sonnet).** `packages/core/src/parts.ts` (+test): `classifyPart(description, isColour)` →
   `{ part, colours[] } | null`; `parsePartsAlarm(description)` → `{ part, colour|null, level }` | null. Migration 0024:
   rated part life columns on `cartridge_families`. Query `getDeviceParts(db, { drmsEquipmentId?, vantageEquipmentId? }, now)`
   in `packages/db/src/queries/device-parts.ts` (+test) returning toner levels (latest supply counters + reading date),
   total pages now, last visit (field visit, any length) + pages since it, and per part row
   `{ part, colour, alarm: {level, receivedAt} | null, lastFitted, pagesSince, ratedLife, pctLeft }` plus `pmCount`
   warning flag. Bulk variant for many machines if needed by the PM list (keep it lazy instead: load on expand).
   Saving rated lives in the families settings action + form fields. No commits.
2. **Research (Sonnet, parallel, read-only).** KM rated lives for drum/IU, developer, transfer belt, transfer roller,
   fuser per family (C3300i/C3350i, C250i, C450i, C750i, C257i, 4050i, 4700i, 751i, C258/C308/C368). Report only; user
   checks before entry.
3. **UI (Opus).** `PartsPanel` component (toner bars + parts table: Part · State · Est. life left · Last fitted · Pages
   since). Device page: new "Parts" card. /pm row detail: panel under the stats row; device page link moved to the top
   line beside Model. Map popup: "Device details" button → loads parts via server action, shown in the side panel (popup
   is HTML string; render React in the aside). "PMs in area" cards: Copy serial, Dismiss (reuse `DismissFields` +
   `mapDismissAction`), Device details expander. No commits.
4. Verify: typecheck, lint, tests, `scripts/mps.ps1 build`, restart; final Opus review; user click-through; commit + push
   on user OK.
