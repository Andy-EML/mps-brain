import { AuthError, RateLimitError } from '@mps/core';
import { deviceAlarms, syncRuns } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsFlatAlarm } from '@mps/drms';
import { QUEUES } from '@mps/queue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms } from '../test-helpers';
import { mapDrmsAlarm, runDrmsAlarms, splitWindow } from './drms-alarms';

function alarm(id: string, equipmentId: string, extra: Partial<DrmsFlatAlarm> = {}): DrmsFlatAlarm {
  return {
    AlarmId: id,
    EquipmentId: equipmentId,
    FcCode: 'TN-00',
    ScCode: null,
    Description: 'Toner near empty',
    Status: 'EquipmentDiscovered',
    ReceivedTime: '2026-09-17 02:00:00',
    TotalCount: null,
    TotalColorCount: null,
    ...extra,
  };
}

function fakeDrms(byWindow: (w: { dateFrom: Date; dateTo: Date }) => DrmsFlatAlarm[] | Error) {
  const calls: { dateFrom: Date; dateTo: Date }[] = [];
  return {
    calls,
    client: {
      listAlarms: async (w: { dateFrom: Date; dateTo: Date }) => {
        calls.push(w);
        const result = byWindow(w);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

describe('splitWindow', () => {
  it('splits a range into <=24h chunks, oldest first, capped at maxChunks', () => {
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-11T00:00:00Z'); // 10 days
    const windows = splitWindow(from, to);
    expect(windows).toHaveLength(7);
    expect(windows[0]).toEqual({ from, to: new Date('2026-09-02T00:00:00Z') });
    expect(windows[6]).toEqual({ from: new Date('2026-09-07T00:00:00Z'), to: new Date('2026-09-08T00:00:00Z') });
  });

  it('returns a single short window when the range is under a day', () => {
    const from = new Date('2026-09-17T01:30:00Z');
    const to = new Date('2026-09-17T02:00:00Z');
    expect(splitWindow(from, to)).toEqual([{ from, to }]);
  });

  it('returns nothing for an empty or inverted range', () => {
    const at = new Date('2026-09-17T02:00:00Z');
    expect(splitWindow(at, at)).toEqual([]);
  });
});

describe('mapDrmsAlarm', () => {
  it('maps fields, classifies the category and parses numeric counts', () => {
    const fetchedAt = new Date('2026-09-17T03:00:00Z');
    const row = mapDrmsAlarm(alarm('a1', 'eq-1', { FcCode: 'TO-00', TotalCount: '1234', TotalColorCount: 56 }), fetchedAt);
    expect(row).toMatchObject({
      alarmId: 'a1',
      drmsEquipmentId: 'eq-1',
      fcCode: 'TO-00',
      category: 'waste',
      totalCount: 1234,
      totalColorCount: 56,
      fetchedAt,
    });
    expect(row.receivedTime?.toISOString()).toBe('2026-09-17T02:00:00.000Z');
  });
});

describe('runDrmsAlarms', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await seedDrms(t.db, [{ drmsId: 'eq-1' }, { drmsId: 'eq-2' }]);
  });
  afterEach(() => t.close());

  it('uses the last 24h on the first run when there is no prior successful run', async () => {
    const now = new Date('2026-09-17T02:00:00Z');
    const drms = fakeDrms(() => []);
    await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(drms.calls).toHaveLength(1);
    expect(drms.calls[0]).toEqual({ dateFrom: new Date('2026-09-16T02:00:00Z'), dateTo: now });
  });

  it('windows from the last successful run minus 30 min overlap', async () => {
    await t.db.insert(syncRuns).values({
      job: QUEUES.drmsAlarms,
      status: 'success',
      startedAt: new Date('2026-09-17T01:00:00Z'),
      finishedAt: new Date('2026-09-17T01:01:00Z'),
      stats: {},
    });
    const now = new Date('2026-09-17T02:00:00Z');
    const drms = fakeDrms(() => []);
    await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(drms.calls).toEqual([{ dateFrom: new Date('2026-09-17T00:30:00Z'), dateTo: now }]);
  });

  it('splits a multi-day catch-up gap into per-day calls, oldest first, capped at 7 windows', async () => {
    await t.db.insert(syncRuns).values({
      job: QUEUES.drmsAlarms,
      status: 'success',
      startedAt: new Date('2026-09-01T00:00:00Z'),
      finishedAt: new Date('2026-09-01T00:01:00Z'),
      stats: {},
    });
    const now = new Date('2026-09-20T00:00:00Z');
    const drms = fakeDrms(() => []);
    await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(drms.calls).toHaveLength(7);
    expect(drms.calls[0]?.dateFrom.toISOString()).toBe('2026-08-31T23:30:00.000Z');
  });

  it('inserts alarms, is idempotent on rerun (dedupe by alarmId), and breaks down by category', async () => {
    const now = new Date('2026-09-17T02:00:00Z');
    const drms = fakeDrms(() => [
      alarm('a1', 'eq-1', { FcCode: 'TN-00' }),
      alarm('a2', 'eq-1', { FcCode: 'TO-00' }),
      alarm('a3', 'eq-2', { FcCode: 'TP-01' }),
    ]);
    const first = await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(first).toMatchObject({
      status: 'success',
      stats: { fetched: 3, inserted: 3, skippedUnknownDevice: 0, windows: 1, catToner: 1, catWaste: 1, catParts: 1 },
    });

    const second = await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(second.stats).toMatchObject({ fetched: 3, inserted: 0 });

    const rows = await t.db.select().from(deviceAlarms);
    expect(rows).toHaveLength(3);
  });

  it('skips alarms for equipment not in drms_equipment and counts them', async () => {
    const now = new Date('2026-09-17T02:00:00Z');
    const drms = fakeDrms(() => [alarm('a1', 'eq-1'), alarm('a2', 'unknown-eq')]);
    const result = await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(result.stats).toMatchObject({ fetched: 2, inserted: 1, skippedUnknownDevice: 1 });
    const rows = await t.db.select().from(deviceAlarms);
    expect(rows).toHaveLength(1);
  });

  it('stops and returns partial on RateLimitError, without trying further windows', async () => {
    await t.db.insert(syncRuns).values({
      job: QUEUES.drmsAlarms,
      status: 'success',
      startedAt: new Date('2026-09-01T00:00:00Z'),
      finishedAt: new Date('2026-09-01T00:01:00Z'),
      stats: {},
    });
    const now = new Date('2026-09-05T00:00:00Z');
    let calls = 0;
    const drms = fakeDrms(() => {
      calls++;
      if (calls === 2) return new RateLimitError('nope', new Date());
      return [alarm(`a${calls}`, 'eq-1')];
    });
    const result = await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(result.status).toBe('partial');
    expect(drms.calls).toHaveLength(2);
    const rows = await t.db.select().from(deviceAlarms);
    expect(rows).toHaveLength(1);
  });

  it('stops and returns partial on AuthError', async () => {
    const now = new Date('2026-09-17T02:00:00Z');
    const drms = fakeDrms(() => new AuthError('nope', 401));
    const result = await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    expect(result.status).toBe('partial');
  });

  it('only counts the sync-runs job named drms-alarms for windowing (not other jobs)', async () => {
    await t.db.insert(syncRuns).values({
      job: 'drms-pull',
      status: 'success',
      startedAt: new Date('2020-01-01T00:00:00Z'),
      finishedAt: new Date('2020-01-01T00:01:00Z'),
      stats: {},
    });
    const now = new Date('2026-09-17T02:00:00Z');
    const drms = fakeDrms(() => []);
    await runDrmsAlarms({ db: t.db, drms: drms.client, now: () => now });
    // Falls back to the "no prior run" 24h default, not to the unrelated drms-pull run from 2020.
    expect(drms.calls[0]).toEqual({ dateFrom: new Date('2026-09-16T02:00:00Z'), dateTo: now });
  });
});
