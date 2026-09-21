import { isCollectionOutage } from '@mps/core';
import { deviceAlerts, drmsEquipment, type Db } from '@mps/db';
import { effectiveSettingsSubquery } from '@mps/db/queries';
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

const OFFLINE_TYPE = 'offline';
const ALERTS_OFF_REASON = 'alerts switched off';

export interface AlertEvaluation {
  opened: number;
  cleared: number;
  open: number;
  /**
   * True when the fleet-wide collection-outage guard held: a large enough share of the devices
   * that have ever reported was stale (`COLLECTION_OUTAGE_STALE_RATIO`), so no new per-device
   * alert was opened. Clearing still ran.
   */
  skippedDueToOutage: boolean;
}

/**
 * Opens/clears `offline` alerts — which mean "DRMS collected no meter reading", not "the device is
 * unreachable" — for devices that have reported counters before but have gone quiet for more than
 * `thresholdHours`. Devices that have never reported, or that are currently `missingSince` /
 * `Deleted` (tracked separately), are left untouched either way.
 *
 * Guarded by `isCollectionOutage`: DRMS collects counters roughly once a day for the whole fleet,
 * so once the stale share of the reporting fleet reaches `COLLECTION_OUTAGE_STALE_RATIO` the cause
 * is the collection, not the devices, and one alert per device is pure noise (2026-09-18: 35
 * devices alerted at once while CSRC showed them all online, and again 30 of 35 the next day when
 * collection resumed for only a handful). During an outage nothing new opens, alerts already open
 * stay open, and a device that reports again still clears. `stale ∪ fresh` is exactly the candidate set, so the tally
 * needs no extra query and matches `getCollectionStatus` by construction.
 *
 * The outage ratio itself is a statement about DRMS collection, not about anyone's alert
 * preferences, and has to agree with the web banner (`getCollectionStatus`, which counts every
 * monitored device that has reported — no `alertsEnabled` filter). So `stale`/`fresh`, and the
 * ratio computed from them, cover every candidate device regardless of the per-device alerts
 * switch (`eff.alertsEnabled`). That switch only decides which stale device gets a *new* alert
 * opened (`toOpen`) and which fresh device's alert clears the "ordinary" way (`toClear`) — a
 * device with alerts off never gets either, but still counts toward whether the fleet looks like
 * it's mid-outage. Its own open alert (if any) is cleared unconditionally further down, tagged
 * with why, regardless of the outage guard.
 */
export async function evaluateOfflineAlerts(db: Db, opts: { now: Date; thresholdHours: number }): Promise<AlertEvaluation> {
  const { now, thresholdHours } = opts;
  const cutoff = new Date(now.getTime() - thresholdHours * 3_600_000);
  const eff = effectiveSettingsSubquery(db);

  const candidateFilter = and(
    isNull(drmsEquipment.missingSince),
    sql`upper(${drmsEquipment.status}) <> 'DELETED'`,
    isNotNull(drmsEquipment.lastCounterReceivedTime),
  );

  // Carries `alertsEnabled` alongside each candidate so the outage ratio below can use the full
  // set while `toOpen`/`toClear` narrow to alerts-on devices only. Every DRMS device has exactly
  // one effective-settings row, so the inner join can't drop a candidate (same pattern as
  // `replenish-evaluate.ts`'s device query).
  const stale = await db
    .select({
      drmsId: drmsEquipment.drmsId,
      lastCounterReceivedTime: drmsEquipment.lastCounterReceivedTime,
      alertsEnabled: eff.alertsEnabled,
    })
    .from(drmsEquipment)
    .innerJoin(eff, eq(eff.drmsId, drmsEquipment.drmsId))
    .where(and(candidateFilter, lt(drmsEquipment.lastCounterReceivedTime, cutoff)));

  const fresh = await db
    .select({ drmsId: drmsEquipment.drmsId, alertsEnabled: eff.alertsEnabled })
    .from(drmsEquipment)
    .innerJoin(eff, eq(eff.drmsId, drmsEquipment.drmsId))
    .where(and(candidateFilter, gte(drmsEquipment.lastCounterReceivedTime, cutoff)));

  const openAlerts = await db
    .select({ drmsId: deviceAlerts.drmsEquipmentId })
    .from(deviceAlerts)
    .where(and(eq(deviceAlerts.type, OFFLINE_TYPE), isNull(deviceAlerts.clearedAt)));
  const openSet = new Set(openAlerts.map((a) => a.drmsId));

  // Unrestricted by the alerts switch — see the doc comment above.
  const skippedDueToOutage = isCollectionOutage({
    devicesExpectingReadings: stale.length + fresh.length,
    devicesStale: stale.length,
  });

  const toOpen = skippedDueToOutage ? [] : stale.filter((s) => !openSet.has(s.drmsId) && s.alertsEnabled);
  // Alerts-on only: a fresh alerts-off device's open alert is cleared by the dedicated step below
  // instead, tagged with why, so a device can't be cleared twice or with the wrong reason.
  const toClear = fresh.filter((f) => openSet.has(f.drmsId) && f.alertsEnabled);

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

  // A device whose alerts switch is off keeps no open offline alert, whatever its counters say —
  // `toClear` above deliberately skips it (see its comment), so this is the only place that
  // clears one, whether it's stale or has just reported again. Runs regardless of the outage
  // guard: the switch is a per-device decision, not a statement about collection.
  const alertsOff = await db
    .select({ drmsId: deviceAlerts.drmsEquipmentId })
    .from(deviceAlerts)
    .innerJoin(eff, eq(eff.drmsId, deviceAlerts.drmsEquipmentId))
    .where(and(eq(deviceAlerts.type, OFFLINE_TYPE), isNull(deviceAlerts.clearedAt), eq(eff.alertsEnabled, false)));

  if (alertsOff.length > 0) {
    await db
      .update(deviceAlerts)
      .set({
        clearedAt: now,
        details: sql`${deviceAlerts.details} || ${JSON.stringify({ clearedReason: ALERTS_OFF_REASON })}::jsonb`,
      })
      .where(
        and(
          eq(deviceAlerts.type, OFFLINE_TYPE),
          isNull(deviceAlerts.clearedAt),
          inArray(
            deviceAlerts.drmsEquipmentId,
            alertsOff.map((a) => a.drmsId),
          ),
        ),
      );
  }

  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceAlerts)
    .where(and(eq(deviceAlerts.type, OFFLINE_TYPE), isNull(deviceAlerts.clearedAt)));

  return { opened: toOpen.length, cleared: toClear.length + alertsOff.length, open: n, skippedDueToOutage };
}
