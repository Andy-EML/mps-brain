# PM Actions, Accordion and Install-Date Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/pm` workable: install date starts the PM clock, rows expand in place with PM-only detail, and
machines can be marked Booked or Dismissed (app-only, audited, with Undo).

**Architecture:** Pure rules in `packages/db/src/queries/pm-due.ts` gain an install date and an optional manual
reset date. A new `pm_actions` table plus pure `resolvePmAction` decide whether an open action still applies;
`listPmDue` attaches the action and a `view` (`due` | `booked` | `dismissed`). The web page becomes tabs + an
accordion built on the replenishment Review tab pattern.

**Tech Stack:** TypeScript, Drizzle + Postgres, Next.js app router (server actions), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-pm-actions-design.md` (approved 2026-11-18); base spec
`docs/superpowers/specs/2026-11-17-pm-due-design.md`.

## Global Constraints

- Read-only towards Vantage. Actions live in the app DB only.
- **No git commits.** Checkpoint = tests + typecheck.
- Migration 0016 is applied (worker restart via `scripts/mps.ps1 restart -Only worker`) before any web code uses `pm_actions`.
- Snooze choices 30 / 90 / 180 days, default 90. Booked grace: 14 days after booked date; no date → booked date = marked + 30 days.
- Booked clears on a PM-category visit or a Field visit ≥ `qualifyingMinutes` dated after the action was created.
- Dismiss reasons: `not_now`, `declined`, `serviced_outside`, `other` (other needs note text). `serviced_outside` resets the clock at `serviced_on` (default today).
- One open action per machine (new action closes the previous with `cleared_reason = 'replaced'`).
- Expanded row: no toner, order or yield content.

## Review Focus

1. **Booked, then the machine gets a qualifying visit** → action auto-clears (`visit_seen`) and the row follows the normal status. Test in Task 2.
2. **Booked with no date, 45 days later, no visit** → back in Due flagged "Booked — no visit seen". Test in Task 2.
3. **Serviced outside Vantage on a date with no meter reading** → pages since measured from the nearest reading (same lookahead as visits), never a false OK from base===latest. Test in Task 1.
4. **Machine installed 3 months ago, no visits, no readings** → Unknown `no_meter`, not Overdue; installed 13 months ago → Overdue `time_cap`. Test in Task 1.
5. **Undo on a snoozed machine** → back in Due immediately. Test in Task 2.

---

### Task 1: Install date and manual reset in the PM rules

**Files:** Modify `packages/db/src/queries/pm-due.ts`, `pm-due.test.ts`, `pm-queries.ts` (pass install date), `pm-queries.test.ts`.

**Interfaces:**
- `computePm(args)` gains `installedAt: Date | null` and `manualResetAt: Date | null` (both optional, default null).
- Clock start = latest of (lastQualifying.at, installedAt, manualResetAt). `PmResult` gains `clockStart: Date | null` and `clockSource: 'visit' | 'install' | 'manual' | null`.
- Time cap = clockStart + timeCapMonths. `no_visit_12m` only when clockStart is null.
- Pages since = latest − meter at clockStart (same `meterPointAt` + base===latest → `no_meter` rules). When clockSource is `install` and the first reading is > 30 days after install, `pagesSinceIsLowerBound = true`.
- `PmRow` unchanged except `result`; `listPmDue`/`getEquipmentPm` read `vantage_equipment.install_date`.

- [ ] **Step 1:** Failing tests: `installed 3 months ago, no visits, no readings → unknown no_meter`; `installed 13 months ago, no visits → overdue time_cap`; `install later than last visit starts the clock (clockSource install)`; `manualResetAt after last visit resets pages and time cap (clockSource manual)`; `manual reset date with no reading near it and only one later reading → unknown no_meter`; DB test `listPmDue uses install_date`.
- [ ] **Step 2:** `npx vitest run packages/db/src/queries/pm-due.test.ts packages/db/src/queries/pm-queries.test.ts` → FAIL.
- [ ] **Step 3:** Implement. **Step 4:** same command → PASS; `npm run typecheck`.

### Task 2: `pm_actions` table, queries and action resolution

**Files:** Modify `packages/db/src/schema.ts`; create `packages/db/drizzle/0016_pm_actions.sql` (drizzle-kit generate); create `packages/db/src/queries/pm-actions.ts` + `pm-actions.test.ts`; modify `pm-queries.ts` (+test), `queries/index.ts`.

**Interfaces:**
- Table `pm_actions` per spec "Data": `id serial pk`, `vantage_equipment_id int not null`, `kind text not null`, `booked_for date`, `reference text`, `reason text`, `note text`, `snooze_until date`, `serviced_on date`, `created_by int` (users.id), `created_at timestamptz not null default now()`, `cleared_at timestamptz`, `cleared_reason text`; partial unique index on `vantage_equipment_id` where `cleared_at is null`.
- `export type PmActionKind = 'booked' | 'dismissed'`; `export type DismissReason = 'not_now' | 'declined' | 'serviced_outside' | 'other'`.
- `export interface PmAction { id; vantageEquipmentId; kind; bookedFor: Date | null; reference: string | null; reason: DismissReason | null; note: string | null; snoozeUntil: Date | null; servicedOn: Date | null; createdBy: number | null; createdByName: string | null; createdAt: Date }`.
- Pure: `resolvePmAction(a: PmAction, visits: Visit[], s: PmSettings, now: Date): { state: 'booked' | 'booked_overdue' | 'snoozed' | 'reset' | 'expired' | 'visit_seen' }`
  - booked: `visit_seen` if any visit after `createdAt` with verdict `counted` or `counted_pm`; `booked_overdue` if now > (bookedFor ?? createdAt+30d) + 14d; else `booked`.
  - dismissed: `serviced_outside` → `reset`; else `snoozed` while now < snoozeUntil, then `expired`.
- Writes: `markPmBooked(db, { vantageEquipmentId, bookedFor, reference, userId })`, `dismissPm(db, { vantageEquipmentId, reason, note, snoozeDays, servicedOn, userId })` (validates: snoozeDays ∈ {30, 90, 180} unless serviced_outside; `other` needs note; throws existing `SettingsError`-style validation error with code `invalid_pm_action`), `undoPmAction(db, actionId, userId)` (sets cleared `undo`). New action on a machine with an open one clears the old (`replaced`). Audit row like `savePmSettings` does.
- `listPmDue`/`getEquipmentPm`: load open actions; `visit_seen`/`expired` → clear them in the DB (cleared_at = now, reason) and ignore; `reset` → pass `manualResetAt = servicedOn` to `computePm`. `PmRow` gains `action: PmAction | null`, `bookedOverdue: boolean`, `view: 'due' | 'booked' | 'dismissed'` (booked → `booked`; booked_overdue → `due`, `bookedOverdue: true`; snoozed or reset → `dismissed` while the reset machine is not overdue/due_soon, else `due`). Vantage-side `status === 'booked'` → view `booked`.
- `PmFilter.status` stays; add `PmFilter.view?: 'due' | 'booked' | 'dismissed' | 'all'` (default `due` = today's default view + bookedOverdue rows, excluding booked/dismissed views).

- [ ] **Step 1:** Failing tests in `pm-actions.test.ts`: the five `resolvePmAction` states; `dismissPm rejects snoozeDays 45`; `other without note rejected`; `new action replaces open one`; `undo clears and row returns to due`. In `pm-queries.test.ts`: `booked machine in booked view, out of due`; `booked + later counted visit → action cleared visit_seen, row in due/ok`; `booked no date 45 days old → due with bookedOverdue`; `snoozed 90 → dismissed view; after 91 days back in due and action expired`; `serviced_outside resets clock → ok, dismissed view`.
- [ ] **Step 2:** Run them → FAIL. **Step 3:** schema + generate migration (check SQL only creates the table + index); implement; apply migration (stop/start worker) and confirm `\d pm_actions`.
- [ ] **Step 4:** `npx vitest run packages/db` → PASS (rerun known flaky files alone); typecheck.

### Task 3: `/pm` tabs, accordion and actions UI

**Files:** Modify `apps/web/src/app/(app)/pm/page.tsx`, `pm/filters.ts` (+test), `pm/export/route.ts`; create `apps/web/src/app/(app)/pm/actions.ts`, `apps/web/src/components/pm-row.tsx` (client accordion row), `apps/web/src/components/pm-detail.tsx` (server-safe detail body), `apps/web/src/lib/pm-action-form.ts` (+test); modify `apps/web/src/components/pm-card.tsx` (reuse `pm-detail` for the shared body; show open action as one line, no buttons), `pm-status.ts` (+test).

**Interfaces:** consumes Task 2 `PmRow.action`, `PmRow.view`, `PmRow.bookedOverdue`, `markPmBooked`, `dismissPm`, `undoPmAction`, `PmFilter.view`.

- Tabs: Due · Booked · Dismissed · All with counts; `?view=`; CSV export follows `view` and adds columns Action, Action by, Action date, Booked for, Reference, Dismiss reason, Snooze until.
- Collapsed row: customer, serial, model, status badge + reason, pages since / %, last counted visit, est. due; badge "Booked — no visit seen" when `bookedOverdue`.
- Expanded: `pm-detail` (interval + source, clock start + source text "since install" / "since last visit" / "since serviced outside Vantage", pages / % / est. due / time-cap date, last 10 visits with notes + verdict), action forms, "Open device" link. No toner/order/yield content.
- Forms: Mark booked (date optional, reference optional); Dismiss (reason radio, snooze 30/90/180 default 90 hidden for serviced_outside, serviced date default today shown only for serviced_outside, note required for other); Undo when an action is open. Server actions call `requireUser()`, parse via `pm-action-form.ts`, `revalidatePath('/pm')`, keep the row open after submit (`?open=<id>`).
- `pm-status.ts`: `actionText(a: PmAction): string` e.g. "Booked for 3 Dec 2026 by Andy (ref W123)", "Snoozed until 16 Feb 2027 — Customer declined", "Serviced outside Vantage on 18 Nov 2026"; `clockSourceText`.

- [ ] **Step 1:** Failing tests: `pm-action-form.test.ts` — `booked with blank date/reference ok`, `dismiss other needs note`, `snooze must be 30/90/180`, `serviced_outside defaults date to today`; `filters.test.ts` — `view parsed, default due`; `pm-status.test.ts` — `actionText` three cases, `clockSourceText`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS + `npm run typecheck` + eslint changed files + web tests.

### Task 4: Ship and verify

- [ ] **Step 1:** `npm run typecheck`; `npx vitest run packages apps` → all pass (report counts).
- [ ] **Step 2:** `.\scripts\mps.ps1 build` → worker + web running, :3000 listening.
- [ ] **Step 3:** Read-only live summary (reuse `.superpowers/sdd/2026-11-17-pm-due/task-4-live.ts` pattern): status counts and reasons before/after install-date fix; confirm machines installed < 12 months no longer `no_visit_12m`. Do not create actions on live data. Do not commit.
