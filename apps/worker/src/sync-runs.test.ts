import { syncRuns } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failStaleRuns, lastSuccessfulStart, withSyncRun } from './sync-runs';

describe('sync runs', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('records a successful run with stats', async () => {
    const result = await withSyncRun(t.db, 'job-a', async () => ({ status: 'partial', stats: { n: 3 }, errorSample: 'x' }));
    expect(result.status).toBe('partial');
    const [row] = await t.db.select().from(syncRuns);
    expect(row).toMatchObject({ job: 'job-a', status: 'partial', stats: { n: 3 }, errorSample: 'x' });
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('records a failed run and rethrows', async () => {
    await expect(
      withSyncRun(t.db, 'job-a', async () => {
        throw new Error('kaboom');
      }),
    ).rejects.toThrow('kaboom');
    const [row] = await t.db.select().from(syncRuns);
    expect(row).toMatchObject({ status: 'failed', errorSample: 'Error: kaboom' });
  });

  it('finds the latest successful start for a job', async () => {
    await t.db.insert(syncRuns).values([
      { job: 'job-a', status: 'success', startedAt: new Date('2026-09-15T02:00:00Z') },
      { job: 'job-a', status: 'success', startedAt: new Date('2026-09-16T02:00:00Z') },
      { job: 'job-a', status: 'failed', startedAt: new Date('2026-09-17T02:00:00Z') },
      { job: 'job-b', status: 'success', startedAt: new Date('2026-09-18T02:00:00Z') },
    ]);
    expect((await lastSuccessfulStart(t.db, 'job-a'))?.toISOString()).toBe('2026-09-16T02:00:00.000Z');
    expect(await lastSuccessfulStart(t.db, 'job-c')).toBeNull();
  });

  it('marks stale running runs as failed', async () => {
    await t.db.insert(syncRuns).values([{ job: 'a', status: 'running' }, { job: 'b', status: 'success' }]);
    expect(await failStaleRuns(t.db)).toBe(1);
    const rows = await t.db.select().from(syncRuns);
    expect(rows.find((r) => r.job === 'a')).toMatchObject({ status: 'failed', errorSample: 'worker restarted during run' });
  });
});
