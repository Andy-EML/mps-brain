# PM Due Town Groups + Side Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/pm` shows at most 50 machines per page, grouped under town headers (worst towns first), with an e-commerce style side panel of multi-select facets (Town, County, Status, Model family, Customer) with counts, kept in the URL.

**Architecture:** All filtering stays in-memory on the rows `listPmDue` already returns. A pure module `apps/web/src/lib/pm-facets.ts` parses multi-value params, applies facets (OR within, AND across), counts each facet with the other facets applied, and groups/paginates by town. `PmRow` gains `areaCounty` (planner county). The page renders the panel, chips and group header rows; the CSV export reuses the same parse/apply.

**Tech Stack:** Next.js 16 app router (server components, GET forms/links), React 19, Drizzle, vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-11-24-pm-due-filters-design.md`

## Global Constraints

- PM due rows options: **10 / 20 / 50, default 50**; any other remembered value (cookie or URL, e.g. 100/200) → 50. Other lists keep `ROWS_OPTIONS = [10, 20, 50, 100, 200]`.
- Group header copy: `<Town> · <n> due · <m> overdue` plus `· ★ <p>` when p > 0 priority machines; continued group header suffix ` (continued)`. Blank town → `No town`, always last.
- Town grouping key: trimmed, case-folded, internal whitespace collapsed; display = most common original spelling (ties: first alphabetically).
- Town order default worst-first: overdue count desc, then due count desc, then name A–Z. Sort option `townSort=az` → name A–Z. Machines within a group keep the column sort.
- Page size counts machines, not header rows.
- Facets & URL params (repeatable): `town`, `county`, `status`, `family`, `customer`. OR within a facet, AND across. Each facet's counts = rows of the current tab + search + overdue-reason pill with every *other* facet applied. Old single-value `status`, `family`, `customer` URLs keep working (they are just one value).
- Facet list: top 8 by count, then `Show all (<n>)` revealing the rest with a filter box. Ticked values always shown even if outside top 8.
- County = `areaCounty` (postcode-district county via `countyFor`, the planner's county) else Vantage `County` else `Unknown`.
- Active filters as removable chips above the table + `Clear all`. Below `lg` the panel is behind a `Filters (<n>)` button.
- CSV export honours all facets (same functions as the page).
- Tabs, search box and overdue-reason pills unchanged. Read-only toward Vantage.
- Before each commit: `npm test`, `npm run typecheck`, `npm run lint` from repo root (3 known lint errors in `.superpowers/sdd/2026-11-18-pm-actions/*.ts` scratch files are pre-existing — ignore only those).

## Review Focus

1. Town spelled differently across customers ("NEWBURY", "Newbury ", "newbury") → one group, one facet entry (Task 2 test `town variants merge`).
2. A ticked facet value that has 0 matches after other filters → still shown ticked with `(0)` so it can be unticked (Task 2 test `ticked value with zero count stays`).
3. A page boundary in the middle of a town → next page starts with `<Town> (continued)` header and the counts in the header are the whole group's, not the page slice (Task 2 test `continued header keeps full counts`).
4. Remembered rows=100/200 cookie → page shows 50 and the picker shows 50 (Task 3 test).
5. Junk params (`town=` empty, `status=nonsense`, `family=abc`) → ignored, page renders (Task 2 test `parsePmFacets drops junk`).

---

### Task 1: Planner county on PM rows (DB)

**Files:** Modify `packages/db/src/queries/pm-queries.ts` (where `PmRow` is built); Test `packages/db/src/queries/pm-queries.test.ts` (or the existing pm-due test file that builds rows).

**Interfaces:**
- Produces: `PmRow.areaCounty: string | null` — `postcode_districts` row for `r.district` → its stored county (already `countyFor`-mapped by the worker); null when no district or not cached.

- [ ] **Step 1: Failing tests:** `areaCounty comes from the district cache` (district RG20 cached as Berkshire → `'Berkshire'`); `areaCounty null without cached district`.
- [ ] **Step 2:** Run focused file → FAIL. **Step 3:** Implement with one query of the cache per `listPmDue` call (no per-row queries). **Step 4:** PASS + `npm test`.
- [ ] **Step 5:** Commit `feat(db): planner county on PM rows`.

### Task 2: Facets and town groups (pure web lib)

**Files:** Create `apps/web/src/lib/pm-facets.ts`, `apps/web/src/lib/pm-facets.test.ts`.

**Interfaces:**
- Consumes: `PmRow` (incl. `town`, `areaCounty`, `county`, `customerName`, `familyId`/family name as already on the row — check the field the current `family` filter uses, `result.status`), plan priority (`r.plan.priority`), `overdueMonths`/status for counts.
- Produces:
  - `export const PM_FACETS = ['town', 'county', 'status', 'family', 'customer'] as const; export type PmFacet = (typeof PM_FACETS)[number]`
  - `export type PmFacetSelection = Record<PmFacet, string[]>`
  - `parsePmFacets(params: URLSearchParams | Record<string, string | string[] | undefined>): PmFacetSelection` — all values per key, trimmed, non-empty, de-duplicated; `status` only `PM_STATUSES`; `family` only digit strings.
  - `townKey(town: string | null): string` (`''` for blank) and `countyOf(r: PmRow): string`.
  - `facetValue(r: PmRow, f: PmFacet): string` — the key a row has for a facet (town key, county, status, family id, customer name).
  - `applyPmFacets(rows: PmRow[], sel: PmFacetSelection, except?: PmFacet): PmRow[]`
  - `export interface FacetOption { value: string; label: string; count: number; checked: boolean }`
  - `facetOptions(rows: PmRow[], sel: PmFacetSelection, f: PmFacet, labels?: Map<string, string>): FacetOption[]` — counts over `applyPmFacets(rows, sel, f)`; sorted count desc then label; ticked values with 0 count included.
  - `export interface TownGroup { key: string; label: string; due: number; overdue: number; priority: number; rows: PmRow[] }`
  - `groupByTown(rows: PmRow[], order: 'worst' | 'az'): TownGroup[]` — rows keep incoming order inside a group.
  - `export interface PageSlice { group: TownGroup; rows: PmRow[]; continued: boolean }`
  - `pageTownGroups(groups: TownGroup[], page: number, perPage: number): PageSlice[]`
  - `townHeader(g: TownGroup): string` — exact copy from Global Constraints.

- [ ] **Step 1: Failing tests:** `town variants merge`; `blank town is No town and last`; `worst-first order` and `az order`; `OR within facet, AND across`; `counts ignore own facet` (ticking Newbury doesn't zero Reading's town count); `ticked value with zero count stays`; `continued header keeps full counts` (group of 5, perPage 3 → page 2 first slice `continued: true`, header counts 5-based); `parsePmFacets drops junk`; `townHeader copy` (with and without priority).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): PM facets and town groups`.

### Task 3: PM rows cap 50

**Files:** Modify `apps/web/src/lib/list-state.ts` (+ test), `apps/web/src/lib/list-keep.ts` (`PM_DEFAULT_ROWS = 50`), `apps/web/src/app/(app)/pm/page.tsx` call sites.

**Interfaces:**
- Produces: `PM_ROWS_OPTIONS = [10, 20, 50] as const`; `parseListState`/rows picker accept an optional `rowsOptions` (default `ROWS_OPTIONS`); a value outside the options → the list's default rows.

- [ ] **Step 1: Failing tests:** `pm rows 100 falls back to 50` (URL and cookie paths); `other lists still allow 200`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(web): PM due shows at most 50 rows`.

### Task 4: Side panel, chips, group headers, export

**Files:**
- Create `apps/web/src/components/pm-facet-panel.tsx` (panel; `<details>`-based "Show all" with a client filter box is fine; mobile `Filters (n)` toggle), `apps/web/src/components/pm-filter-chips.tsx`.
- Modify `apps/web/src/app/(app)/pm/page.tsx` (layout: panel left `lg:grid-cols-[240px_minmax(0,1fr)]`, main column `min-w-0`; remove the Customer / Model family / Status selects; apply `applyPmFacets` after `applyPmView`; `groupByTown` + `pageTownGroups` replace `rows.slice`; header `<tr>` per slice spanning all columns; `townSort` control beside rows picker; `SearchInput` hidden params carry facet values), `apps/web/src/app/(app)/pm/filters.ts` (drop single `customer`/`family`/`status` from `PmFilters` in favour of facets, or keep parsing for compat — builder's call, URLs must keep working), `apps/web/src/app/(app)/pm/export/route.ts` (same parse/apply), `apps/web/src/lib/list-keep.ts` (`pmKeep` keeps facet params).
- Tests: extend `apps/web/src/app/(app)/pm/filters.test.ts` / export tests for facet params passing through `pmKeep` and export filtering.

Behaviour: facet checkboxes are a GET form (`action="/pm"`), auto-submit on change (small client wrapper) with a visible Apply button for no-JS; links reset `page`. Chips = links removing one value. Group header row styling matches planner area headers. `movedTo` / open-row logic keeps working with grouped paging (page of the open row computed from the flattened grouped order).

- [ ] **Step 1:** Failing tests for `pmKeep` keeping repeated facet params and export filtering by `town`.
- [ ] **Step 2:** Implement UI + wiring.
- [ ] **Step 3: Browser check** (user logs in): `/pm` at 1600×900 and 390px — panel, counts, ticking two towns shows both groups, chips remove, page 2 shows `(continued)` when split, rows picker offers 10/20/50, no horizontal page scroll, no console errors. Export link includes facet params.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run lint` green.
- [ ] **Step 5:** Commit `feat(web): PM due side filters and town groups`.

### Task 5: Docs

- [ ] Update `docs/HANDOFF.md` PM due section (facets, town groups, 50 cap). Commit `docs: PM due filters handoff`.
