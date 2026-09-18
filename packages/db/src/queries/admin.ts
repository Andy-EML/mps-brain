import { asc, desc } from 'drizzle-orm';
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
