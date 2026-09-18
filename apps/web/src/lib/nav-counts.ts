import { deviceAlerts, linkIssues, type Db } from '@mps/db';
import { count, eq, isNull } from 'drizzle-orm';

export interface NavCounts {
  openAlerts: number;
  openIssues: number;
}

/**
 * The two badge counts in the sidebar. Kept deliberately cheap — this runs on every request that
 * renders the shell, so it must not pull the counter pivot that `getFleetSummary` needs.
 */
export async function getNavCounts(db: Db): Promise<NavCounts> {
  const [alerts, issues] = await Promise.all([
    db.select({ n: count() }).from(deviceAlerts).where(isNull(deviceAlerts.clearedAt)),
    db.select({ n: count() }).from(linkIssues).where(eq(linkIssues.status, 'open')),
  ]);
  return {
    openAlerts: Number(alerts[0]?.n ?? 0),
    openIssues: Number(issues[0]?.n ?? 0),
  };
}
