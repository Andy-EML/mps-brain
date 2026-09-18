import { ORDER_COLOURS, isOrderColour, type OrderColour } from '@mps/core';
import { and, asc, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../client';
import {
  counterNames,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import type { DeviceRow } from './devices';
import { counterPivotSubquery, lastAlarmSubquery, offlineCutoff, toNumberOrNull } from './shared';

export interface DeviceDetail {
  device: DeviceRow;
  drmsRaw: unknown;
  vantageRaw: unknown;
  latestSnapshotAt: Date | null;
  contractRef: string | null;
  /** The DRMS registration record, for the detail page's "Record" card. */
  record: {
    erpId: string | null;
    customerErpId: string | null;
    customerCsrcId: string | null;
    communicationType: string | null;
    registrationTime: Date | null;
    initialConnectionTime: Date | null;
  };
  /** The active Vantage link, for the detail page's "Links" card. Null fields when unlinked. */
  link: {
    vantageEquipmentId: number | null;
    assetNumber: string | null;
    description: string | null;
    location: string | null;
    customerName: string | null;
    method: string | null;
    linkedAt: Date | null;
  };
}

export async function getDevice(db: Db, drmsId: string): Promise<DeviceDetail | null> {
  const pivot = counterPivotSubquery(db);
  const alarms = lastAlarmSubquery(db);

  const [row] = await db
    .select({
      lastAlarmAt: alarms.lastAlarmAt,
      drmsId: drmsEquipment.drmsId,
      serial: drmsEquipment.serial,
      name: drmsEquipment.productName,
      model: drmsEquipment.modelName,
      status: drmsEquipment.status,
      isColour: drmsEquipment.isColour,
      customerName: drmsEquipment.customerName,
      vantageCustomerName: vantageEquipment.customerName,
      vantageEquipmentId: deviceLinks.vantageEquipmentId,
      linkMethod: deviceLinks.method,
      lastCounterAt: drmsEquipment.lastCounterReceivedTime,
      erpId: drmsEquipment.erpId,
      customerErpId: drmsEquipment.customerErpId,
      customerCsrcId: drmsEquipment.customerCsrcId,
      communicationType: drmsEquipment.communicationType,
      registrationTime: drmsEquipment.registrationTime,
      initialConnectionTime: drmsEquipment.initialConnectionTime,
      assetNumber: vantageEquipment.assetNumber,
      vantageDescription: vantageEquipment.description,
      vantageLocation: vantageEquipment.location,
      linkedAt: deviceLinks.linkedAt,
      black: pivot.black,
      cyan: pivot.cyan,
      magenta: pivot.magenta,
      yellow: pivot.yellow,
      meterBlack: pivot.meterBlack,
      meterColour: pivot.meterColour,
      meterScan: pivot.meterScan,
      drmsRaw: drmsEquipment.raw,
      vantageRaw: vantageEquipment.raw,
    })
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
    // Grouped to one row per device, so the detail query still returns exactly one row.
    .leftJoin(alarms, eq(alarms.drmsId, drmsEquipment.drmsId))
    .where(eq(drmsEquipment.drmsId, drmsId));

  if (!row) return null;

  const [snap] = await db
    .select({ latest: counterSnapshots.receivedTime })
    .from(counterSnapshots)
    .where(eq(counterSnapshots.drmsEquipmentId, drmsId))
    .orderBy(desc(counterSnapshots.id))
    .limit(1);

  const cutoff = offlineCutoff();
  const lastCounterAt = row.lastCounterAt ?? null;

  const device: DeviceRow = {
    drmsId: row.drmsId,
    serial: row.serial,
    name: row.name,
    model: row.model,
    status: row.status,
    isColour: row.isColour,
    customerName: row.customerName,
    vantageCustomerName: row.vantageCustomerName,
    vantageEquipmentId: row.vantageEquipmentId,
    linkMethod: row.linkMethod,
    lastCounterAt,
    offline: lastCounterAt !== null && lastCounterAt < cutoff,
    lastAlarmAt: row.lastAlarmAt ?? null,
    toner: {
      black: toNumberOrNull(row.black),
      cyan: toNumberOrNull(row.cyan),
      magenta: toNumberOrNull(row.magenta),
      yellow: toNumberOrNull(row.yellow),
    },
    meters: {
      black: toNumberOrNull(row.meterBlack),
      colour: toNumberOrNull(row.meterColour),
      scan: toNumberOrNull(row.meterScan),
    },
  };

  return {
    device,
    drmsRaw: row.drmsRaw,
    vantageRaw: row.vantageRaw ?? null,
    latestSnapshotAt: snap?.latest ?? null,
    // No contracts table/column exists yet anywhere in the schema or the Vantage client types;
    // there is nothing to derive this from. Always null until a contracts source is added.
    contractRef: null,
    record: {
      erpId: row.erpId,
      customerErpId: row.customerErpId,
      customerCsrcId: row.customerCsrcId,
      communicationType: row.communicationType,
      registrationTime: row.registrationTime,
      initialConnectionTime: row.initialConnectionTime,
    },
    link: {
      vantageEquipmentId: row.vantageEquipmentId,
      assetNumber: row.assetNumber,
      description: row.vantageDescription,
      location: row.vantageLocation,
      customerName: row.vantageCustomerName,
      method: row.linkMethod,
      linkedAt: row.linkedAt,
    },
  };
}

export interface CounterPoint {
  at: Date;
  value: number;
}

export async function getLatestCounters(
  db: Db,
  drmsId: string,
): Promise<{ name: string; value: number | null; category: string | null }[]> {
  const [latest] = await db
    .select({ id: counterSnapshots.id })
    .from(counterSnapshots)
    .where(eq(counterSnapshots.drmsEquipmentId, drmsId))
    .orderBy(desc(counterSnapshots.id))
    .limit(1);
  if (!latest) return [];

  return db
    .select({ name: counterValues.name, value: counterValues.value, category: counterNames.category })
    .from(counterValues)
    .leftJoin(counterNames, eq(counterNames.name, counterValues.name))
    .where(eq(counterValues.snapshotId, latest.id))
    .orderBy(asc(counterValues.name));
}

export async function getCounterHistory(
  db: Db,
  drmsId: string,
  names: string[],
  days = 90,
): Promise<Record<string, CounterPoint[]>> {
  const result: Record<string, CounterPoint[]> = {};
  for (const name of names) result[name] = [];
  if (names.length === 0) return result;

  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({ name: counterValues.name, value: counterValues.value, at: counterSnapshots.receivedTime })
    .from(counterValues)
    .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
    .where(
      and(
        eq(counterSnapshots.drmsEquipmentId, drmsId),
        inArray(counterValues.name, names),
        gte(counterSnapshots.receivedTime, since),
      ),
    )
    .orderBy(asc(counterSnapshots.receivedTime), asc(counterSnapshots.id));

  for (const r of rows) {
    if (r.value === null || r.at === null) continue;
    result[r.name]?.push({ at: r.at, value: r.value });
  }
  return result;
}

export interface DeviceAlarmRow {
  alarmId: string;
  receivedTime: Date;
  fcCode: string | null;
  scCode: string | null;
  description: string | null;
  status: string | null;
  category: string | null;
  totalCount: number | null;
  totalColorCount: number | null;
}

/** A device's alarms, newest first (DRMS collects these roughly every 27 min — see drms-alarms job). */
export async function listDeviceAlarms(
  db: Db,
  drmsId: string,
  opts: { limit?: number; categories?: string[] } = {},
): Promise<DeviceAlarmRow[]> {
  const limit = opts.limit ?? 50;
  const conds = [eq(deviceAlarms.drmsEquipmentId, drmsId)];
  if (opts.categories && opts.categories.length > 0) conds.push(inArray(deviceAlarms.category, opts.categories));

  return db
    .select({
      alarmId: deviceAlarms.alarmId,
      receivedTime: deviceAlarms.receivedTime,
      fcCode: deviceAlarms.fcCode,
      scCode: deviceAlarms.scCode,
      description: deviceAlarms.description,
      status: deviceAlarms.status,
      category: deviceAlarms.category,
      totalCount: deviceAlarms.totalCount,
      totalColorCount: deviceAlarms.totalColorCount,
    })
    .from(deviceAlarms)
    .where(and(...conds))
    .orderBy(desc(deviceAlarms.receivedTime))
    .limit(limit);
}

export interface DeviceOrderLineRow {
  vantageId: number;
  vantageEquipmentId: number | null;
  itemPartNumber: string | null;
  itemDescription: string | null;
  /** The line's `Details` free text, shown verbatim — it is the only readable label on `MISC` lines. */
  details: string | null;
  quantity: number | null;
  returnedDate: Date | null;
  colour: string | null;
  colourSource: string | null;
}

export interface DeviceOrderRow {
  vantageId: number;
  reference: string | null;
  orderDate: Date | null;
  completedDate: Date | null;
  isOnHold: boolean | null;
  typeName: string | null;
  createdByMps: boolean;
  /** Derived: Vantage has no status field, `completedDate is null` is the open flag. */
  open: boolean;
  lines: DeviceOrderLineRow[];
}

export interface DeviceOrderColourSummary {
  partNumber: string | null;
  /** The line's `Details`, falling back to the item description. */
  description: string | null;
  quantity: number | null;
  orderDate: Date | null;
  reference: string | null;
  orderOpen: boolean;
}

export interface DeviceOrders {
  orders: DeviceOrderRow[];
  /** The most recent non-returned line per colour; `null` when nothing of that colour ever went out. */
  lastByColour: Record<OrderColour, DeviceOrderColourSummary | null>;
}

/** Orders shown in the device card by default. */
const ORDER_LIMIT = 10;
/**
 * How far back the per-colour summary looks, independent of `limit`: "when did black last go out"
 * must not answer "never" merely because the answer fell off the bottom of a ten-row table.
 */
const COLOUR_SCAN_LIMIT = 200;

/**
 * A device's Vantage sales orders, newest first, each with its lines, plus the last non-returned
 * line per colour.
 *
 * Both link paths exist in Vantage: the order header can name the equipment, or only a line can.
 * Soft-deleted orders are excluded, like every other `vantage_*` read.
 */
export async function listDeviceOrders(
  db: Db,
  vantageEquipmentId: number,
  opts: { limit?: number } = {},
): Promise<DeviceOrders> {
  const limit = opts.limit ?? ORDER_LIMIT;

  const linkedByLine = db
    .select({ id: vantageSalesOrderLines.salesOrderId })
    .from(vantageSalesOrderLines)
    .where(eq(vantageSalesOrderLines.vantageEquipmentId, vantageEquipmentId));

  const headers = await db
    .select({
      vantageId: vantageSalesOrders.vantageId,
      reference: vantageSalesOrders.reference,
      orderDate: vantageSalesOrders.orderDate,
      completedDate: vantageSalesOrders.completedDate,
      isOnHold: vantageSalesOrders.isOnHold,
      typeName: vantageSalesOrders.typeName,
      createdByMps: vantageSalesOrders.createdByMps,
    })
    .from(vantageSalesOrders)
    .where(
      and(
        isNull(vantageSalesOrders.deletedDate),
        or(
          eq(vantageSalesOrders.vantageEquipmentId, vantageEquipmentId),
          inArray(vantageSalesOrders.vantageId, linkedByLine),
        ),
      ),
    )
    // `vantageId` breaks ties: ids grow with time, so two orders dated the same day still sort
    // newest first, and the order is stable across calls.
    .orderBy(desc(vantageSalesOrders.orderDate), desc(vantageSalesOrders.vantageId))
    .limit(COLOUR_SCAN_LIMIT);

  const empty = Object.fromEntries(ORDER_COLOURS.map((c) => [c, null])) as Record<
    OrderColour,
    DeviceOrderColourSummary | null
  >;
  if (headers.length === 0) return { orders: [], lastByColour: empty };

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
    .where(
      inArray(
        vantageSalesOrderLines.salesOrderId,
        headers.map((h) => h.vantageId),
      ),
    )
    // Ascending id is the order Vantage returned the lines in, which is what the chips follow.
    .orderBy(asc(vantageSalesOrderLines.salesOrderId), asc(vantageSalesOrderLines.vantageId));

  const linesByOrder = new Map<number, DeviceOrderLineRow[]>();
  for (const l of lineRows) {
    const { salesOrderId, quantity, ...rest } = l;
    const list = linesByOrder.get(salesOrderId) ?? [];
    list.push({ ...rest, quantity: toNumberOrNull(quantity) });
    linesByOrder.set(salesOrderId, list);
  }

  const scanned: DeviceOrderRow[] = headers.map((h) => ({
    ...h,
    open: h.completedDate === null,
    lines: linesByOrder.get(h.vantageId) ?? [],
  }));

  const lastByColour = { ...empty };
  // `scanned` is already newest first, so the first line of a colour we meet is the latest one.
  for (const order of scanned) {
    for (const line of order.lines) {
      if (line.returnedDate !== null) continue;
      if (!isOrderColour(line.colour) || lastByColour[line.colour] !== null) continue;
      lastByColour[line.colour] = {
        partNumber: line.itemPartNumber,
        description: line.details ?? line.itemDescription,
        quantity: line.quantity,
        orderDate: order.orderDate,
        reference: order.reference,
        orderOpen: order.open,
      };
    }
  }

  return { orders: scanned.slice(0, limit), lastByColour };
}
