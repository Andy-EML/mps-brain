import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceAlerts, drmsEquipment, users } from '../schema';

/**
 * The three states an alert can be in, as the `/alerts` page presents them.
 *
 * `acknowledged` is a subset of "not cleared": a person has taken the alert on, but the device is
 * still not reporting. Only the worker clears an alert, and only because the device came back.
 */
export type AlertStatus = 'open' | 'acknowledged' | 'cleared';

export interface AlertRow {
  id: number;
  drmsId: string;
  deviceName: string | null;
  serial: string | null;
  customerName: string | null;
  type: string;
  firstDetectedAt: Date;
  lastSeenReportAt: Date | null;
  clearedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedByName: string | null;
}

/** The `where` clause for one status, or `undefined` for "any". */
function statusFilter(status: AlertStatus | undefined) {
  if (status === 'open') return and(isNull(deviceAlerts.clearedAt), isNull(deviceAlerts.acknowledgedAt));
  if (status === 'acknowledged') return and(isNull(deviceAlerts.clearedAt), isNotNull(deviceAlerts.acknowledgedAt));
  if (status === 'cleared') return isNotNull(deviceAlerts.clearedAt);
  return undefined;
}

export async function listAlerts(
  db: Db,
  o: { includeCleared?: boolean; limit?: number; drmsId?: string; status?: AlertStatus } = {},
): Promise<AlertRow[]> {
  const limit = o.limit ?? 50;
  const conds = [
    // `status` is the precise filter the alerts page needs; `includeCleared` is the coarse one the
    // device page and the nav badge already use. Given both, the precise one wins.
    o.status ? statusFilter(o.status) : o.includeCleared ? undefined : isNull(deviceAlerts.clearedAt),
    o.drmsId ? eq(deviceAlerts.drmsEquipmentId, o.drmsId) : undefined,
  ].filter((c) => c !== undefined);
  const where = conds.length > 0 ? and(...conds) : undefined;

  return db
    .select({
      id: deviceAlerts.id,
      drmsId: deviceAlerts.drmsEquipmentId,
      deviceName: drmsEquipment.productName,
      serial: drmsEquipment.serial,
      customerName: drmsEquipment.customerName,
      type: deviceAlerts.type,
      firstDetectedAt: deviceAlerts.firstDetectedAt,
      lastSeenReportAt: deviceAlerts.lastSeenReportAt,
      clearedAt: deviceAlerts.clearedAt,
      acknowledgedAt: deviceAlerts.acknowledgedAt,
      acknowledgedByName: users.username,
    })
    .from(deviceAlerts)
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, deviceAlerts.drmsEquipmentId))
    .leftJoin(users, eq(users.id, deviceAlerts.acknowledgedBy))
    .where(where)
    .orderBy(desc(deviceAlerts.firstDetectedAt))
    .limit(limit);
}

export type AlertCounts = Record<AlertStatus, number>;

/**
 * How many alerts sit in each of the three states, for the tab row on `/alerts`. One grouped scan
 * rather than three counts, because the page needs all three on every request.
 */
export async function countAlerts(db: Db, o: { drmsId?: string } = {}): Promise<AlertCounts> {
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${deviceAlerts.clearedAt} is null and ${deviceAlerts.acknowledgedAt} is null)::int`,
      acknowledged: sql<number>`count(*) filter (where ${deviceAlerts.clearedAt} is null and ${deviceAlerts.acknowledgedAt} is not null)::int`,
      cleared: sql<number>`count(*) filter (where ${deviceAlerts.clearedAt} is not null)::int`,
    })
    .from(deviceAlerts)
    .where(o.drmsId ? eq(deviceAlerts.drmsEquipmentId, o.drmsId) : undefined);

  return { open: row?.open ?? 0, acknowledged: row?.acknowledged ?? 0, cleared: row?.cleared ?? 0 };
}
