# PM due — accordion, Booked / Dismiss, install-date clock

Status: design, 2026-11-18. Follow-up to `2026-11-17-pm-due-design.md` after the user's first look at `/pm`.
Still read-only towards Vantage: actions are recorded in the app only.

## Why (user, 2026-11-18)

- "On the PM screen we don't need to know about toners or consumable orders or toner yields": a row click
  currently opens the device page, which is mostly toner/orders/yield.
- "There is no button to say booked or dismiss": the list can't be worked.
- "Can we have an accordion in the main screen": PM detail in place, like the replenishment Review tab.
- A machine under 12 months old showed as overdue with no counter info: the time-cap clock ignored the install date
  (live: 133 of 173 machines installed in the last 12 months wrongly "No visit in 12 months").

## Changes

### 1. Install date starts the clock (bug fix)
- Clock start = later of (last qualifying visit, `vantage_equipment.install_date`).
- Time cap = clock start + `timeCapMonths`. A machine installed < 12 months ago with no visit is never
  `no_visit_12m`; with no visit and no install date, keep today's `no_visit_12m` rule.
- Pages since install = latest reading − first reading at/after install (lower bound flag only when the first
  reading is well after install, > 30 days). No readings and inside the time cap → Unknown `no_meter`.

### 2. Accordion on `/pm`
- Collapsed row: customer, serial, model, status badge + reason, pages since / %, last counted visit, est. due.
- Expanded (row click / chevron): the device-page PM card contents only — interval + source, last counted
  visit, pages since / % / est. due / time-cap date, last 10 visits with engineer notes and verdict — plus the
  action buttons and a small "Open device" link. **No toner, order or yield content.**
- Same accordion pattern as the replenishment Review tab (`replenishment-queue.tsx`); one row open at a time is
  not required.

### 3. Actions (app-only, audited: who + when)
- **Mark booked** (optional date, optional Vantage job reference). Machine moves to the **Booked** tab.
  - Clears itself when a PM-category visit or a Field visit ≥ 45 min appears in Vantage after it was marked.
  - If the booked date (or, without one, 30 days after marking) passes by 14 days with no such visit, it
    returns to the main list flagged **"Booked — no visit seen"**.
- **Dismiss** with a reason (user chose option C):
  - **Not now / Customer declined / Other (text)** → snoozed for 30 / 90 / 180 days (default 90); **Dismissed**
    tab until then, then back in the list.
  - **Serviced outside Vantage** → resets the PM clock as if a qualifying visit happened on the given date
    (default today): pages since and time cap restart from it. Machine drops out until due again.
- **Undo** on any booked/dismissed machine.
- Vantage-side "PM booked" (open future PM job, existing rule) still shows as booked with its date.

### 4. Tabs
Due (today's default view + "Booked — no visit seen") · Booked · Dismissed · All. CSV export follows the tab.

## Data
New table `pm_actions`: id, vantage_equipment_id, kind (`booked` | `dismissed`), booked_for (date, null),
reference (text, null), reason (`not_now` | `declined` | `serviced_outside` | `other`), note (text, null),
snooze_until (date, null), serviced_on (date, null), created_by, created_at, cleared_at, cleared_reason
(`visit_seen` | `undo` | `expired`). One open action per machine. Migration 0016, applied before web code
uses it.

## Not changing
- No Vantage writes. Settings, jobs, contract rule unchanged.
- Device-page PM card stays; buttons live on `/pm` only (my call), the card shows any open action as one line.

## Open (asked separately, don't block this)
Whether "Booked callout" / "Return to Fit" count as engineer visits; backlog split / longer visit history.

## Approaches considered
1. App-side actions table + accordion (chosen: matches how replenishment works, no Vantage writes).
2. Write bookings into Vantage (`PMScheduleEntry/BulkImport`): rejected for now, user chose read-only.
3. Dismiss as a per-machine "ignore forever" flag: rejected, buries mistakes (user chose C).
