# Customers section + self-managed stock

Status: design, 2026-11-20. Read-only towards Vantage and DRMS: nothing here writes to either system.

## Why (user, 2026-11-20)

- Some customers manage their own toner and consumable stock. The app must stop raising toner and consumable
  proposals for them.
- There is no place to see one customer as a whole. The user wants a Customers section where, on one page, they can
  see the customer's machines and orders, change the customer's settings, and adjust that customer's shelves.

## Goals

- `/customers` list and `/customers/[id]` page for each customer (keyed by Vantage customer id).
- A **Self-managed stock** switch on the customer. When it is on, none of the customer's machines get a proposal of
  any kind.
- On the customer page: customer settings (existing cascade), machines, recent toner orders, shelves (create, edit
  holdings, delete), all reusing existing components.

## Non-goals

- No writes to Vantage or DRMS. No customer creation or editing of Vantage customer data (name, address).
- No change to how the settings cascade (default -> customer -> device) works for anyone who is not self-managed.
- No change to offline alerts (they have their own "Alerts" setting) or PM due (machines still need servicing).
- Profitability and the PM map are separate projects, done after this one.

## Anti-goals

- A self-managed customer whose machines still get proposals by some side route (device override, shelf top-up,
  spare black). The switch must be absolute.
- Losing visibility: toner alarms on their machines must still be visible, just not acted on.

## Approaches (user picked A)

- **A. New absolute flag (picked).** A customer-level "self-managed" flag stored on its own, outside the settings
  cascade. It overrides every device setting and stops all proposal types. Costs one migration and a check in three
  worker jobs.
- Scope of the flag: user picked **per site + head office** over per-site only (per-site only meant 205 switches
  for Howden and missing new sites).
- **B. Reuse customer `autoReplenish = false`.** No migration, but a device-level "on" overrides it and shelf
  top-ups ignore auto-replenish entirely, so "self-managed" would not mean silent. Fixing that would change
  auto-replenish semantics for everyone. Rejected.

## Data

New table `customer_flags` (migration 0020):

| column | type | notes |
|---|---|---|
| `vantage_customer_id` | integer PK | Vantage customer id (same key as `replenishment_settings.vantage_customer_id`) |
| `self_managed` | boolean not null default false | |
| `self_managed_note` | text null | optional reason typed by the user |
| `updated_by` | integer -> users.id | |
| `updated_at` | timestamptz not null default now() | |

Its own table, not a column on `replenishment_settings`, because it is not part of the cascade (no device level, no
inherit) and the customer row there is deleted when a customer override is reset. Every change is written to the
existing audit log (`customer.self_managed.on` / `.off`, with the note).

**Head offices (user, 2026-11-20: option A).** In Vantage a customer is a site; 411 sites point at one of 110 head
offices via `raw->>'HeadOfficeId'` (Howden UK Brokers alone: 205 sites). The flag can be set on any customer record.
A **site is self-managed when it, or its head office, has `self_managed = true`**. So one switch on a head office
covers all its sites, including sites added later. Follow `HeadOfficeId` one level only (2 sites today have a head
office that itself has a head office; ignore the second hop — builder's call). No per-branch exceptions (if a
group needs one, that's a later change). The customer page shows where the flag comes from: "Self-managed (this
site)" or "Self-managed via head office <name>" with a link; a site under a flagged head office cannot switch it off
locally — the switch is shown on, disabled, with that link.

A head office's customer page also lists its **Sites** (name, town, machines, pending, self-managed source) and the
Machines/Orders/Shelves sections cover the head office's own record plus all its sites. The `/customers` list gets
a "Head offices" tab and a "Sites" count column for head offices.

A device is self-managed when its **active** link's Vantage equipment belongs to a self-managed customer (site or
via head office). Unlinked
devices are never self-managed (they get no proposals anyway). Expose this in one place, e.g. a `selfManaged`
column on `effectiveSettingsSubquery` (queries/settings.ts), so the worker, queue and pages read the same answer.

**Migration order:** add the table and restart the worker BEFORE any web code queries it (lesson from 0013: web
hot-reloads; a missing table breaks pages).

## Worker behaviour

When a device is self-managed:

1. **replenish-evaluate** (threshold + alarm): no new proposals; pending proposals for the device are superseded
   with note `customer self-managed`. Count it in run stats as `selfManaged` (like `autoOff`).
2. **spare-black**: ineligible reason `self_managed`, checked before `spare_off`. No proposal. Cartridge changes are
   still detected and recorded (so history is right if the switch is turned off later), but never proposed.
3. **site-stock-evaluate**: a shelf whose site customer is self-managed gets no top-up proposal; its pending top-up
   is superseded with the same note. Uses on the shelf are still counted.

Approved / In progress proposals and queued orders are left alone: the user has already decided to order those.

Turning the switch off: nothing is back-filled. The next worker runs propose normally from current levels and
alarms. Alarms received while self-managed that are still inside the normal alarm window can propose; that is
accepted.

The web action that flips the switch also supersedes pending proposals for the customer's devices straight away
(same note), so the Review queue empties without waiting for the next worker run.

## Pages

### Sidebar
New "Customers" entry between "Devices" and "Toner orders".

### `/customers` list
```
Customers                                       [search name / ref / town]
[With machines (n)] [Self-managed (n)] [All (n)]
Name                    Ref     Town        Machines  Pending  Shelves  Stock
Howden Central          HOWD01  Howden          12        3        2     Dealer
Hewetts                 HEWE01  Ashford          4        0        1     Self-managed
```
- Default tab "With machines": customers with at least one active linked DRMS device (same rule as
  `searchVantageCustomers`). "All" includes the rest of the Vantage customers (not deleted).
- Machines = active linked DRMS devices, not hidden. Pending = pending proposals. Shelves = shelves on any site of
  this customer.
- Row click -> customer page. Paginated like Devices.

### `/customers/[id]` customer page
```
< Customers
Howden Central  HOWD01 · Howden                    [Self-managed stock: OFF ▢]
--------------------------------------------------------------------------
Settings (customer level)        thresholds K/C/M/Y, auto-replenish, alerts,
                                 spare black — "Edit" opens the existing
                                 settings dialog at customer scope; "Reset"
                                 removes the override
Machines (12)                    existing device rows: model, serial,
                                 location, toner chips, last reading,
                                 shelf pill, auto-off/hidden badges
Toner orders (last 12 months)    existing OrderHistory, all machines,
                                 newest first, machine name on each line
Shelves (2)                      each shelf: family, holdings, used, live
                                 top-up; edit holdings inline (HoldingsForm),
                                 delete; "New shelf" pre-filled with this
                                 customer
```
- Self-managed switch: turning ON opens a confirm dialog that shows how many pending proposals it will clear and an
  optional note; turning OFF is a plain confirm. When ON, a banner across the page: "Self-managed stock — no toner
  proposals for this customer's machines" with who/when/note.
- Hidden machines are listed in a collapsed "Hidden (n)" group, not mixed in.

### Elsewhere
- Device page and device rows: a "Self-managed" badge (linking to the customer page) when the device is
  self-managed. Device Replenishment card shows "Customer manages its own stock" instead of proposal controls.
- Devices list + Fleet overview: a "Self-managed" filter, alongside the existing auto-off filter.
- Shelf page (`/site-stock/[id]`): banner when the shelf's customer is self-managed. Customer name links to the
  customer page.
- `/settings/replenishment` customer overrides: customer names link to the customer page.

## Reuse (don't rebuild)

`customer-override-dialogs.tsx` + `settings-dialog.tsx` (customer scope), `device-table-row.tsx`,
`order-history.tsx` / `listDeviceOrders`, `shelf-forms.tsx` (NewShelfDialog, HoldingsForm, DeleteShelfDialog),
`listShelves`, `queries/customers.ts` (extend), `notHiddenDevice()`.

## Calls I made (user can overrule)

- Self-managed machines stay in the Devices list and fleet counts, with a badge. They are still our machines.
- Existing shelves on a self-managed customer are kept (no top-ups) rather than deleted, so turning the switch off
  restores them.
- Approved / In progress proposals are not touched when the switch goes on.
- "Orders" on the customer page = Vantage toner sales orders for the last 12 months, filtered on order date (the
  app holds more; the page shows 12 months), not invoices.
- Any signed-in user can flip the switch and edit shelves on the customer page, same as the existing settings and
  site-stock actions (`requireUser`, not `requireAdmin`).
- Self-managed overrides the spare-black cover guard: pending `spare_used` proposals that a `cartridge_changes` row
  points at are superseded too (the customer orders its own spare). The cartridge change row is kept.
- Turning the switch on supersedes shelf top-ups by **both** routes: proposals on the customer's devices, and
  proposals whose `shelf_id` is a shelf of this customer.
- Town = `vantage_customers.raw->>'Town'` (already read this way by the PM list); searchable with name and ref.

## Left to the builder

Query shapes, component split, pagination size, exact badge styling, test layout. Follow the existing patterns in
`devices` and `site-stock` pages.
