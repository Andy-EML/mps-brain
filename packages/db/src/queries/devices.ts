import { and, asc, count, eq, ilike, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import { counterPivotSubquery, offlineCutoff, toNumberOrNull } from './shared';

export interface DeviceRow {
  drmsId: string;
  serial: string | null;
  name: string | null;
  model: string | null;
  status: string | null;
  customerName: string | null;
  vantageCustomerName: string | null;
  vantageEquipmentId: number | null;
  linkMethod: string | null;
  lastCounterAt: Date | null;
  offline: boolean;
  toner: { black: number | null; cyan: number | null; magenta: number | null; yellow: number | null };
  meters: { black: number | null; colour: number | null; scan: number | null };
}

export interface DeviceListOptions {
  search?: string;
  filter?: 'all' | 'needs-toner' | 'offline' | 'unlinked';
  limit?: number;
  offset?: number;
}

function deviceRowFields(pivot: ReturnType<typeof counterPivotSubquery>) {
  return {
    drmsId: drmsEquipment.drmsId,
    serial: drmsEquipment.serial,
    name: drmsEquipment.productName,
    model: drmsEquipment.modelName,
    status: drmsEquipment.status,
    customerName: drmsEquipment.customerName,
    vantageCustomerName: vantageEquipment.customerName,
    vantageEquipmentId: deviceLinks.vantageEquipmentId,
    linkMethod: deviceLinks.method,
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

interface RawDeviceRow {
  drmsId: string;
  serial: string | null;
  name: string | null;
  model: string | null;
  status: string | null;
  customerName: string | null;
  vantageCustomerName: string | null;
  vantageEquipmentId: number | null;
  linkMethod: string | null;
  lastCounterAt: Date | null;
  black: number | null;
  cyan: number | null;
  magenta: number | null;
  yellow: number | null;
  meterBlack: number | null;
  meterColour: number | null;
  meterScan: number | null;
}

function toDeviceRow(r: RawDeviceRow, cutoff: Date): DeviceRow {
  const lastCounterAt = r.lastCounterAt ?? null;
  return {
    drmsId: r.drmsId,
    serial: r.serial,
    name: r.name,
    model: r.model,
    status: r.status,
    customerName: r.customerName,
    vantageCustomerName: r.vantageCustomerName,
    vantageEquipmentId: r.vantageEquipmentId,
    linkMethod: r.linkMethod,
    lastCounterAt,
    offline: lastCounterAt !== null && lastCounterAt < cutoff,
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

export async function listDevices(db: Db, o: DeviceListOptions = {}): Promise<{ rows: DeviceRow[]; total: number }> {
  const limit = o.limit ?? 50;
  const offset = o.offset ?? 0;
  const cutoff = offlineCutoff();
  const pivot = counterPivotSubquery(db);

  const conds = [];
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
    conds.push(or(lt(pivot.black, 20), lt(pivot.cyan, 20), lt(pivot.magenta, 20), lt(pivot.yellow, 20)));
  } else if (o.filter === 'offline') {
    conds.push(and(isNotNull(drmsEquipment.lastCounterReceivedTime), lt(drmsEquipment.lastCounterReceivedTime, cutoff)));
  } else if (o.filter === 'unlinked') {
    conds.push(isNull(deviceLinks.vantageEquipmentId));
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rowsQuery = db
    .select(deviceRowFields(pivot))
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
    .where(where)
    .orderBy(asc(drmsEquipment.drmsId))
    .limit(limit)
    .offset(offset);

  const countQuery = db
    .select({ n: count() })
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
    .where(where);

  const [rows, [totalRow]] = await Promise.all([rowsQuery, countQuery]);
  return { rows: rows.map((r) => toDeviceRow(r as unknown as RawDeviceRow, cutoff)), total: totalRow?.n ?? 0 };
}
