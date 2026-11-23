# Customers accordion — short design

Date: 2026-11-23. Small change. Sketch shown to the user 2026-11-23 (screenshot of /customers with arrows on rows: "accordion that drops down and shows the machines rather than having to go in to a page for each customer … quick status view"); no corrections.

## Why
Seeing a customer's machines and their state today means opening each customer page. User wants a quick status view inline; the customer page stays.

## What
- `/customers` rows expand in place (click anywhere on the row except the name link; chevron + keyboard: Enter/Space, `aria-expanded`). Customer name stays a link to `/customers/[id]` (with back).
- Expanded site row: one line per machine (same machine set the Machines count uses): model, serial, location, toner bars (K/C/M/Y, mono = K only, same component the device list uses), PM status chip (due by pages/time, due soon, ok, booked, unknown), pending toner orders count, last reading date; warnings: no reading ≥ 7 days, PM overdue, pending order. Each machine line links to its device page with `back` = current list URL. Footer link "Open customer page →".
- Collapsed row: red **!** when any machine has a warning (tooltip lists counts). PM warning ! links to `/pm` filtered to that customer.
- Head offices tab: HO row expands to its sites (each site row shows counts + !), a site expands to its machines.
- Lazy: machine lines load on first expand (server action or route returning rows for one customer); list page stays as fast as now. Expanded state kept in URL (`open=<ids>`) is not required — builder's call.
- Other-dealer badge column comes with the PM planner project, not here.

## Approaches
1. Inline lazy accordion on the existing list — picked (keeps paging/sort/back from list controls).
2. Eager-load every customer's machines — rejected: 476+ customers × machines on every page load.
3. Separate "status" page — rejected: user wants it on the Customers list.

## Left to builder
Component structure (reuse device-table pieces, toner bars, PM chip), query shape (one query per expanded customer), styling consistent with the Toner orders accordion.
