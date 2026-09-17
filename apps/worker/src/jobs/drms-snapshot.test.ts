import { RateLimitError } from '@mps/core';
import { counterNames, counterSnapshots, counterValues, drmsEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsLatestCounters } from '@mps/drms';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms } from '../test-helpers';
import { flattenCounters, runDrmsSnapshot, uniqueCounterNames } from './drms-snapshot';

const counters = (counterId: string, black = 58): DrmsLatestCounters => ({
  Id: 'x',
  CounterId: counterId,
  ReceivedTime: '2026-09-17 01:30:00',
  Counters: [
    { ItemNumber: 1, Name: 'BlackTonerLevel', Value: black },
    { ItemNumber: 2, Name: 'A3COPIERCOLOR', Value: '1234' },
  ],
  ModeSizeCounters: [
    { ColorMode: 'FullColor', Mode: 'CopyMode', Counters: [{ ItemNumber: '3', Name: 'A4 SEF Full', Value: 'n/a' }] },
  ],
});

describe('flattenCounters', () => {
  it('flattens plain and mode-size counters, coercing values', () => {
    expect(flattenCounters(counters('c1'))).toEqual([
      { itemNumber: '1', name: 'BlackTonerLevel', value: 58, colorMode: null, mode: null },
      { itemNumber: '2', name: 'A3COPIERCOLOR', value: 1234, colorMode: null, mode: null },
      { itemNumber: '3', name: 'A4 SEF Full', value: null, colorMode: 'FullColor', mode: 'CopyMode' },
    ]);
    expect(flattenCounters({ CounterId: 'c', Counters: null, ModeSizeCounters: null })).toEqual([]);
  });
});

describe('uniqueCounterNames', () => {
  it('keeps the first counter per name and sorts by name for a consistent lock order', () => {
    const c = (name: string, value: number) => ({ itemNumber: null, name, value, colorMode: null, mode: null });
    expect(uniqueCounterNames([c('b', 1), c('a', 2), c('b', 3), c('C', 4)])).toEqual([c('C', 4), c('a', 2), c('b', 1)]);
  });
});

describe('runDrmsSnapshot', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await seedDrms(t.db, [
      { drmsId: 'd1' },
      { drmsId: 'd2', status: 'registered' },
      { drmsId: 'd3', status: 'PreRegistered' },
      { drmsId: 'd4', missingSince: new Date() },
      { drmsId: 'd5', status: 'Discovered' },
    ]);
  });
  afterEach(() => t.close());

  const day = (iso: string) => () => new Date(iso);

  it('stores snapshots, values and counter names for registered and discovered present devices', async () => {
    const asked: string[] = [];
    const drms = { latestCounters: async (id: string) => (asked.push(id), counters(`${id}-c1`)) };
    const result = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });

    expect(asked).toEqual(['d1', 'd2', 'd5']);
    expect(result).toMatchObject({ status: 'success', stats: { devices: 3, inserted: 3, unchanged: 0, errors: 0 } });
    expect(await t.db.select().from(counterSnapshots)).toHaveLength(3);
    expect(await t.db.select().from(counterValues)).toHaveLength(9);
    const names = await t.db.select().from(counterNames);
    expect(names.map((n) => n.name).sort()).toEqual(['A3COPIERCOLOR', 'A4 SEF Full', 'BlackTonerLevel']);
    const [snap] = await t.db.select().from(counterSnapshots).where(eq(counterSnapshots.drmsEquipmentId, 'd1'));
    expect(snap?.receivedTime?.toISOString()).toBe('2026-09-17T01:30:00.000Z');
  });

  it('skips devices already fetched today and dedupes an unchanged CounterId next day', async () => {
    const drms = { latestCounters: async (id: string) => counters(`${id}-c1`) };
    await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });

    const sameDay = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T09:00:00Z'), concurrency: 1 });
    expect(sameDay.stats.devices).toBe(0);

    const nextDay = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-18T06:00:00Z'), concurrency: 1 });
    expect(nextDay.stats).toMatchObject({ devices: 3, inserted: 0, unchanged: 3 });
    expect(await t.db.select().from(counterSnapshots)).toHaveLength(3);
  });

  it('keeps a user-set counter category when the name is seen again', async () => {
    const drms = { latestCounters: async (id: string) => counters(`${id}-c1`) };
    await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });
    await t.db.update(counterNames).set({ category: 'supply' }).where(eq(counterNames.name, 'BlackTonerLevel'));
    const drms2 = { latestCounters: async (id: string) => counters(`${id}-c2`, 12) };
    await runDrmsSnapshot({ db: t.db, drms: drms2, now: day('2026-09-18T06:00:00Z'), concurrency: 1 });
    const [row] = await t.db.select().from(counterNames).where(eq(counterNames.name, 'BlackTonerLevel'));
    expect(row).toMatchObject({ category: 'supply', sampleValue: 12 });
  });

  it('stops on RateLimitError, reports partial, and leaves the rest for a resume', async () => {
    let calls = 0;
    const drms = {
      latestCounters: async (id: string) => {
        calls++;
        if (id === 'd1') throw new RateLimitError('429', new Date());
        return counters(`${id}-c1`);
      },
    };
    const result = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });
    expect(calls).toBe(1);
    expect(result.status).toBe('partial');
    expect(result.errorSample).toContain('stopped: RateLimitError');
    expect(result.stats.skippedAfterStop).toBe(2);
    const rows = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'd2'));
    expect(rows[0]?.lastSnapshotFetchAt).toBeNull();
  });

  it('counts per-device errors without stopping and retries them next run', async () => {
    const drms = {
      latestCounters: async (id: string) => {
        if (id === 'd1') throw new Error('bad payload');
        return counters(`${id}-c1`);
      },
    };
    const result = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });
    expect(result).toMatchObject({ status: 'partial', stats: { errors: 1, inserted: 2 } });
    expect(result.errorSample).toContain('d1: Error: bad payload');

    const retry = await runDrmsSnapshot({ db: t.db, drms: { latestCounters: async (id: string) => counters(`${id}-c1`) }, now: day('2026-09-17T07:00:00Z'), concurrency: 1 });
    expect(retry.stats).toMatchObject({ devices: 1, inserted: 1 });
  });

  it('counts a device with no counters as empty, stores nothing, and skips it on a same-day rerun', async () => {
    const drms = { latestCounters: async (id: string) => (id === 'd5' ? null : counters(`${id}-c1`)) };
    const result = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T06:00:00Z'), concurrency: 1 });
    expect(result).toMatchObject({ status: 'success', stats: { devices: 3, inserted: 2, empty: 1 } });
    expect(await t.db.select().from(counterSnapshots).where(eq(counterSnapshots.drmsEquipmentId, 'd5'))).toEqual([]);
    const [d5] = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'd5'));
    expect(d5?.lastSnapshotFetchAt?.toISOString()).toBe('2026-09-17T06:00:00.000Z');

    const sameDay = await runDrmsSnapshot({ db: t.db, drms, now: day('2026-09-17T09:00:00Z'), concurrency: 1 });
    expect(sameDay.stats.devices).toBe(0);
  });
});
