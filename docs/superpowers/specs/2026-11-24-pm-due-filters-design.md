# PM due — town groups and side filters (short design)

Date: 2026-11-24. Small project. User request (screenshot of `/pm` at 100 rows): "needs to be no more than 50 and also needs to listed by town … town as a filter … multiple filters like on an ecomm site … at the moment it is messy and hard to see what we should be looking at." User picked **A: grouped by town** (2026-11-24).

## Why
PM due mixes machines from all over the country in one long overdue-first list. The office wants to see, area by area, what is worth doing, and narrow to the places it cares about.

## What
- **Rows per page on PM due: 10 / 20 / 50, default 50.** A remembered 100/200 (cookie or URL) falls back to 50. Other lists keep their options.
- **Grouped by town.** Group header row per town: `Newbury · 14 due · 6 overdue` (+ `★ 2` when priority machines). Town = Vantage customer `Town`, trimmed, case-folded for grouping, shown in its most common spelling; blank → "No town" (last). Machines inside a group keep the chosen column sort (default: current urgency order). Towns ordered worst-first (most overdue, then most due, then name); a "Towns A–Z" sort option. A group split by paging repeats its header with "(continued)". Row count per page counts machines, not headers.
- **Side filter panel (e-commerce style)**, left of the table on desktop; a "Filters (n)" button opening it as a sheet below `lg`.
  - Facets, each a checkbox list with counts: **Town**, **County**, **Status** (overdue, due soon, …), **Model family**, **Customer**. Long lists show top 8 by count + "Show all (n)" with a search box.
  - Multiple ticks in one facet = OR; across facets = AND. Each facet's counts are computed with every *other* facet applied (standard faceted search), within the current tab and search box.
  - County = postcode-district county (the planner's county), else Vantage `County`, else "Unknown".
  - "Clear all" and per-facet clear; active filters shown as removable chips above the table.
  - State in the URL (`town=Newbury&town=Reading&status=overdue…`) so back/refresh/export keep it; export CSV honours the filters.
- Existing tabs (Due / When in area / Booked / Dismissed / Other dealer / All), search box and overdue-reason pills stay. The current Customer / Model family / Status selects move into the panel (old single-value URL params still read).

## Approaches
1. **Facets computed server-side from the rows already loaded** (`listPmDue` returns all rows; filtering/counting is in-memory in `filters.ts`) — picked: no new queries, URL-driven like the rest of the app.
2. Client-side filtering of a full list — rejected: ships every row to the browser, loses URL state.
3. SQL faceting — rejected: PM status is computed in TS, not SQL.

## Left to the builder
Component split, exact header styling (match planner area headers), how "Show all" search is done, mobile sheet component.
