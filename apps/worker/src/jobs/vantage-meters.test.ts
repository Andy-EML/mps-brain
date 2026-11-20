import { RateLimitError } from '@mps/core';
import { syncRuns, vantageMeterReadings } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { QUEUES } from '@mps/queue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantageMeters } from '../test-helpers';
import { mapMeterReading, meterTypeMap, meterWindowStart, needsFullRun, runVantageMeters } from './vantage-meters';

const NOW = new Date('2026-11-17T02:45:00Z');

const types = [
  { Id: 1, Name: 'Black', Class: { Id: 1, Name: 'Mono' } },
  { Id: 2, Name: 'Colour', Class: { Id: 2, Name: 'Colour' } },
];
const reading = (Id: number, extra: object = {}) => ({
  Id,
  EquipmentId: 184,
  MeterTypeId: 1,
  ReadingDateTime: '2026-11-10T10:00:00Z',
  Reading: 28843,
  ReadingTypeId: 6,
  ModifiedDate: '2026-11-10T10:00:01Z',
  ...extra,
});

describe('mapMeterReading', () => {
  it('maps a reading with its meter type name and class', () => {
    const row = mapMeterReading(reading(5), meterTypeMap(types), NOW);
    expect(row).toMatchObject({ vantageId: 5, vantageEquipmentId: 184, meterTypeId: 1, meterTypeName: 'Black', meterClass: 'Mono', reading: 28843, readingTypeId: 6 });
    expect(row?.readingAt.toISOString()).toBe('2026-11-10T10:00:00.000Z');
  });
  it('returns null for a record without a value or date', () => {
    expect(mapMeterReading(reading(5, { Reading: null }), meterTypeMap(types), NOW)).toBeNull();
    expect(mapMeterReading(reading(5, { ReadingDateTime: null, ReadingDate: null }), meterTypeMap(types), NOW)).toBeNull();
  });
});

describe('meterWindowStart', () => {
  it('is 24 months back', () => {
    expect(meterWindowStart(NOW).toISOString()).toBe('2024-11-17T02:45:00.000Z');
    expect(meterWindowStart(new Date('2026-11-20T00:00:00Z')).toISOString()).toBe('2024-11-20T00:00:00.000Z');
  });
});

describe('needsFullRun', () => {
  const last = new Date('2026-11-19T00:00:00Z');
  it('is full without a previous success', () => expect(needsFullRun(null, null)).toBe(true));
  it('is full when the previous run recorded no window', () => expect(needsFullRun(last, null)).toBe(true));
  it('is full when the previous run covered a smaller window', () => expect(needsFullRun(last, 12)).toBe(true));
  it('is incremental when the previous run covered the current window', () => expect(needsFullRun(last, 24)).toBe(false));
});

describe('runVantageMeters', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('backfills the 24-month window on the first run', async () => {
    const v = fakeVantageMeters([reading(1), reading(2, { MeterTypeId: 2, Reading: 7499 })], types);
    const result = await runVantageMeters({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result).toMatchObject({ status: 'success', stats: { readings: 2, full: 1 } });
    expect(v.calls).toEqual([
      { readingFrom: new Date('2024-11-17T02:45:00Z'), readingTo: new Date('2026-11-18T02:45:00Z'), since: undefined },
    ]);
    expect(await t.db.select().from(vantageMeterReadings)).toHaveLength(2);
  });

  it('is incremental after a success, upserts, and prunes readings older than 24 months', async () => {
    await t.db.insert(syncRuns).values({ job: QUEUES.vantageMeters, status: 'success', startedAt: new Date('2026-11-16T02:45:00Z'), stats: { windowMonths: 24 } });
    await t.db.insert(vantageMeterReadings).values({
      vantageId: 99, vantageEquipmentId: 184, meterTypeId: 1, readingAt: new Date('2024-10-01T00:00:00Z'), reading: 1, raw: {},
    });
    const v = fakeVantageMeters([reading(1, { Reading: 100 })], types);
    const result = await runVantageMeters({ db: t.db, vantage: v.client, now: () => NOW });
    const again = fakeVantageMeters([reading(1, { Reading: 150 })], types);
    await runVantageMeters({ db: t.db, vantage: again.client, now: () => NOW });
    expect(result.stats.windowMonths).toBe(24);

    expect(v.calls[0]?.since).toEqual(new Date('2026-11-16T00:45:00Z'));
    expect(result.stats.full).toBe(0);
    const rows = await t.db.select().from(vantageMeterReadings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vantageId: 1, reading: 150 });
  });

  it('backfills when the previous success predates the 24-month window (no windowMonths in its stats)', async () => {
    await t.db.insert(syncRuns).values({ job: QUEUES.vantageMeters, status: 'success', startedAt: new Date('2026-11-16T02:45:00Z'), stats: { readings: 5, full: 0 } });
    const v = fakeVantageMeters([reading(1)], types);
    const result = await runVantageMeters({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result.stats).toMatchObject({ full: 1, windowMonths: 24 });
    expect(v.calls[0]?.since).toBeUndefined();
  });

  it('stays incremental after a 24-month run even when every stored reading is recent', async () => {
    await t.db.insert(syncRuns).values({ job: QUEUES.vantageMeters, status: 'success', startedAt: new Date('2026-11-16T02:45:00Z'), stats: { windowMonths: 24 } });
    await t.db.insert(vantageMeterReadings).values({
      vantageId: 98, vantageEquipmentId: 184, meterTypeId: 1, readingAt: new Date('2026-11-01T00:00:00Z'), reading: 1, raw: {},
    });
    const v = fakeVantageMeters([reading(1)], types);
    const result = await runVantageMeters({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result.stats.full).toBe(0);
    expect(v.calls[0]?.since).toEqual(new Date('2026-11-16T00:45:00Z'));
  });

  it('stops with a partial result on a rate limit', async () => {
    const v = fakeVantageMeters(new RateLimitError('slow down', new Date('2026-11-17T03:00:00Z')), types);
    const result = await runVantageMeters({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result.status).toBe('partial');
  });
});
