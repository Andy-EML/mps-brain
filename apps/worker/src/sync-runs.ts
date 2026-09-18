import { errorMessage } from '@mps/core';
import { syncRuns, type Db } from '@mps/db';
import { and, desc, eq } from 'drizzle-orm';

export type RunStatus = 'success' | 'partial' | 'failed';

export interface JobResult {
  status: RunStatus;
  /**
   * Written verbatim to `sync_runs.stats` (jsonb) and rendered by `statLines` on the admin jobs
   * page. Mostly counts; a boolean is allowed for a flag that explains a count, such as
   * `alertsSkippedDueToOutage` — "0 opened" and "0 opened because collection stopped" are
   * different facts and 0/1 would not say which.
   */
  stats: Record<string, number | boolean>;
  errorSample?: string;
}

export async function withSyncRun(db: Db, job: string, fn: () => Promise<JobResult>): Promise<JobResult> {
  const [run] = await db.insert(syncRuns).values({ job, status: 'running' }).returning({ id: syncRuns.id });
  const runId = (run as { id: number }).id;
  try {
    const result = await fn();
    await db
      .update(syncRuns)
      .set({
        status: result.status,
        stats: result.stats,
        errorSample: result.errorSample ?? null,
        finishedAt: new Date(),
      })
      .where(eq(syncRuns.id, runId));
    return result;
  } catch (err) {
    await db
      .update(syncRuns)
      .set({ status: 'failed', errorSample: errorMessage(err), finishedAt: new Date() })
      .where(eq(syncRuns.id, runId));
    throw err;
  }
}

export async function lastSuccessfulStart(db: Db, job: string): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.job, job), eq(syncRuns.status, 'success')))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

export async function failStaleRuns(db: Db): Promise<number> {
  const rows = await db
    .update(syncRuns)
    .set({ status: 'failed', errorSample: 'worker restarted during run', finishedAt: new Date() })
    .where(eq(syncRuns.status, 'running'))
    .returning({ id: syncRuns.id });
  return rows.length;
}
