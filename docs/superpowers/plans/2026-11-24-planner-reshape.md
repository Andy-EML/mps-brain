# PM Planner Reshape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/pm/planner` opens on the Map; the Board (second tab) becomes three columns left to right — PMs in area (compact, expandable, draggable) → Planned (To plan + Asked, asked shown as a tag) → Booked — with no Done column.

**Architecture:** Storage unchanged (`pm_plan.board_column` keeps `to_plan`/`asked`/`done`; Booked stays derived). The web layer maps stored columns to the three visible ones and hides Done. The Upcoming panel is rebuilt as a compact first column with client-side expand, a Today/Tomorrow switch and native HTML5 drag onto Planned (drop calls the existing non-redirecting `mapAddToPlanAction` / `mapAskEngineerAction`). The default view flips to map; board links move to `?view=board`.

**Tech Stack:** Next.js 16 app router, React 19, Tailwind, vitest, sonner toasts.

**Spec:** `docs/superpowers/specs/2026-11-24-planner-reshape-design.md`

## Global Constraints

- `/pm/planner` → Map. Board at `/pm/planner?view=board`. `?view=map` still works. Tab order: **Map | Board**.
- Board columns, left to right: **PMs in area**, **Planned**, **Booked**. No Asked engineer column, no Done column.
- Planned = stored `to_plan` + `asked`. An asked card shows a tag `Asked <engineer> · <day>` taken from its latest `Asked <engineer> for <day>` note line (the `askNote` format); if none, `Asked engineer`.
- Done cards are not shown anywhere on the board (they "drop off"); the card menu no longer offers Done. Storage/sync of `done` unchanged.
- Booked unchanged: derived (open `pm_actions` booked or Vantage PM job); manual via the existing Mark-booked form.
- PMs in area: Today / Tomorrow switch (default Today), per engineer → per call one line `HH:MM Customer · N nearby`; hover or click expands to machines, one line each `customer · shortModel · overdue Xm · D mi`; machines at the call's own site fold into one line `<Customer> — N machines here ▸` (expandable, with "Add all" / "Ask for all"). Machines already on the board show their column instead of the buttons.
- Drag a machine or a same-site group onto Planned → added (To plan). Every drag action also has a button/menu equivalent (Add to plan, Ask <engineer>). Result toast via sonner; `router.refresh()`; no full redirect.
- Cards stay grouped by county → district (→ patch) in Planned and Booked.
- Nothing written to Vantage; writes only `pm_plan` (+ audit) via existing actions.
- Checks before each commit: focused vitest files (one process at a time — the machine is slow), `npm run typecheck`, `npm run lint` (3 known `.superpowers/sdd/2026-11-18-pm-actions/*.ts` errors only).

## Review Focus

1. A card in `asked` with a typed note that has no `Asked … for …` line → tag `Asked engineer`, note still shown (Task 1 test `askedTag falls back`).
2. Card actions that redirect back to the planner (Move/Book/Remove, `plannerRedirectHref`) must land on the **Board** view, not the map (Task 3 test `planner redirect keeps board view`).
3. Dropping a machine that is already on the board or no longer due → toast with the skip reason, nothing duplicated (Task 2 relies on `planFromMap` skip results; test the drop handler's id extraction `dragIds`).
4. A call whose suggestions are all at its own site → only the folded site line, no empty "others" list (Task 2 test `groupCallSuggestions all same site`).
5. Tomorrow with no calls → "No booked calls tomorrow" (Task 2 test).

---

### Task 1: Three-column board

**Files:** Modify `apps/web/src/components/planner-board.tsx`, `apps/web/src/components/planner-card.tsx`; Create `apps/web/src/lib/planner-columns.ts` + `.test.ts`.

**Interfaces:**
- Produces: `export type VisibleColumn = 'planned' | 'booked'`; `visibleColumnOf(c: BoardColumn): VisibleColumn | null` (`to_plan`/`asked` → planned, `booked` → booked, `done` → null); `askedTag(card: { column: BoardColumn; note: string | null }): string | null` (null unless asked).
- `PlannerBoard` renders a three-column grid `lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]` whose first cell is a slot (`pmsInArea: ReactNode`), then Planned, then Booked. `doneRetentionDays` prop removed.

- [ ] **Step 1: Tests:** `visibleColumnOf` (4 cases); `askedTag uses latest Asked line` (note `"key in reception\nAsked Andy for 24 Nov\nAsked Keith for 25 Nov"` → `Asked Keith · 25 Nov`); `askedTag falls back` (asked, note `"gate code 1234"` → `Asked engineer`); not asked → null.
- [ ] **Step 2:** FAIL → **Step 3:** implement; card shows the tag chip; card menu offers only: **Book…** (existing Mark-booked form), **Back to Planned** (on manual-booked cards: undoes the booking via the existing action), **Remove**; no Done, no Asked engineer target. → **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(web): planner board — Planned and Booked, asked as a tag`.

### Task 2: PMs in area column

**Files:** Rewrite `apps/web/src/components/planner-upcoming.tsx` as a client component `PlannerPmsInArea`; extend `apps/web/src/lib/planner-upcoming.ts` (+ test).

**Interfaces:**
- Consumes: `UpcomingEngineer` (calls with `suggestions: PmSuggestion[]` incl. `sameSite`, `distanceMiles`, `boardColumn`), `shortModel` (apps/web/src/lib/format.ts or wherever it was added), `mapAddToPlanAction(ids)`, `mapAskEngineerAction(ids, workUnitId)`.
- Produces: `groupCallSuggestions(call: UpcomingCall): { site: PmSuggestion[]; others: PmSuggestion[] }`; `dragIds(dataTransfer value: string): number[]` (parses `"ids:1,2,3"`, rejects junk → []); drag payload format `ids:<comma ids>` with MIME `application/x-pm-ids`.
- Server passes the whole upcoming view (both days); the client switch picks the day.

- [ ] **Step 1: Tests:** `groupCallSuggestions` (mixed; `all same site`; none); `dragIds` (valid, junk, empty); `No booked calls tomorrow` text helper if one exists.
- [ ] **Step 2:** FAIL → **Step 3:** implement: compact lines, expand on hover (desktop) and click (toggle, keyboard Enter/Space, `aria-expanded`), draggable rows (`draggable`, `onDragStart` sets payload), buttons Add / Ask per machine and per site group. Planned column (Task 1) gets `onDragOver`/`onDrop` → `dragIds` → `mapAddToPlanAction` → toast → `router.refresh()`. → **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(web): PMs in area column with drag to Planned`.

### Task 3: Map first, board second

**Files:** `apps/web/src/app/(app)/pm/planner/page.tsx` (default view map; `?view=board`; header tabs Map | Board), `apps/web/src/lib/planner-form.ts` (`plannerRedirectHref` / `plannerReturnHref` keep `view=board`), `apps/web/src/lib/device-origin.ts` (planner back link → board where it came from the board), `apps/web/src/components/planner-map-canvas.tsx` (`BACK` → `/pm/planner`), any `#upcoming` anchors.

- [ ] **Step 1: Tests:** `planner redirect keeps board view` (`plannerRedirectHref('/pm/planner?view=board', 12)` → `/pm/planner?view=board#card-12`; a bare `/pm/planner` return from a board form → `?view=board`).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Browser check** (Playwright; already logged in — never log in): `/pm/planner` shows the map; Board tab shows three columns; hover/click expands a call; drag one machine onto Planned is NOT performed on live data — instead verify `draggable` attributes and drop target exist; layout fits 1600px with no sideways scroll; no console errors. Rebuild/restart web via `scripts/mps.ps1`.
- [ ] **Step 6:** Commit `feat(web): planner opens on the map; board second`.

### Task 4: Docs

- [ ] `docs/HANDOFF.md` planner section + `CLAUDE.md` planner sentence: Map default, Board columns, asked tag, no Done column. Commit `docs: planner reshape handoff`.
