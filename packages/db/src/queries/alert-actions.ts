import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceAlerts } from '../schema';

/**
 * The one write action behind `/alerts`. It lives here rather than in the web app so it can be
 * tested against a real Postgres (PGlite) without React.
 *
 * `userId` is always supplied by the caller; the web layer must read it from the session, never
 * from the request body.
 */

export interface AcknowledgeAlertArgs {
  alertId: number;
  /** The signed-in operator, from the session. Recorded as `acknowledged_by`. */
  userId: number;
  now?: Date;
}

/**
 * Marks an alert as seen by a person.
 *
 * Acknowledging deliberately does **not** clear the alert: a device is only back when it reports
 * counters again, which is the worker's call (`evaluateOfflineAlerts` sets `cleared_at`). All this
 * records is that somebody has taken the alert on, so it drops out of the Open tab.
 *
 * The `acknowledged_at is null` guard makes a second acknowledgement a no-op rather than a
 * silent overwrite: whoever picked the alert up first keeps it, and two operators clicking the
 * same button cannot fight over the row. A missing alert id is a no-op for the same reason — the
 * worker may have cleared and the operator may be looking at a stale page.
 */
export async function acknowledgeAlert(db: Db, args: AcknowledgeAlertArgs): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .update(deviceAlerts)
    .set({ acknowledgedBy: args.userId, acknowledgedAt: now })
    .where(and(eq(deviceAlerts.id, args.alertId), isNull(deviceAlerts.acknowledgedAt)));
}
