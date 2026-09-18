import { asc, desc, sql } from 'drizzle-orm';
import { getAppState } from '../app-state';
import type { Db } from '../client';
import { counterNames, syncRuns, users } from '../schema';

export async function listUsers(
  db: Db,
): Promise<{ id: number; username: string; role: string; active: boolean; createdAt: Date }[]> {
  return db
    .select({ id: users.id, username: users.username, role: users.role, active: users.active, createdAt: users.createdAt })
    .from(users)
    .orderBy(asc(users.username));
}

export async function listCounterNames(
  db: Db,
): Promise<{ name: string; category: string | null; sampleValue: number | null; firstSeen: Date }[]> {
  return db
    .select({
      name: counterNames.name,
      category: counterNames.category,
      sampleValue: counterNames.sampleValue,
      firstSeen: counterNames.firstSeen,
    })
    .from(counterNames)
    .orderBy(asc(counterNames.name));
}

export async function listSyncRuns(
  db: Db,
  limit = 50,
): Promise<{ id: number; job: string; startedAt: Date; finishedAt: Date | null; status: string; stats: unknown; errorSample: string | null }[]> {
  return db
    .select({
      id: syncRuns.id,
      job: syncRuns.job,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      status: syncRuns.status,
      stats: syncRuns.stats,
      errorSample: syncRuns.errorSample,
    })
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit);
}

/** Re-export of `getAppState` under the name later tasks import from `@mps/db/queries`. */
export function getAppStateValue<T>(db: Db, key: string): Promise<T | null> {
  return getAppState<T>(db, key);
}

/**
 * The cron expression the worker actually registered for each queue, keyed by queue name.
 *
 * Read straight from pg-boss's own schedule table rather than from this app's environment: the web
 * container does not set `SNAPSHOT_CRON` and friends, only the worker does, so the environment here
 * would answer for a schedule it knows nothing about. pg-boss is the one place both processes agree
 * on. A missing table (a database that has never had a worker against it) is not an error worth
 * failing an admin page over — the caller falls back to the static card text.
 */
export async function listQueueSchedules(db: Db): Promise<Map<string, string>> {
  try {
    const rows = await db.execute<{ name: string; cron: string }>(sql`select name, cron from pgboss.schedule`);
    // drizzle's execute returns the driver's result shape, which differs between pg and PGlite.
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: { name: string; cron: string }[] }).rows) ?? [];
    return new Map(list.map((r) => [r.name, r.cron]));
  } catch {
    return new Map();
  }
}
