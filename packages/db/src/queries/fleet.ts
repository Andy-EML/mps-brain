import { isCollectionOutage } from '@mps/core';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceAlarms, deviceLinks, drmsEquipment, linkIssues, syncRuns, vantageEquipment } from '../schema';
import { openIssuesCondition } from './issues';
import { effectiveSettingsSubquery } from './settings';
import { belowThreshold, counterPivotSubquery, notHiddenDevice, offlineCutoff } from './shared';

export interface FleetSummary {
  devices: number;
  monitored: number;
  linked: number;
  /** Below its effective threshold on some cartridge, with auto-replenish on — the cascade rule. */
  needsToner: number;
  /**
   * The same "below threshold" test, but with auto-replenish switched off — devices the settings
   * cascade says need toner but that the "Manual replenishment" devices filter (not the engine)
   * covers, because nothing here proposes an order for them.
   */
  manualLow: number;
  criticalToner: number;
  lowToner: number;
  /**
   * Devices with **no meter reading** inside the threshold window — DRMS collected no counter set
   * for them. Not a reachability signal: DRMS collects roughly once a day for the whole fleet, so
   * a stalled collection makes every reporting device look "offline" at once. Check
   * `getCollectionStatus().outage` before presenting this as a count of devices in trouble. The
   * field name stays as it is so the `?filter=offline` links and the `offline` alert type keep
   * working; the user-facing label is "No meter reading".
   */
  offline: number;
  openIssues: number;
  lastSyncAt: Date | null;
}

/**
 * Every number on Fleet overview leaves out hidden devices (`notHiddenDevice`): an operator hid
 * them because they are no longer ours to look after, so they must not inflate a headline either.
 */
const visible = () => notHiddenDevice(drmsEquipment.drmsId);

/** A device DRMS still expects to hear from: not soft-deleted, not marked missing and not hidden. */
function monitoredCondition() {
  return and(isNull(drmsEquipment.missingSince), sql`upper(${drmsEquipment.status}) <> 'DELETED'`, visible());
}

/**
 * @param opts.offlineHours Threshold for the `offline` count (default 24; see CLAUDE.md's
 * OFFLINE_ALERT_HOURS). Optional so `getFleetSummary(db)` still matches the documented signature.
 */
export async function getFleetSummary(db: Db, opts: { offlineHours?: number } = {}): Promise<FleetSummary> {
  const cutoff = offlineCutoff(opts.offlineHours);
  const pivot = counterPivotSubquery(db);
  const eff = effectiveSettingsSubquery(db);

  const [[devicesRow], [monitoredRow], [linkedRow], [tonerRow], [offlineRow], [issuesRow], [syncRow]] = await Promise.all([
    db.select({ n: count() }).from(drmsEquipment).where(visible()),
    db.select({ n: count() }).from(drmsEquipment).where(monitoredCondition()),
    db
      .select({ n: count() })
      .from(deviceLinks)
      .where(and(isNull(deviceLinks.unlinkedAt), notHiddenDevice(deviceLinks.drmsEquipmentId))),
    db
      .select({
        needsToner: sql<number>`count(*) filter (where ${and(belowThreshold(pivot, eff), eq(eff.autoReplenish, true))})`,
        manualLow: sql<number>`count(*) filter (where ${and(belowThreshold(pivot, eff), eq(eff.autoReplenish, false))})`,
        // Display-scale tiers (5%/20%), independent of the settings cascade — the toner health
        // card's own thresholds, not the ordering rule for "needs toner".
        criticalToner: sql<number>`count(*) filter (where ${pivot.black} < 5 or ${pivot.cyan} < 5 or ${pivot.magenta} < 5 or ${pivot.yellow} < 5)`,
      })
      // Left join: every DRMS device has an effective-settings row, but a missing one should read
      // as "not needing toner" rather than dropping the device from the count.
      .from(pivot)
      .leftJoin(eff, eq(eff.drmsId, pivot.drmsId))
      .where(notHiddenDevice(pivot.drmsId)),
    db
      .select({ n: count() })
      .from(drmsEquipment)
      .where(
        and(isNotNull(drmsEquipment.lastCounterReceivedTime), lt(drmsEquipment.lastCounterReceivedTime, cutoff), visible()),
      ),
    db.select({ n: count() }).from(linkIssues).where(openIssuesCondition()),
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
    manualLow: Number(tonerRow?.manualLow ?? 0),
    criticalToner,
    // "Low" is the non-critical part of "needs toner" (5%-20%); needsToner already includes
    // critical. needsToner follows the settings cascade and only counts auto-replenish devices,
    // while criticalToner counts every device regardless — so criticalToner can exceed needsToner
    // and this must not go negative.
    lowToner: Math.max(0, needsToner - criticalToner),
    offline: offlineRow?.n ?? 0,
    openIssues: issuesRow?.n ?? 0,
    lastSyncAt: syncRow?.finishedAt ?? null,
  };
}

export interface CollectionStatus {
  /** The newest `LastCounterReceivedTime` anywhere in the reporting fleet. */
  newestReadingAt: Date | null;
  /** Monitored devices that have reported a counter at least once — DRMS should keep collecting from them. */
  devicesExpectingReadings: number;
  /** How many of those have no reading inside the threshold window. */
  devicesStale: number;
  /** The rest: devices DRMS has collected from inside the window. What the banner counts up. */
  devicesCollectedRecently: number;
  /**
   * True when a large enough share of the reporting fleet is stale that collection, not the
   * devices, is the likely cause — see `COLLECTION_OUTAGE_STALE_RATIO`.
   */
  outage: boolean;
}

/**
 * How far behind DRMS is on collecting meter counters.
 *
 * The device set is the one `evaluateOfflineAlerts` alerts on — monitored (not missing, not
 * `Deleted`) and having reported at least once — so the banner on screen and the worker's
 * decision to hold off opening alerts always agree about what an outage is.
 *
 * One grouped scan of `drms_equipment`; no join.
 *
 * @param opts.staleHours Staleness threshold, default 24 (`DEFAULT_OFFLINE_HOURS`).
 */
export async function getCollectionStatus(db: Db, opts: { staleHours?: number } = {}): Promise<CollectionStatus> {
  const cutoff = offlineCutoff(opts.staleHours);

  const [row] = await db
    .select({
      newestReadingAt: max(drmsEquipment.lastCounterReceivedTime),
      expecting: sql<number>`count(*)::int`,
      stale: sql<number>`count(*) filter (where ${drmsEquipment.lastCounterReceivedTime} < ${cutoff})::int`,
    })
    .from(drmsEquipment)
    .where(and(monitoredCondition(), isNotNull(drmsEquipment.lastCounterReceivedTime)));

  const devicesExpectingReadings = Number(row?.expecting ?? 0);
  const devicesStale = Number(row?.stale ?? 0);

  return {
    newestReadingAt: row?.newestReadingAt ?? null,
    devicesExpectingReadings,
    devicesStale,
    devicesCollectedRecently: devicesExpectingReadings - devicesStale,
    outage: isCollectionOutage({ devicesExpectingReadings, devicesStale }),
  };
}

export interface TonerHealth {
  healthy: number;
  low: number;
  critical: number;
  cartridges: number;
  devices: number;
}

/**
 * The "Fleet toner health" tally, computed per cartridge (not per device) from the latest snapshot
 * per device, in SQL — the same 5%/20% thresholds as `tonerState` in `apps/web/src/components/toner.ts`.
 * `devices` is how many distinct devices contributed at least one of those cartridges, for the
 * card's "across N devices" sub-line.
 */
export async function getTonerHealth(db: Db): Promise<TonerHealth> {
  const pivot = counterPivotSubquery(db);

  const [row] = await db
    .select({
      critical: sql<number>`
        count(*) filter (where ${pivot.black} < 5) +
        count(*) filter (where ${pivot.cyan} < 5) +
        count(*) filter (where ${pivot.magenta} < 5) +
        count(*) filter (where ${pivot.yellow} < 5)
      `,
      low: sql<number>`
        count(*) filter (where ${pivot.black} >= 5 and ${pivot.black} < 20) +
        count(*) filter (where ${pivot.cyan} >= 5 and ${pivot.cyan} < 20) +
        count(*) filter (where ${pivot.magenta} >= 5 and ${pivot.magenta} < 20) +
        count(*) filter (where ${pivot.yellow} >= 5 and ${pivot.yellow} < 20)
      `,
      healthy: sql<number>`
        count(*) filter (where ${pivot.black} >= 20) +
        count(*) filter (where ${pivot.cyan} >= 20) +
        count(*) filter (where ${pivot.magenta} >= 20) +
        count(*) filter (where ${pivot.yellow} >= 20)
      `,
      cartridges: sql<number>`
        count(*) filter (where ${pivot.black} is not null) +
        count(*) filter (where ${pivot.cyan} is not null) +
        count(*) filter (where ${pivot.magenta} is not null) +
        count(*) filter (where ${pivot.yellow} is not null)
      `,
      devices: sql<number>`
        count(*) filter (
          where ${pivot.black} is not null or ${pivot.cyan} is not null
             or ${pivot.magenta} is not null or ${pivot.yellow} is not null
        )
      `,
    })
    .from(pivot)
    .where(notHiddenDevice(pivot.drmsId));

  return {
    healthy: Number(row?.healthy ?? 0),
    low: Number(row?.low ?? 0),
    critical: Number(row?.critical ?? 0),
    cartridges: Number(row?.cartridges ?? 0),
    devices: Number(row?.devices ?? 0),
  };
}

/**
 * The number of distinct customers behind the fleet, for the overview subtitle. Matches every
 * device (not just monitored/linked ones), preferring the linked Vantage customer name and
 * falling back to the DRMS-reported name for a device with no link — the same
 * `vantageCustomerName ?? customerName` the old JS-side tally used over `listDevices`' rows, kept
 * as-is here (in SQL) so the number on screen doesn't move. `count(distinct …)` already ignores
 * nulls, so a device with neither name contributes nothing.
 */
export async function getCustomerCount(db: Db): Promise<number> {
  const [row] = await db
    .select({
      n: sql<number>`count(distinct coalesce(${vantageEquipment.customerName}, ${drmsEquipment.customerName}))`,
    })
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .where(visible());

  return Number(row?.n ?? 0);
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
    .where(
      and(
        inArray(deviceAlarms.category, CONSUMABLE_WARNING_CATEGORIES),
        gte(deviceAlarms.receivedTime, since),
        notHiddenDevice(deviceAlarms.drmsEquipmentId),
      ),
    )
    .orderBy(deviceAlarms.drmsEquipmentId, deviceAlarms.category, desc(deviceAlarms.receivedTime));

  return rows.map((r) => ({ ...r, category: r.category as ConsumableWarningCategory }));
}
