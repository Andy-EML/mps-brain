import { deviceAlerts, linkIssues, type Db } from '@mps/db';
import {
  countAwaitingApproval,
  countAwaitingReview,
  getReconnectCounts,
  notHiddenDevice,
  openIssuesCondition,
} from '@mps/db/queries';
import { and, count, isNull } from 'drizzle-orm';

export interface NavCounts {
  openAlerts: number;
  openIssues: number;
  /** Devices with a pending toner proposal — the *Toner orders* badge. */
  awaitingReview: number;
  /** Devices that went quiet on CSRC in the last 14–30 days — the *Needs reconnecting* badge. */
  newlySilent: number;
  /** Machines awaiting approval for DRMS registration — the *DRMS registrations* badge. */
  awaitingRegistration: number;
}

/**
 * The badge counts in the sidebar. Kept deliberately cheap — this runs on every request that
 * renders the shell, so it must not pull the counter pivot that `getFleetSummary` needs.
 */
export async function getNavCounts(db: Db): Promise<NavCounts> {
  const [alerts, issues, awaitingReview, reconnect, awaitingRegistration] = await Promise.all([
    // Hiding a device clears its open alerts, so the hidden test here only covers an alert opened
    // in the moment between a hide and the next alerts run.
    db
      .select({ n: count() })
      .from(deviceAlerts)
      .where(and(isNull(deviceAlerts.clearedAt), notHiddenDevice(deviceAlerts.drmsEquipmentId))),
    // Issues about hidden devices are left out, as on /issues itself.
    db.select({ n: count() }).from(linkIssues).where(openIssuesCondition()),
    countAwaitingReview(db),
    // One grouped query over linked devices; no counter pivot.
    getReconnectCounts(db),
    // One count on an indexed status column.
    countAwaitingApproval(db),
  ]);
  return {
    openAlerts: Number(alerts[0]?.n ?? 0),
    openIssues: Number(issues[0]?.n ?? 0),
    awaitingReview,
    newlySilent: reconnect.newlySilent,
    awaitingRegistration,
  };
}
