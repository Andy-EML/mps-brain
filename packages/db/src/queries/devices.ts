import { deviceDisplayName, informativeEquipmentName } from '@mps/core';
import { and, count, eq, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import type { SelfManagedSource } from './customer-flags';
import { effectiveSettingsSubquery } from './settings';
import { shelfDevicesSubquery } from './site-stock';
import {
  belowThreshold,
  counterPivotSubquery,
  drmsEquipmentName,
  lastAlarmSubquery,
  notHiddenDevice,
  offlineCutoff,
  sortOrder,
  toNumberOrNull,
  type SortSpec,
} from './shared';

export interface DeviceRow {
  drmsId: string;
  serial: string | null;
  /** DRMS's product name ("bizhub C300i_Ver22"): the model with a firmware suffix. */
  name: string | null;
  /** DRMS's equipment `Name`, only when it says more than the model (usually the site); else null. */
  equipmentName: string | null;
  /** What to call the device on screen: see `deviceDisplayName` (@mps/core). */
  displayName: string;
  model: string | null;
  status: string | null;
  /**
   * Whether the device prints in colour, stored on the DRMS pull from the model name. Roughly half
   * the fleet is mono, and the UI needs the flag itself (not just null CMY readings) to know the
   * difference between "this device has no cyan cartridge" and "no cyan reading has arrived yet".
   */
  isColour: boolean;
  customerName: string | null;
  vantageCustomerName: string | null;
  vantageEquipmentId: number | null;
  /** The active link's Vantage customer (what the Self-managed badge links to); null when unlinked. */
  vantageCustomerId: number | null;
  linkMethod: string | null;
  /**
   * The customer manages its own stock (its own flag, or its head office's): no toner proposals of
   * any kind. Never true for an unlinked device. `selfManagedSource` says which flag set it.
   */
  selfManaged: boolean;
  selfManagedSource: SelfManagedSource | null;
  /** When DRMS last collected a meter counter set for this device. */
  lastCounterAt: Date | null;
  /**
   * **No meter reading** inside the threshold window: `lastCounterAt` is older than 24 h. It does
   * *not* mean the device is unreachable — DRMS collects counters roughly once a day, so a stalled
   * collection sets this on every reporting device at once. `lastAlarmAt` is the independent
   * signal of life. The field name is kept so `?filter=offline` links stay valid; the label on
   * screen is "No meter reading".
   */
  offline: boolean;
  /**
   * The newest alarm DRMS received from this device, or null if it has never raised one. The alarm
   * feed refreshes every ~27 min, so a recent value proves the device is reaching CSRC even when
   * no meter reading has arrived.
   */
  lastAlarmAt: Date | null;
  toner: { black: number | null; cyan: number | null; magenta: number | null; yellow: number | null };
  meters: { black: number | null; colour: number | null; scan: number | null };
}

export interface DeviceListOptions {
  search?: string;
  filter?: 'all' | 'needs-toner' | 'manual' | 'offline' | 'unlinked';
  /**
   * One customer, by the name the list shows: the linked Vantage customer's, else the one DRMS
   * reports (`deviceCustomerName`). Exact match — the value comes from `listDeviceFilterOptions`.
   */
  customer?: string;
  /** Colour or mono devices only, by the stored `is_colour` flag (`isColourModel` at DRMS pull). */
  colour?: 'colour' | 'mono';
  /** One DRMS model name, exactly. */
  model?: string;
  /**
   * `auto-off`: the effective setting has auto-replenishment switched off, whatever the toner
   * levels (the `manual` tab is the subset of these below threshold). `site-stock`: the device is on
   * a site stock shelf now, by `shelfDevicesSubquery`. `self-managed`: the device's customer (or its
   * head office) manages its own stock, by the effective settings' `selfManaged`.
   */
  replenish?: 'auto-off' | 'site-stock' | 'self-managed';
  limit?: number;
  offset?: number;
  /** Re-orders the page set only; the filters and the total are unchanged. */
  sort?: SortSpec<DeviceSortKey>;
}

/**
 * The devices list's sortable columns. `pages` (Pages / mo) is not here: the column is a
 * placeholder until meter history lands, so there is nothing to order by.
 */
export const DEVICE_SORT_KEYS = ['device', 'customer', 'model', 'serial', 'toner'] as const;
export type DeviceSortKey = (typeof DEVICE_SORT_KEYS)[number];

/** What picks the devices, as opposed to which page of them: everything but limit and offset. */
export type DeviceListFilters = Omit<DeviceListOptions, 'limit' | 'offset' | 'sort'>;

/**
 * The customer name a device row shows: the linked Vantage customer's, else the DRMS one. Needs
 * the joins from `joinDeviceList` (or the same two link/Vantage left joins).
 */
export function deviceCustomerName() {
  return sql<string | null>`coalesce(${vantageEquipment.customerName}, ${drmsEquipment.customerName})`;
}

/** The row fields; needs the joins from `joinDeviceList` (whose `eff` is passed here) plus `alarms`. */
export function deviceRowFields(
  pivot: ReturnType<typeof counterPivotSubquery>,
  alarms: ReturnType<typeof lastAlarmSubquery>,
  eff: ReturnType<typeof effectiveSettingsSubquery>,
) {
  return {
    lastAlarmAt: alarms.lastAlarmAt,
    drmsId: drmsEquipment.drmsId,
    serial: drmsEquipment.serial,
    name: drmsEquipment.productName,
    equipmentName: drmsEquipmentName(),
    model: drmsEquipment.modelName,
    status: drmsEquipment.status,
    isColour: drmsEquipment.isColour,
    customerName: drmsEquipment.customerName,
    vantageCustomerName: vantageEquipment.customerName,
    vantageEquipmentId: deviceLinks.vantageEquipmentId,
    vantageCustomerId: vantageEquipment.vantageCustomerId,
    linkMethod: deviceLinks.method,
    selfManaged: eff.selfManaged,
    selfManagedSource: eff.selfManagedSource,
    lastCounterAt: drmsEquipment.lastCounterReceivedTime,
    black: pivot.black,
    cyan: pivot.cyan,
    magenta: pivot.magenta,
    yellow: pivot.yellow,
    meterBlack: pivot.meterBlack,
    meterColour: pivot.meterColour,
    meterScan: pivot.meterScan,
  };
}

export interface RawDeviceRow {
  drmsId: string;
  serial: string | null;
  name: string | null;
  equipmentName: string | null;
  model: string | null;
  status: string | null;
  isColour: boolean;
  customerName: string | null;
  vantageCustomerName: string | null;
  vantageEquipmentId: number | null;
  vantageCustomerId: number | null;
  linkMethod: string | null;
  /** Null when the effective-settings row is missing (left join): read as false. */
  selfManaged: boolean | null;
  selfManagedSource: SelfManagedSource | null;
  lastCounterAt: Date | null;
  lastAlarmAt: Date | null;
  black: number | null;
  cyan: number | null;
  magenta: number | null;
  yellow: number | null;
  meterBlack: number | null;
  meterColour: number | null;
  meterScan: number | null;
}

/** The two name fields every `DeviceRow` carries, from the raw DRMS columns. */
export function deviceRowNames(r: {
  drmsId: string;
  serial: string | null;
  equipmentName: string | null;
  model: string | null;
  customerName: string | null;
  vantageCustomerName: string | null;
}): Pick<DeviceRow, 'equipmentName' | 'displayName'> {
  return {
    equipmentName: informativeEquipmentName(r.equipmentName, r.model),
    displayName: deviceDisplayName({
      equipmentName: r.equipmentName,
      customerName: r.vantageCustomerName ?? r.customerName,
      model: r.model,
      serial: r.serial,
      drmsId: r.drmsId,
    }),
  };
}

export function toDeviceRow(r: RawDeviceRow, cutoff: Date): DeviceRow {
  const lastCounterAt = r.lastCounterAt ?? null;
  return {
    drmsId: r.drmsId,
    serial: r.serial,
    name: r.name,
    ...deviceRowNames(r),
    model: r.model,
    status: r.status,
    isColour: r.isColour,
    customerName: r.customerName,
    vantageCustomerName: r.vantageCustomerName,
    vantageEquipmentId: r.vantageEquipmentId,
    vantageCustomerId: r.vantageCustomerId ?? null,
    linkMethod: r.linkMethod,
    selfManaged: r.selfManaged === true,
    selfManagedSource: r.selfManagedSource ?? null,
    lastCounterAt,
    offline: lastCounterAt !== null && lastCounterAt < cutoff,
    lastAlarmAt: r.lastAlarmAt ?? null,
    toner: {
      black: toNumberOrNull(r.black),
      cyan: toNumberOrNull(r.cyan),
      magenta: toNumberOrNull(r.magenta),
      yellow: toNumberOrNull(r.yellow),
    },
    meters: {
      black: toNumberOrNull(r.meterBlack),
      colour: toNumberOrNull(r.meterColour),
      scan: toNumberOrNull(r.meterScan),
    },
  };
}

/**
 * The search and filter half of the devices list: the counter pivot and effective-settings
 * subqueries it reads, and the WHERE built from them. `listDevices` and `resolveDeviceSelection`
 * (the bulk bar's "select all matching") both build on this, so the list an operator sees and the
 * devices a bulk edit reaches can never disagree. The tab (`filter`), the search and the customer,
 * colour, model and replenishment filters all AND together. Hidden devices are never in it — they
 * have their own tab (`listHiddenDevices`) — so no bulk action can reach one by accident. Join the
 * subqueries with `joinDeviceList`.
 */
export function deviceListConditions(db: Db, o: DeviceListFilters = {}) {
  const cutoff = offlineCutoff();
  const pivot = counterPivotSubquery(db);
  const eff = effectiveSettingsSubquery(db);

  const conds: (SQL | undefined)[] = [notHiddenDevice(drmsEquipment.drmsId)];
  if (o.search) {
    const q = `%${o.search}%`;
    conds.push(
      or(
        ilike(drmsEquipment.serial, q),
        ilike(drmsEquipment.productName, q),
        ilike(drmsEquipment.customerName, q),
        ilike(vantageEquipment.customerName, q),
      ),
    );
  }
  if (o.filter === 'needs-toner') {
    conds.push(and(belowThreshold(pivot, eff), eq(eff.autoReplenish, true)));
  } else if (o.filter === 'manual') {
    conds.push(and(belowThreshold(pivot, eff), eq(eff.autoReplenish, false)));
  } else if (o.filter === 'offline') {
    conds.push(and(isNotNull(drmsEquipment.lastCounterReceivedTime), lt(drmsEquipment.lastCounterReceivedTime, cutoff)));
  } else if (o.filter === 'unlinked') {
    conds.push(isNull(deviceLinks.vantageEquipmentId));
  }
  if (o.customer) conds.push(eq(deviceCustomerName(), o.customer));
  if (o.colour) conds.push(eq(drmsEquipment.isColour, o.colour === 'colour'));
  if (o.model) conds.push(eq(drmsEquipment.modelName, o.model));
  if (o.replenish === 'auto-off') {
    conds.push(eq(eff.autoReplenish, false));
  } else if (o.replenish === 'site-stock') {
    const shelved = shelfDevicesSubquery(db);
    conds.push(inArray(drmsEquipment.drmsId, db.select({ drmsId: shelved.drmsId }).from(shelved)));
  } else if (o.replenish === 'self-managed') {
    conds.push(eq(eff.selfManaged, true));
  }
  const where = and(...conds);
  return { cutoff, pivot, eff, where };
}

/**
 * The joins `deviceListConditions`' WHERE needs, on a `select(...).from(drmsEquipment).$dynamic()`:
 * the active link, its Vantage equipment, the counter pivot and the effective settings. Each is at
 * most one row per device, so none of them can multiply rows (or a count).
 *
 * Returned as `T` (a cast): callers select explicit fields, so a join does not change their row
 * shape, only whether Drizzle's types mark the joined columns nullable, which a caller that reads
 * one (`vantageCustomerId`) must treat as nullable anyway.
 */
export function joinDeviceList<T extends PgSelect>(qb: T, c: ReturnType<typeof deviceListConditions>): T {
  return qb
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(c.pivot, eq(c.pivot.drmsId, drmsEquipment.drmsId))
    // Left join, not inner: every DRMS device has an effective-settings row, but a missing one
    // should still return the device rather than drop it, just without matching needs-toner/manual.
    .leftJoin(c.eff, eq(c.eff.drmsId, drmsEquipment.drmsId)) as unknown as T;
}

/**
 * The devices list's order: customer A–Z (as the row shows it, case-insensitive, no customer
 * last), then DRMS's equipment Name (usually the site), then serial, then drms id so a page break
 * never falls between ties. Needs the joins from `joinDeviceList`.
 */
export function deviceListOrder(): SQL[] {
  return [
    sql`lower(${deviceCustomerName()}) asc nulls last`,
    sql`lower(${drmsEquipmentName()}) asc nulls last`,
    sql`${drmsEquipment.serial} asc nulls last`,
    sql`${drmsEquipment.drmsId} asc`,
  ];
}

/** `deviceDisplayName` (@mps/core) in SQL: DRMS Name, else customer + model, else serial, else id. */
export function deviceNameSort(): SQL {
  return sql`lower(coalesce(nullif(trim(${drmsEquipmentName()}), ''), nullif(trim(concat_ws(' ', ${deviceCustomerName()}, ${drmsEquipment.modelName})), ''), ${drmsEquipment.serial}, ${drmsEquipment.drmsId}))`;
}

/** `deviceListOrder`, or the chosen column; needs the joins from `joinDeviceList`. */
export function deviceSortOrder(
  pivot: ReturnType<typeof counterPivotSubquery>,
  sort: SortSpec<DeviceSortKey> | undefined,
): SQL[] {
  const map: Record<DeviceSortKey, SQL> = {
    device: deviceNameSort(),
    customer: sql`lower(${deviceCustomerName()})`,
    model: sql`lower(${drmsEquipment.modelName})`,
    serial: sql`${drmsEquipment.serial}`,
    // The lowest reading among the cartridges the device has (`least` skips nulls): the one that
    // runs out first, which is what the list's bars make the eye look for.
    toner: sql`least(${pivot.black}, ${pivot.cyan}, ${pivot.magenta}, ${pivot.yellow})`,
  };
  return sortOrder(map, sort, deviceListOrder, sql`${drmsEquipment.drmsId} asc`);
}

export async function listDevices(db: Db, o: DeviceListOptions = {}): Promise<{ rows: DeviceRow[]; total: number }> {
  const limit = o.limit ?? 50;
  const offset = o.offset ?? 0;
  const conds = deviceListConditions(db, o);
  const { cutoff, pivot, eff, where } = conds;
  const alarms = lastAlarmSubquery(db);

  const rowsQuery = joinDeviceList(db.select(deviceRowFields(pivot, alarms, eff)).from(drmsEquipment).$dynamic(), conds)
    // Already grouped to one row per device, so this cannot multiply rows (or the count below).
    .leftJoin(alarms, eq(alarms.drmsId, drmsEquipment.drmsId))
    .where(where)
    .orderBy(...deviceSortOrder(pivot, o.sort))
    .limit(limit)
    .offset(offset);

  const countQuery = joinDeviceList(db.select({ n: count() }).from(drmsEquipment).$dynamic(), conds).where(where);

  const [rows, [totalRow]] = await Promise.all([rowsQuery, countQuery]);
  return { rows: rows.map((r) => toDeviceRow(r as unknown as RawDeviceRow, cutoff)), total: totalRow?.n ?? 0 };
}

export interface DeviceFilterOptions {
  /** Every customer name a device row can show, A–Z (case-insensitive). */
  customers: string[];
  /** Every DRMS model name in the fleet, A–Z. */
  models: string[];
}

/**
 * The choices behind the devices list's customer and model pickers: only names some visible
 * (not hidden) device actually carries, so every choice finds at least one device.
 */
export async function listDeviceFilterOptions(db: Db): Promise<DeviceFilterOptions> {
  const customer = deviceCustomerName();
  const [customers, models] = await Promise.all([
    db
      .selectDistinct({ name: customer, sortKey: sql<string>`lower(${customer})` })
      .from(drmsEquipment)
      .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
      .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
      .where(and(isNotNull(customer), notHiddenDevice(drmsEquipment.drmsId)))
      .orderBy(sql`lower(${customer})`, customer),
    db
      .selectDistinct({ model: drmsEquipment.modelName, sortKey: sql<string>`lower(${drmsEquipment.modelName})` })
      .from(drmsEquipment)
      .where(and(isNotNull(drmsEquipment.modelName), notHiddenDevice(drmsEquipment.drmsId)))
      .orderBy(sql`lower(${drmsEquipment.modelName})`, drmsEquipment.modelName),
  ]);
  return {
    customers: customers.map((r) => r.name).filter((n): n is string => n !== null && n.trim() !== ''),
    models: models.map((r) => r.model).filter((m): m is string => m !== null && m.trim() !== ''),
  };
}
