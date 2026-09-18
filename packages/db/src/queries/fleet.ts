import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceAlarms, deviceLinks, drmsEquipment, linkIssues, syncRuns } from '../schema';
import { counterPivotSubquery, offlineCutoff } from './shared';

export interface FleetSummary {
  devices: number;
  monitored: number;
  linked: number;
  needsToner: number;
  criticalToner: number;
  lowToner: number;
  offline: number;
  openIssues: number;
  lastSyncAt: Date | null;
}

/**
 * @param opts.offlineHours Threshold for the `offline` count (default 24; see CLAUDE.md's
 * OFFLINE_ALERT_HOURS). Optional so `getFleetSummary(db)` still matches the documented signature.
 */
export async function getFleetSummary(db: Db, opts: { offlineHours?: number } = {}): Promise<FleetSummary> {
  const cutoff = offlineCutoff(opts.offlineHours);
  const pivot = counterPivotSubquery(db);

  const [[devicesRow], [monitoredRow], [linkedRow], [tonerRow], [offlineRow], [issuesRow], [syncRow]] = await Promise.all([
    db.select({ n: count() }).from(drmsEquipment),
    db
      .select({ n: count() })
      .from(drmsEquipment)
      .where(and(isNull(drmsEquipment.missingSince), sql`upper(${drmsEquipment.status}) <> 'DELETED'`)),
    db.select({ n: count() }).from(deviceLinks).where(isNull(deviceLinks.unlinkedAt)),
    db
      .select({
        needsToner: sql<number>`count(*) filter (where ${pivot.black} < 20 or ${pivot.cyan} < 20 or ${pivot.magenta} < 20 or ${pivot.yellow} < 20)`,
        criticalToner: sql<number>`count(*) filter (where ${pivot.black} < 5 or ${pivot.cyan} < 5 or ${pivot.magenta} < 5 or ${pivot.yellow} < 5)`,
      })
      .from(pivot),
    db
      .select({ n: count() })
      .from(drmsEquipment)
      .where(and(isNotNull(drmsEquipment.lastCounterReceivedTime), lt(drmsEquipment.lastCounterReceivedTime, cutoff))),
    db.select({ n: count() }).from(linkIssues).where(eq(linkIssues.status, 'open')),
    db
      .select({ finishedAt: max(syncRuns.finishedAt) })
      .from(syncRuns)
      .where(eq(syncRuns.status, 'success')),
  ]);

  const needsToner = Number(tonerRow?.needsToner ?? 0);
  const criticalToner = Number(tonerRow?.criticalToner ?? 0);

  return {
    devices: devicesRow?.n ?? 0,
    monitored: monitoredRow?.n ?? 0,
    linked: linkedRow?.n ?? 0,
    needsToner,
    criticalToner,
    // "Low" is the non-critical part of "needs toner" (5%-20%); needsToner already includes critical.
    lowToner: needsToner - criticalToner,
    offline: offlineRow?.n ?? 0,
    openIssues: issuesRow?.n ?? 0,
    lastSyncAt: syncRow?.finishedAt ?? null,
  };
}

const CONSUMABLE_WARNING_CATEGORIES = ['waste', 'parts'] as const;
type ConsumableWarningCategory = (typeof CONSUMABLE_WARNING_CATEGORIES)[number];

export interface ConsumableWarning {
  drmsId: string;
  category: ConsumableWarningCategory;
  latestAt: Date;
  fcCode: string | null;
  description: string | null;
}

/**
 * The latest waste/parts (imaging unit, drum, filter) alarm per device within the last `days`
 * days. DRMS alarms have no real "cleared" state, so "open-ish" here just means recent — one row
 * per (device, category). The fleet page's "N devices with waste/parts warnings" count is the
 * number of distinct `drmsId`s across the result.
 */
export async function getConsumableWarnings(db: Db, opts: { days?: number } = {}): Promise<ConsumableWarning[]> {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86_400_000);

  const rows = await db
    .selectDistinctOn([deviceAlarms.drmsEquipmentId, deviceAlarms.category], {
      drmsId: deviceAlarms.drmsEquipmentId,
      category: deviceAlarms.category,
      latestAt: deviceAlarms.receivedTime,
      fcCode: deviceAlarms.fcCode,
      description: deviceAlarms.description,
    })
    .from(deviceAlarms)
    .where(and(inArray(deviceAlarms.category, CONSUMABLE_WARNING_CATEGORIES), gte(deviceAlarms.receivedTime, since)))
    .orderBy(deviceAlarms.drmsEquipmentId, deviceAlarms.category, desc(deviceAlarms.receivedTime));

  return rows.map((r) => ({ ...r, category: r.category as ConsumableWarningCategory }));
}
