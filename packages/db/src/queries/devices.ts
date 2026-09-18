import { and, asc, count, eq, ilike, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import { counterPivotSubquery, lastAlarmSubquery, offlineCutoff, toNumberOrNull } from './shared';

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
  filter?: 'all' | 'needs-toner' | 'offline' | 'unlinked';
  /**
   * `'urgent'` orders critical toner first, then low toner, then offline, then unlinked, then
   * everything else — the fleet overview's "most urgent first" preview. Ties break on device name
   * (falling back to serial, then drms id), case-insensitively. Mirrors `attentionRank` in
   * `apps/web/src/components/toner.ts`, but computed in SQL so it works over the whole table, not
   * just a capped scan. Default (omitted) keeps the existing `drmsId` order.
   */
  sort?: 'urgent';
  limit?: number;
  offset?: number;
}

function deviceRowFields(
  pivot: ReturnType<typeof counterPivotSubquery>,
  alarms: ReturnType<typeof lastAlarmSubquery>,
) {
  return {
    lastAlarmAt: alarms.lastAlarmAt,
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
  lastAlarmAt: Date | null;
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

export async function listDevices(db: Db, o: DeviceListOptions = {}): Promise<{ rows: DeviceRow[]; total: number }> {
  const limit = o.limit ?? 50;
  const offset = o.offset ?? 0;
  const cutoff = offlineCutoff();
  const pivot = counterPivotSubquery(db);
  const alarms = lastAlarmSubquery(db);

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

  // Mirrors `attentionRank` in apps/web/src/components/toner.ts: critical toner first, then low,
  // then offline, then unlinked, then "some data" ahead of "no counters at all". Each WHEN is
  // exclusive of the ones before it (e.g. the low branch only matches once critical has already
  // failed), so the priority order falls straight out of CASE's first-match semantics.
  const urgencyRank = sql<number>`
    case
      when ${pivot.black} < 5 or ${pivot.cyan} < 5 or ${pivot.magenta} < 5 or ${pivot.yellow} < 5 then 0
      when ${pivot.black} < 20 or ${pivot.cyan} < 20 or ${pivot.magenta} < 20 or ${pivot.yellow} < 20 then 1
      when ${drmsEquipment.lastCounterReceivedTime} is not null and ${drmsEquipment.lastCounterReceivedTime} < ${cutoff} then 2
      when ${deviceLinks.vantageEquipmentId} is null then 3
      when ${pivot.black} is null and ${pivot.cyan} is null and ${pivot.magenta} is null and ${pivot.yellow} is null then 5
      else 4
    end
  `;
  const urgencyTieBreak = sql`lower(coalesce(${drmsEquipment.productName}, ${drmsEquipment.serial}, ${drmsEquipment.drmsId}))`;
  const orderBy = o.sort === 'urgent' ? [urgencyRank, urgencyTieBreak] : [asc(drmsEquipment.drmsId)];

  const rowsQuery = db
    .select(deviceRowFields(pivot, alarms))
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
    // Already grouped to one row per device, so this cannot multiply rows (or the count below).
    .leftJoin(alarms, eq(alarms.drmsId, drmsEquipment.drmsId))
    .where(where)
    .orderBy(...orderBy)
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
