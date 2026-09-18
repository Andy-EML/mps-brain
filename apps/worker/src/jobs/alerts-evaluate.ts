import { deviceAlerts, drmsEquipment, type Db } from '@mps/db';
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

const OFFLINE_TYPE = 'offline';

export interface AlertEvaluation {
  opened: number;
  cleared: number;
  open: number;
}

/**
 * Opens/clears "offline" alerts for devices that have reported counters before but have gone
 * quiet for more than `thresholdHours`. Devices that have never reported, or that are currently
 * `missingSince`/`Deleted` (tracked separately), are left untouched either way.
 */
export async function evaluateOfflineAlerts(db: Db, opts: { now: Date; thresholdHours: number }): Promise<AlertEvaluation> {
  const { now, thresholdHours } = opts;
  const cutoff = new Date(now.getTime() - thresholdHours * 3_600_000);

  const candidateFilter = and(
    isNull(drmsEquipment.missingSince),
    sql`upper(${drmsEquipment.status}) <> 'DELETED'`,
    isNotNull(drmsEquipment.lastCounterReceivedTime),
  );

  const stale = await db
    .select({ drmsId: drmsEquipment.drmsId, lastCounterReceivedTime: drmsEquipment.lastCounterReceivedTime })
    .from(drmsEquipment)
    .where(and(candidateFilter, lt(drmsEquipment.lastCounterReceivedTime, cutoff)));

  const fresh = await db
    .select({ drmsId: drmsEquipment.drmsId })
    .from(drmsEquipment)
    .where(and(candidateFilter, gte(drmsEquipment.lastCounterReceivedTime, cutoff)));

  const openAlerts = await db
    .select({ drmsId: deviceAlerts.drmsEquipmentId })
    .from(deviceAlerts)
    .where(and(eq(deviceAlerts.type, OFFLINE_TYPE), isNull(deviceAlerts.clearedAt)));
  const openSet = new Set(openAlerts.map((a) => a.drmsId));

  const toOpen = stale.filter((s) => !openSet.has(s.drmsId));
  const toClear = fresh.filter((f) => openSet.has(f.drmsId));

  if (toOpen.length > 0) {
    await db.insert(deviceAlerts).values(
      toOpen.map((s) => ({
        drmsEquipmentId: s.drmsId,
        type: OFFLINE_TYPE,
        firstDetectedAt: now,
        lastSeenReportAt: s.lastCounterReceivedTime,
        details: { thresholdHours },
      })),
    );
  }

  if (toClear.length > 0) {
    await db
      .update(deviceAlerts)
      .set({ clearedAt: now })
      .where(
        and(
          eq(deviceAlerts.type, OFFLINE_TYPE),
          isNull(deviceAlerts.clearedAt),
          inArray(
            deviceAlerts.drmsEquipmentId,
            toClear.map((f) => f.drmsId),
          ),
        ),
      );
  }

  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceAlerts)
    .where(and(eq(deviceAlerts.type, OFFLINE_TYPE), isNull(deviceAlerts.clearedAt)));

  return { opened: toOpen.length, cleared: toClear.length, open: n };
}
