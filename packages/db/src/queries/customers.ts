import { and, asc, count, countDistinct, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  customerFlags,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  siteStockShelves,
  vantageCustomers,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { getSelfManaged, headOfficeIdSql, selfManagedSourceSql, type SelfManagedInfo, type SelfManagedSource } from './customer-flags';
import type { DeviceOrderLineRow, DeviceOrderRow } from './device';
import {
  deviceListConditions,
  deviceListOrder,
  deviceRowFields,
  deviceRowNames,
  joinDeviceList,
  toDeviceRow,
  type DeviceRow,
  type RawDeviceRow,
} from './devices';
import { compareBy, drmsEquipmentName, lastAlarmSubquery, notHiddenDevice, toNumberOrNull, type SortSpec, type SortValue } from './shared';
import { listShelfSummariesByIds, type ShelfSummary } from './site-stock';

export interface VantageCustomerMatch {
  vantageId: number;
  name: string | null;
  reference: string | null;
  /** Linked DRMS devices — the machines a customer override would reach. */
  deviceCount: number;
}

/** `%` and `_` are wildcards to `ilike`; an operator typing them means the characters. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The customer picker on `/settings/replenishment`: Vantage customers by name or reference, only
 * those with at least one linked DRMS device (an override on any other customer would reach no
 * machine). Device counts follow `listCustomerSettings` — active links only.
 */
export async function searchVantageCustomers(db: Db, q: string, limit = 20): Promise<VantageCustomerMatch[]> {
  const pattern = containsPattern(q);
  const rows = await db
    .select({
      vantageId: vantageCustomers.vantageId,
      name: vantageCustomers.name,
      reference: vantageCustomers.reference,
      deviceCount: countDistinct(deviceLinks.drmsEquipmentId),
    })
    .from(vantageCustomers)
    .innerJoin(vantageEquipment, eq(vantageEquipment.vantageCustomerId, vantageCustomers.vantageId))
    .innerJoin(deviceLinks, and(eq(deviceLinks.vantageEquipmentId, vantageEquipment.vantageId), isNull(deviceLinks.unlinkedAt)))
    .where(
      and(
        isNull(vantageCustomers.deletedDate),
        or(ilike(vantageCustomers.name, pattern), ilike(vantageCustomers.reference, pattern)),
      ),
    )
    .groupBy(vantageCustomers.vantageId)
    .orderBy(asc(vantageCustomers.name), asc(vantageCustomers.vantageId))
    .limit(limit);
  return rows.map((r) => ({ ...r, deviceCount: Number(r.deviceCount) }));
}

export type CustomerTab = 'with-machines' | 'self-managed' | 'head-offices' | 'all';

export interface CustomerRow {
  vantageId: number;
  name: string | null;
  reference: string | null;
  town: string | null;
  /** Active linked, not hidden DRMS devices; a head office's row includes its sites'. */
  machines: number;
  /** Pending proposals on those devices. */
  pending: number;
  /** Shelves on this customer's own id (a head office's row includes its sites'). */
  shelves: number;
  /** Customers (not deleted) whose head office is this one; 0 for a site. */
  sites: number;
  selfManaged: SelfManagedSource | null;
  /** Deleted in Vantage; such a customer is only listed when its own self-managed flag is on. */
  deleted: boolean;
}

const townSql = sql<string | null>`nullif(btrim(${vantageCustomers.raw}->>'Town'), '')`;

/** Per-customer figures, by the customer the device's active link points at. One grouped query each. */
async function ownStats(db: Db) {
  const customerId = vantageEquipment.vantageCustomerId;
  const activeLink = and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt));
  const [machines, pending, shelves] = await Promise.all([
    db
      .select({ id: customerId, n: countDistinct(drmsEquipment.drmsId) })
      .from(drmsEquipment)
      .innerJoin(deviceLinks, activeLink)
      .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
      .where(and(isNotNull(customerId), notHiddenDevice(drmsEquipment.drmsId)))
      .groupBy(customerId),
    db
      .select({ id: customerId, n: count() })
      .from(replenishmentProposals)
      .innerJoin(
        deviceLinks,
        and(eq(deviceLinks.drmsEquipmentId, replenishmentProposals.drmsEquipmentId), isNull(deviceLinks.unlinkedAt)),
      )
      .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
      .where(
        and(
          isNotNull(customerId),
          eq(replenishmentProposals.status, 'pending'),
          notHiddenDevice(replenishmentProposals.drmsEquipmentId),
        ),
      )
      .groupBy(customerId),
    db
      .select({ id: siteStockShelves.vantageCustomerId, n: count() })
      .from(siteStockShelves)
      .groupBy(siteStockShelves.vantageCustomerId),
  ]);
  const toMap = (rows: { id: number | null; n: number | string }[]) =>
    new Map(rows.map((r) => [r.id as number, Number(r.n)]));
  return { machines: toMap(machines), pending: toMap(pending), shelves: toMap(shelves) };
}

/**
 * A customer row has its own self-managed flag on (the deleted customers the list still shows).
 * Read through a derived table with unique column names, as `selfManagedSourceSql` does, because
 * the outer column renders unqualified in this single-table select.
 */
const ownFlagOn = sql`exists (
  select 1 from (select ${customerFlags.vantageCustomerId} as cl_flag_id, ${customerFlags.selfManaged} as cl_flag_on from ${customerFlags}) cl_flag
  where cl_flag.cl_flag_id = ${vantageCustomers.vantageId} and cl_flag.cl_flag_on
)`;

/**
 * Every non-deleted customer matching the filters as a `CustomerRow`, name A–Z — plus, with
 * `includeDeletedFlagged`, deleted ones whose own flag is on (so a flag left on a head office
 * deleted in Vantage can be found and turned off). Figures are computed set-wise: three grouped
 * queries plus one (id, head office) pair list, folded in memory, so a head office's row can
 * include its sites' without a query per row.
 */
async function loadCustomerRows(
  db: Db,
  o: { search?: string; headOfficeId?: number; includeDeletedFlagged?: boolean } = {},
): Promise<CustomerRow[]> {
  const headOffice = headOfficeIdSql();
  const search = o.search?.trim();
  const pattern = search ? containsPattern(search) : null;
  const conds = [
    o.includeDeletedFlagged ? or(isNull(vantageCustomers.deletedDate), ownFlagOn) : isNull(vantageCustomers.deletedDate),
    pattern ? or(ilike(vantageCustomers.name, pattern), ilike(vantageCustomers.reference, pattern), ilike(townSql, pattern)) : undefined,
    o.headOfficeId !== undefined ? sql`${headOffice} = ${o.headOfficeId}` : undefined,
  ];
  const [base, siteLinks, stats] = await Promise.all([
    db
      .select({
        vantageId: vantageCustomers.vantageId,
        name: vantageCustomers.name,
        reference: vantageCustomers.reference,
        town: townSql,
        selfManaged: selfManagedSourceSql(vantageCustomers.vantageId),
        deleted: sql<boolean>`${vantageCustomers.deletedDate} is not null`,
      })
      .from(vantageCustomers)
      .where(and(...conds))
      .orderBy(sql`lower(${vantageCustomers.name}) asc nulls last`, asc(vantageCustomers.vantageId)),
    db
      .select({ id: vantageCustomers.vantageId, headOfficeId: headOffice })
      .from(vantageCustomers)
      .where(and(isNull(vantageCustomers.deletedDate), isNotNull(headOffice))),
    ownStats(db),
  ]);
  const sitesOf = new Map<number, number[]>();
  for (const l of siteLinks) {
    const list = sitesOf.get(l.headOfficeId!) ?? [];
    list.push(l.id);
    sitesOf.set(l.headOfficeId!, list);
  }
  const sum = (m: Map<number, number>, ids: number[]) => ids.reduce((a, id) => a + (m.get(id) ?? 0), 0);
  return base.map((b) => {
    const sites = sitesOf.get(b.vantageId) ?? [];
    const scope = [b.vantageId, ...sites];
    return {
      vantageId: b.vantageId,
      name: b.name,
      reference: b.reference,
      town: b.town,
      machines: sum(stats.machines, scope),
      pending: sum(stats.pending, scope),
      shelves: sum(stats.shelves, scope),
      sites: sites.length,
      selfManaged: b.selfManaged,
      deleted: b.deleted,
    };
  });
}

export const CUSTOMER_SORT_KEYS = ['name', 'ref', 'town', 'machines', 'pending', 'shelves', 'sites', 'stock'] as const;
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];

const CUSTOMER_SORT: Record<CustomerSortKey, (r: CustomerRow) => SortValue> = {
  name: (r) => r.name,
  ref: (r) => r.reference,
  town: (r) => r.town,
  machines: (r) => r.machines,
  pending: (r) => r.pending,
  shelves: (r) => r.shelves,
  sites: (r) => r.sites,
  stock: (r) => r.selfManaged,
};

/** The rows in the chosen order (id as tiebreak, blanks last); no sort leaves them as given (name A-Z). */
export function sortCustomerRows(rows: CustomerRow[], sort?: SortSpec<CustomerSortKey>): CustomerRow[] {
  return sort ? [...rows].sort(compareBy(CUSTOMER_SORT, sort, (r) => r.vantageId)) : rows;
}

const TAB_FILTER: Record<CustomerTab, (r: CustomerRow) => boolean> = {
  'with-machines': (r) => !r.deleted && r.machines > 0,
  'self-managed': (r) => r.selfManaged !== null,
  'head-offices': (r) => !r.deleted && r.sites > 0,
  all: (r) => !r.deleted,
};

/**
 * The Customers list. Tabs: `with-machines` (at least one active linked, not hidden device — own
 * or a site's), `self-managed` (the flag is on, on the customer or its head office), `head-offices`
 * (has sites), `all`. The search (name, reference, town) narrows every tab and the counts alike.
 * A customer deleted in Vantage is shown only on `self-managed`, and only while its own flag is on.
 */
export async function listCustomers(
  db: Db,
  o: { tab?: CustomerTab; search?: string; sort?: SortSpec<CustomerSortKey>; limit?: number; offset?: number },
): Promise<{ rows: CustomerRow[]; total: number; counts: Record<CustomerTab, number> }> {
  const all = await loadCustomerRows(db, { search: o.search, includeDeletedFlagged: true });
  const counts = Object.fromEntries(
    (Object.keys(TAB_FILTER) as CustomerTab[]).map((tab) => [tab, all.filter(TAB_FILTER[tab]).length]),
  ) as Record<CustomerTab, number>;
  const filtered = sortCustomerRows(all.filter(TAB_FILTER[o.tab ?? 'with-machines']), o.sort);
  const offset = o.offset ?? 0;
  const limit = o.limit ?? 50;
  return { rows: filtered.slice(offset, offset + limit), total: filtered.length, counts };
}

export interface CustomerDetail {
  vantageId: number;
  name: string | null;
  reference: string | null;
  town: string | null;
  postCode: string | null;
  isOnStop: boolean | null;
  /** Deleted in Vantage (only returned when it has a flag row, so the switch can be turned off). */
  deleted: boolean;
  headOffice: { vantageId: number; name: string | null } | null;
  selfManaged: SelfManagedInfo;
  sites: CustomerRow[];
}

/**
 * One customer for its page; null when it does not exist, or is deleted in Vantage and has no
 * `customer_flags` row (a deleted customer with one is returned, `deleted: true`, so a flag left on
 * it can still be turned off).
 */
export async function getCustomer(db: Db, vantageId: number): Promise<CustomerDetail | null> {
  const [c] = await db
    .select({
      vantageId: vantageCustomers.vantageId,
      name: vantageCustomers.name,
      reference: vantageCustomers.reference,
      town: townSql,
      postCode: sql<string | null>`nullif(btrim(${vantageCustomers.raw}->>'PostCode'), '')`,
      isOnStop: vantageCustomers.isOnStop,
      deleted: sql<boolean>`${vantageCustomers.deletedDate} is not null`,
    })
    .from(vantageCustomers)
    .where(
      and(
        eq(vantageCustomers.vantageId, vantageId),
        or(
          isNull(vantageCustomers.deletedDate),
          sql`exists (select 1 from ${customerFlags} where ${customerFlags.vantageCustomerId} = ${vantageId})`,
        ),
      ),
    );
  if (!c) return null;
  const [selfManaged, sites] = await Promise.all([getSelfManaged(db, vantageId), loadCustomerRows(db, { headOfficeId: vantageId })]);
  return { ...c, headOffice: selfManaged.headOffice, selfManaged, sites };
}

/**
 * The devices of these customers (the page passes the customer, or a head office with its sites):
 * active-linked to equipment of one of them. `visible` is the `listDevices` row for each, in its
 * order; `hidden` the same row for the hidden ones, shown apart.
 */
export async function listCustomerDevices(
  db: Db,
  customerIds: number[],
): Promise<{ visible: DeviceRow[]; hidden: DeviceRow[] }> {
  if (customerIds.length === 0) return { visible: [], hidden: [] };
  const conds = deviceListConditions(db);
  const { cutoff, pivot, eff } = conds;
  const alarms = lastAlarmSubquery(db);
  const fetch = async (hidden: boolean): Promise<DeviceRow[]> => {
    const rows = await joinDeviceList(db.select(deviceRowFields(pivot, alarms, eff)).from(drmsEquipment).$dynamic(), conds)
      .leftJoin(alarms, eq(alarms.drmsId, drmsEquipment.drmsId))
      .where(
        and(
          inArray(vantageEquipment.vantageCustomerId, customerIds),
          hidden ? sql`not (${notHiddenDevice(drmsEquipment.drmsId)})` : notHiddenDevice(drmsEquipment.drmsId),
        ),
      )
      .orderBy(...deviceListOrder());
    return rows.map((r) => toDeviceRow(r as unknown as RawDeviceRow, cutoff));
  };
  const [visible, hidden] = await Promise.all([fetch(false), fetch(true)]);
  return { visible, hidden };
}

/** A sales order as `OrderHistory` takes it, plus which machine it was for. */
export interface CustomerOrder extends DeviceOrderRow {
  /** The machine's display name (DRMS device, else the Vantage equipment description/serial). */
  deviceName: string | null;
  /** The linked DRMS device, when the order's equipment has an active link. */
  drmsId: string | null;
}

/**
 * Toner sales orders (at least one line classified to a colour) for the equipment of these
 * customers, dated on or after `since`, newest first. An order links by its header's equipment or
 * by a line's, as on the device page; soft-deleted orders are excluded.
 */
export async function listCustomerOrders(db: Db, customerIds: number[], since: Date): Promise<CustomerOrder[]> {
  if (customerIds.length === 0) return [];
  const equipmentIds = db
    .select({ id: vantageEquipment.vantageId })
    .from(vantageEquipment)
    .where(inArray(vantageEquipment.vantageCustomerId, customerIds));
  const linkedByLine = db
    .select({ id: vantageSalesOrderLines.salesOrderId })
    .from(vantageSalesOrderLines)
    .where(inArray(vantageSalesOrderLines.vantageEquipmentId, equipmentIds));
  const tonerOrders = db
    .select({ id: vantageSalesOrderLines.salesOrderId })
    .from(vantageSalesOrderLines)
    .where(isNotNull(vantageSalesOrderLines.colour));

  const headers = await db
    .select({
      vantageId: vantageSalesOrders.vantageId,
      reference: vantageSalesOrders.reference,
      orderDate: vantageSalesOrders.orderDate,
      completedDate: vantageSalesOrders.completedDate,
      isOnHold: vantageSalesOrders.isOnHold,
      typeName: vantageSalesOrders.typeName,
      createdByMps: vantageSalesOrders.createdByMps,
      vantageEquipmentId: vantageSalesOrders.vantageEquipmentId,
    })
    .from(vantageSalesOrders)
    .where(
      and(
        isNull(vantageSalesOrders.deletedDate),
        sql`${vantageSalesOrders.orderDate} >= ${since}`,
        or(inArray(vantageSalesOrders.vantageEquipmentId, equipmentIds), inArray(vantageSalesOrders.vantageId, linkedByLine)),
        inArray(vantageSalesOrders.vantageId, tonerOrders),
      ),
    )
    .orderBy(sql`${vantageSalesOrders.orderDate} desc`, sql`${vantageSalesOrders.vantageId} desc`);
  if (headers.length === 0) return [];

  const lineRows = await db
    .select({
      vantageId: vantageSalesOrderLines.vantageId,
      salesOrderId: vantageSalesOrderLines.salesOrderId,
      vantageEquipmentId: vantageSalesOrderLines.vantageEquipmentId,
      itemPartNumber: vantageSalesOrderLines.itemPartNumber,
      itemDescription: vantageSalesOrderLines.itemDescription,
      details: vantageSalesOrderLines.details,
      quantity: vantageSalesOrderLines.quantity,
      returnedDate: vantageSalesOrderLines.returnedDate,
      colour: vantageSalesOrderLines.colour,
      colourSource: vantageSalesOrderLines.colourSource,
    })
    .from(vantageSalesOrderLines)
    .where(inArray(vantageSalesOrderLines.salesOrderId, headers.map((h) => h.vantageId)))
    .orderBy(asc(vantageSalesOrderLines.salesOrderId), asc(vantageSalesOrderLines.vantageId));
  const linesByOrder = new Map<number, DeviceOrderLineRow[]>();
  for (const l of lineRows) {
    const { salesOrderId, quantity, ...rest } = l;
    const list = linesByOrder.get(salesOrderId) ?? [];
    list.push({ ...rest, quantity: toNumberOrNull(quantity) });
    linesByOrder.set(salesOrderId, list);
  }

  // The machine each order is for: the header's equipment, else the first line that names one.
  const orderEquipment = new Map<number, number | null>(
    headers.map((h) => [
      h.vantageId,
      h.vantageEquipmentId ?? (linesByOrder.get(h.vantageId) ?? []).find((l) => l.vantageEquipmentId !== null)?.vantageEquipmentId ?? null,
    ]),
  );
  const wanted = [...new Set([...orderEquipment.values()].filter((x): x is number => x !== null))];
  const machines = wanted.length
    ? await db
        .select({
          vantageEquipmentId: vantageEquipment.vantageId,
          description: vantageEquipment.description,
          vantageSerial: vantageEquipment.serial,
          vantageCustomerName: vantageEquipment.customerName,
          drmsId: drmsEquipment.drmsId,
          serial: drmsEquipment.serial,
          equipmentName: drmsEquipmentName(),
          model: drmsEquipment.modelName,
          customerName: drmsEquipment.customerName,
        })
        .from(vantageEquipment)
        .leftJoin(deviceLinks, and(eq(deviceLinks.vantageEquipmentId, vantageEquipment.vantageId), isNull(deviceLinks.unlinkedAt)))
        .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, deviceLinks.drmsEquipmentId))
        .where(inArray(vantageEquipment.vantageId, wanted))
    : [];
  const machineById = new Map(machines.map((m) => [m.vantageEquipmentId, m]));

  return headers.map((h) => {
    const m = machineById.get(orderEquipment.get(h.vantageId) ?? -1);
    const deviceName = !m
      ? null
      : m.drmsId
        ? deviceRowNames({
            drmsId: m.drmsId,
            serial: m.serial,
            equipmentName: m.equipmentName,
            model: m.model,
            customerName: m.customerName,
            vantageCustomerName: m.vantageCustomerName,
          }).displayName
        : (m.description ?? m.vantageSerial ?? null);
    return {
      vantageId: h.vantageId,
      reference: h.reference,
      orderDate: h.orderDate,
      completedDate: h.completedDate,
      isOnHold: h.isOnHold,
      typeName: h.typeName,
      createdByMps: h.createdByMps,
      open: h.completedDate === null,
      lines: linesByOrder.get(h.vantageId) ?? [],
      deviceName,
      drmsId: m?.drmsId ?? null,
    };
  });
}

/** The shelves held at these customers (the page passes a head office with its sites), site then family. */
export async function listCustomerShelves(db: Db, customerIds: number[]): Promise<ShelfSummary[]> {
  if (customerIds.length === 0) return [];
  const ids = await db
    .select({ id: siteStockShelves.id })
    .from(siteStockShelves)
    .where(inArray(siteStockShelves.vantageCustomerId, customerIds));
  const shelves = await listShelfSummariesByIds(
    db,
    ids.map((r) => r.id),
  );
  return shelves.sort((a, b) => a.siteName.localeCompare(b.siteName) || a.familyName.localeCompare(b.familyName));
}
