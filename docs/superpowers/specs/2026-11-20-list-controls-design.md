# List controls: pager, rows per page, sortable headers, back keeps place

Status: approved 2026-11-20 (short design; user: "yep go for it").

## Why (user, 2026-11-20)
- Wants Vantage-style controls (screenshot of VO Customers): first / prev / page numbers / next / last and a
  rows-per-page picker (10, 20, 50, 100, 200), at the TOP and BOTTOM of lists.
- Wants sortable column headers on ALL screens.
- Bug: "Back to Devices" from a device opened on page 3 returns to page 1. Must return to the exact list view.

## Today
- `components/pagination.tsx`: bottom-only "Showing x–y of n" + Previous/Next. Used by Devices, Customers, PM due,
  Reconnect, Registrations, Link issues; page size fixed per page (50 or 100).
- Toner orders, Alerts, Site stock: unpaginated.
- `lib/device-origin.ts` already supports `?from=<key>&back=<list URL>` (validated by `safeBackPath`), but list rows
  pass only `from`, so Back drops page/filters.

## Design
1. **One shared `ListControls` bar** (server component, links only): `« ‹ [n…] › »`, up to 5 page numbers around
   the current, "Rows [50 ▾]" picker (10/20/50/100/200), "Showing 51–100 of 854 devices". Rendered above AND below
   every list table. Replaces `Pagination` everywhere.
2. **Rows per page** in `?rows=`; remembered per list in a cookie (`lc_rows_<list>`), URL wins over cookie, cookie
   over the list's current default. Changing rows resets to page 1.
3. **Sortable headers**: shared `SortHeader` link component; `?sort=<column key>&dir=asc|desc`; first click asc,
   second desc; arrow shows state. Sorting is server-side over the whole result (whitelisted column keys per list,
   mapped to SQL in the query; unknown keys fall back to the list's current default order). Each list keeps its
   current default order when no sort is given. Stable tiebreak on the row's id.
4. **Lists in scope**: Devices, Fleet overview device table, Customers, PM due, Reconnect, Registrations, Link
   issues, Alerts, Site stock list, Toner orders queue (Review / In progress / Probably on site tabs), Toner yield
   (/orders/yield). Accordion/grouped lists paginate by their top-level row (device / customer / shelf).
5. **Back keeps place**: every list -> detail link (device, customer, shelf, PM item) carries `back=<current list
   URL incl. page, rows, sort, tab, filters, search>`; detail pages' Back link + breadcrumb use it (existing
   `safeBackPath` validation extended to customer and shelf pages). Actions that redirect back to a detail page keep
   `back`.

## Approaches
- **Shared components + per-list sort whitelist (picked).** One bar and one header component; each list declares
  its sortable keys -> SQL. Consistent everywhere.
- Per-page copies of controls: rejected, 10+ lists would drift.
- Client-side sorting: rejected, sorts only the visible page.

## Non-goals
Customer/device accordion tree (next project, will reuse these controls); A–Z letter bar (not asked); column
chooser; saved views.

## Left to the builder
Exact sortable columns per list (every visible data column where a SQL expression exists; skip action/chip
columns), cookie mechanics, component split, mobile layout of the bar.
