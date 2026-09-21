import { deviceAlerts, linkIssues, type Db } from '@mps/db';
import { countAwaitingReview, getReconnectCounts } from '@mps/db/queries';
import { count, eq, isNull } from 'drizzle-orm';

export interface NavCounts {
  openAlerts: number;
  openIssues: number;
  /** Devices with a pending toner proposal — the *Toner orders* badge. */
  awaitingReview: number;
  /** Devices that went quiet on CSRC in the last 14–30 days — the *Needs reconnecting* badge. */
  newlySilent: number;
}

/**
 * The badge counts in the sidebar. Kept deliberately cheap — this runs on every request that
 * renders the shell, so it must not pull the counter pivot that `getFleetSummary` needs.
 */
export async function getNavCounts(db: Db): Promise<NavCounts> {
  const [alerts, issues, awaitingReview, reconnect] = await Promise.all([
    db.select({ n: count() }).from(deviceAlerts).where(isNull(deviceAlerts.clearedAt)),
    db.select({ n: count() }).from(linkIssues).where(eq(linkIssues.status, 'open')),
    countAwaitingReview(db),
    // One grouped query over linked devices; no counter pivot.
    getReconnectCounts(db),
  ]);
  return {
    openAlerts: Number(alerts[0]?.n ?? 0),
    openIssues: Number(issues[0]?.n ?? 0),
    awaitingReview,
    newlySilent: reconnect.newlySilent,
  };
}
