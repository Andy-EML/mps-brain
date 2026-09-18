import { and, asc, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { counterNames, counterSnapshots, counterValues, deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import type { DeviceRow } from './devices';
import { counterPivotSubquery, offlineCutoff, toNumberOrNull } from './shared';

export interface DeviceDetail {
  device: DeviceRow;
  drmsRaw: unknown;
  vantageRaw: unknown;
  latestSnapshotAt: Date | null;
  contractRef: string | null;
}

export async function getDevice(db: Db, drmsId: string): Promise<DeviceDetail | null> {
  const pivot = counterPivotSubquery(db);

  const [row] = await db
    .select({
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
      drmsRaw: drmsEquipment.raw,
      vantageRaw: vantageEquipment.raw,
    })
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
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
    customerName: row.customerName,
    vantageCustomerName: row.vantageCustomerName,
    vantageEquipmentId: row.vantageEquipmentId,
    linkMethod: row.linkMethod,
    lastCounterAt,
    offline: lastCounterAt !== null && lastCounterAt < cutoff,
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
