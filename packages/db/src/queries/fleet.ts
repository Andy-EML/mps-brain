import { and, count, eq, isNotNull, isNull, lt, max, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, linkIssues, syncRuns } from '../schema';
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
