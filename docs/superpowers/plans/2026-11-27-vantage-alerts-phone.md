# Vantage alert notes (popups) + customer phone — plan

User (2026-11-27): show the customer phone number where one is on record, and Vantage's alert popups ("call
ahead" and similar), on the customer page and in the device details. User said yes to the approach below.

## Facts (checked live, read-only, 2026-11-27)
- **Phone:** `vantage_customers.raw->>'PhoneNumber'` is filled on 543 of 899 customers. It's already synced, so
  it needs no Vantage call. `SiteAccessComment` is empty on all of them. Equipment has `PreferredContactId`;
  that's not used for now.
- **Alert notes:** Vantage's metadata has no CustomerNote or EquipmentNote entity set, and `/customer(id)/Notes`
  returns 404. The only route is the bound function `GET /user/GetNotesViaKeyword(search='<word>')`. It returns
  `NoteSearchResultComponent` {Id, Rank, ParentId, ParentType ("Customer" | "Equipment" | …), ParentReference
  (account ref or serial), Text, IsAlert, IsInternal, IsEmail, LoggedDate, LoggedBy, Created/Modified…}.
  - It supports `$top`, `$skip` and `$count`. `search='call'` has 611 hits.
  - Stopwords return 0 rows ('e', 'the'), and an empty search returns 400.
  - Examples: Customer APLA44 "2020 - Call ahead of service calls"; Equipment "IT Customer, 3CX/Phone Support
    ONLY"; Customer TELE01/1 "Waste Toner FOC - NO mobile phones on site".

## Rules
- **New worker job `vantage-alert-notes`, nightly.**
  - For each keyword in a list, page `GetNotesViaKeyword` and keep notes where `IsAlert = true` and ParentType is
    Customer or Equipment.
  - Upsert them into a new table `vantage_alert_notes` (note id PK, parent_type, parent_id, parent_reference, text,
    logged_date, logged_by, modified_date, raw, last_seen_at).
  - A note not seen for 7 days of runs is treated as gone (no longer alert / deleted) and hidden.
  - Starting keywords: call, ring, phone, ahead, access, key, keys, park, parking, reception, contact, before,
    arrive, arrival, visit, engineer, site, sign, security, badge, pass, gate, code, alarm, collect, delivery,
    toner, waste, do, not, only, must, please, ask, email, booking, appointment, hours, closed, open, lunch,
    school, term, holiday, covid, mask, ppe, induction, escort, lift, stairs, floor, office, manager, invoice,
    account, stop, credit, warning, important, note, always, never.
  - Keep the list in packages/core. Search words that return nothing cost one call each. Respect Vantage rate
    limits: run calls in sequence and reuse the existing client's paging and auth.
- **Cron:** nightly, an env var with a default like the other jobs. Add it to the admin jobs list and to "Run all" if
  that pattern fits.
- **Matching:**
  - A Customer note attaches to `vantage_customers` by Vantage id (ParentId).
  - An Equipment note attaches to `vantage_equipment` by ParentId.
  - The device view shows the device's own alerts plus its customer's alerts.
- **UI:**
  - Customer phone (as a `tel:` link) and that customer's alert notes, highlighted amber, on:
    - the customer page header
    - the device page
    - the PM map popup's Device details
    - the planner's PMs in area details box
    - the /pm row detail
  - Show the logged date and logged-by in small text.
  - Add a "Search Vantage notes" box: a server action that calls GetNotesViaKeyword live with the user's word
    and shows the results. Read-only; it needs a signed-in user.
- **No Vantage writes.**

## Addendum (user said yes to both, 2026-11-27): head office phone fallback + site contacts
Checked live, read-only. A device's Vantage customer record is its site. Of 1,357 live machines:
- 815 have a site phone.
- 197 have no site phone, but the head office (`raw->>'HeadOfficeId'`) has one.
- 345 have no phone on either.

Vantage `GET /customerperson` (filter `DeletedDate eq null`) has 1,706 people. 1,106 of them have a phone or
mobile, and 785 have `IsPrimary`. Fields: CustomerId, FirstName, LastName, FullName, Role, PhoneNumber,
PhoneNumberExtension, MobileNumber, EmailAddress, IsPrimary, plus Id/Modified fields.

1. **Phone fallback:** when the site's PhoneNumber is empty, use the head office's, labelled "Head office".
   - Applies on the device views and the customer page of a site.
   - A head office's own page shows its own number.
2. **Site contacts:**
   - New table `vantage_customer_people`: person id PK, customer_id, full name, role, phone, extension, mobile,
     email, is_primary, modified_date, raw, last_seen_at, deleted_at.
   - Pulled by the nightly alert-notes job (same run, separate stats), or by its own small job if that's cleaner.
     Full pull, with `$filter=DeletedDate eq null` and paging. Mark people missing from a full pull as deleted.
   - Show on the device views and the customer page: the primary contact first (name, role, `tel:` phone with
     extension, `tel:` mobile, `mailto:` email), then the site's other contacts in a collapsed "Other contacts (n)"
     list.
   - Head office contacts are not shown on sites.
