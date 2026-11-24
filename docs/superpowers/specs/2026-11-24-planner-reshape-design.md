# PM planner reshape — design

Date: 2026-11-24. Status: approved by user in conversation ("yes that's right", 2026-11-24).

## Why
The planner board page is hard to use: the Upcoming jobs column is ~5,000px of big cards (every suggested machine a card with two buttons, up to 8 per call, both days stacked), while the 2×2 board is mostly empty. The user plans around engineers' calls on quiet days and now uses the map for that. User: "Upcoming jobs should be PM's in area, left to right, compacted but can be expanded if hovered/clicked, then we can drag them to planned — asked engineer can be dropped"; "do we need a done column, just booked if it picks up that we've booked it"; "map as the main screen", board second.

## What (decided with the user)
1. **Map is the planner's main screen.** `/pm/planner` opens on Map; Board is the second tab (`?view=board`). Old `?view=map` links keep working.
2. **Board = three columns left to right: PMs in area → Planned → Booked.** No Asked engineer column, no Done column.
3. **PMs in area** (was Upcoming jobs): compact. Per engineer → per call, one line (`11:00 St Catherine's School · 8 nearby`); hover or click expands to the machines, one line each (`customer · short model · overdue 8m · 0.4 mi`). Machines at the call's own site fold into one line (`St Catherine's — 6 machines here ▸`). Today / Tomorrow switch at the top instead of stacking both days. Machines already Planned/Booked are marked or hidden.
4. **Drag** a machine (or a same-site group) from PMs in area into Planned. A keyboard/menu fallback ("Add to plan" / "Ask <engineer>") stays for every card.
5. **Planned** = today's To plan + Asked. Asking an engineer (from PMs in area, the map's Ask button, or a card menu) puts the card in Planned with a tag `Asked <engineer> · <day>`; existing Asked cards migrate to Planned keeping their tag. The note text already appended (`Asked … for …`) can feed the tag.
6. **Booked** stays as now: automatic when a PM job for the machine appears in Vantage, or manual via the existing Mark-booked form.
7. **Done goes**: when a qualifying visit lands, the card leaves the board (no 14-day Done list). PM due still resets from the visit as today.
8. Cards stay grouped by county → district (→ patch) in Planned and Booked.

## Non-goals
No change to PM due, the map's behaviour (besides being the default tab), Vantage writes (none), notifications.

## Anti-goals
Must not lose a card silently (existing reason badges stay for cards leaving the due set). Must not lose the "who was asked" information.

## Approaches
1. **Reshape the existing board (columns + compact panel), keep `pm_plan` storage** — picked: `board_column` keeps `to_plan`/`asked` values (Asked shown inside Planned with a tag), `done` handling switches to "drop off". Minimal migration, map actions keep working.
2. Collapse `asked` into `to_plan` in the DB with a separate `asked_*` field — cleaner model but a migration and changes to `planFromMap`/`moveCard` for no visible gain.
3. New page — rejected; the user wants it in the planner.

## Left to the builder
Drag-and-drop library (native HTML5 DnD is fine; must also work via menu), exact compact styling, how Done rows already stored are cleaned up (hide immediately; optional one-off migration), whether `doneRetentionDays` setting is removed from settings UI.
