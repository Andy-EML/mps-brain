# PM map — design

Date: 2026-11-24. Status: draft, awaiting user approval.

## Why

The PM planner (`/pm/planner`) groups due PMs by county → postcode district, but you cannot *see* how close machines are. On quiet days the office wants to:

1. **Fill an engineer's day around his booked calls** so he does not travel all over the place (user, 2026-11-24).
2. **Bang out a batch of PMs in one area** — spot a cluster of due machines and send someone (user, 2026-11-24).

Success: on a quiet day the office opens the map, sees due PMs and the engineers' booked calls, draws a box round a cluster, and puts those machines on the plan (or marks them "asked engineer" for a call) without leaving the map.

## Goals

- A **Map** view on `/pm/planner` (Board | Map switch), same page, same data rules as the board.
- Pins for **every due PM**, not only board machines: overdue (red), due soon (amber), when-in-area (grey/muted), priority (star marker). Excluded: other dealer, dismissed, already booked (open `pm_actions` booked or Vantage PM job) — same exclusions as Upcoming-jobs suggestions.
- Machines already on the board show their column (e.g. ring/outline + "Asked engineer" in popup) so the user does not re-add them.
- **Engineer calls** for a chosen day (today / tomorrow, as Upcoming jobs) as distinct markers; side panel lists engineers → calls. Clicking a call centres the map on it and draws a ring of `nearMiles` (planner setting, default 10).
- **Clustering**: pins merge into numbered bubbles when zoomed out.
- **Box select** (decided by user): draw a box round pins → they become the selection. Selection panel lists the machines (customer, model, serial, due state) with per-row untick.
- **Act from the map** (decided by user), on the selection:
  - **Add to plan** → To plan (existing `addToPlan`, already takes many ids).
  - **Ask engineer for <call>** → Asked engineer with note `Asked <engineer> for <day>` (existing `moveCard` + `askNote`), call chosen from the selected/centred call. One action for the whole selection.
- Popup per pin: customer, site town, model, serial, due state ("overdue 8m"), link to device page and customer page, single-machine Add to plan / priority toggle.

## Non-goals

- No routing / drive times / optimised route order.
- No engineer live location (`EngineerHeartbeat` stays out of scope).
- No writes to Vantage; no messages to engineers (same as planner).
- No mobile-first design; must not break at phone width, but the map is a desktop tool.

## Anti-goals

- Customer names/addresses must not be sent to any outside service. Tiles are fetched by viewport only; pins are drawn locally.
- The map must not show a machine in a wrong place without saying so: machines placed by postcode-district centre (no customer lat/long) are marked "approximate location".
- Must not duplicate planner state: map reads/writes the same `pm_plan` / `pm_actions` as the board.

## Constraints

- Next.js 16 app router, server actions for writes (existing pattern in `pm/planner/actions.ts`), Tailwind tokens as the rest of the app.
- Location per machine: its customer's Vantage Latitude/Longitude (836/897 customers); else the cached postcode-district centroid (`postcode_districts`); else not on map (count shown: "12 machines have no location").
- Tiles: OpenStreetMap standard tiles with attribution; internal low-volume use is within OSM tile policy. Tile URL in one constant so it can be swapped.

## Approaches

1. **Leaflet + react-leaflet + leaflet.markercluster, OSM tiles** — picked (builder's call, user handed over the how). Small, free, no API key; clustering and box drawing are well-trodden.
2. **MapLibre GL (vector tiles)** — smoother zoom, but heavier, needs a vector tile source, nothing the use case needs.
3. **Google Maps JS** — familiar look, but needs a billed API key and sends usage to Google.

## Box select

- Toolbar button "Select area" (and Shift+drag shortcut): next drag draws a rectangle instead of panning; pins inside (including those inside clusters) are selected. Further boxes add to the selection; "Clear" empties it.
- Selection is client state only (lost on reload) — builder's call.

## Left to the builder

- Component split, how map data is loaded (server component passes a compact pin list; client map component renders it), marker icons.
- Whether Board | Map is a tab via `?view=map` (preferred: keeps back/refresh) or a route.
- Limits: if the selection is large (> 50), confirm before acting.
- Exact colours (match existing PM chips: Overdue red, due soon amber).

## Calls made after builder check (mine, user to check)

- **No page reload on map actions.** Map actions are new server actions that return a result instead of redirecting; the map keeps zoom, pan and day. After an action the selection clears and the acted-on pins change look (outlined, "To plan" / "Asked engineer" in popup). A small toast says "4 added to plan" / "3 asked Dave for Wed 25 Nov".
- **Ask engineer for many machines**: one transaction per machine, partial success reported ("3 asked, 1 skipped: already booked"). Machines in To plan move to Asked; machines already in Asked get the extra note line (same as single ask today). Booked / left-due machines are skipped with the reason.
- **Which pins**: every machine in PM due's Due set plus the When-in-area set, minus other dealer, dismissed and booked (open `pm_actions` booked or Vantage PM job). Done cards are not shown (they are not due). Board To plan / Asked machines show outlined with their column in the popup.
- **Location**: customer Latitude/Longitude (`vantage_customers.raw`), else `postcode_districts` centroid. Approximate pins are hollow, say "approximate — district centre" in the popup, and can be box-selected. Pins on identical coordinates spread out (spiderfy) when the cluster is clicked at max zoom.
- **Day of calls**: the map has its own Today / Tomorrow switch (default today; tomorrow after 4pm, same as nothing — builder may default to today). Calls without a location are listed in the side panel marked "no location" and not drawn.
- **Ask engineer target**: the call picked in the side panel (or clicked on the map). No call picked → the Ask button is disabled with "Pick a call first". Machines outside `nearMiles` of the call can still be asked; the confirm line says "2 of these are over 10 miles from the call".
- **Dependencies**: `leaflet`, `react-leaflet`, `leaflet.markercluster` (+ types); box select is custom (mouse drag rectangle → `bounds.contains`), no extra plugin. Map component loaded client-only (`next/dynamic`, `ssr: false`). No CSP in the app today; tile host `tile.openstreetmap.org` with attribution.
- **Large selection**: > 50 machines asks for confirmation in the app's own dialog style (not `window.confirm`).
