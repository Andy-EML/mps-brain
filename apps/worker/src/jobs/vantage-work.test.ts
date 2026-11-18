import { ParseError, RateLimitError } from '@mps/core';
import { syncRuns, vantageWorkVisits } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { QUEUES } from '@mps/queue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantageWork } from '../test-helpers';
import { VISIT_WINDOW_MONTHS, mapWorkUnit, runVantageWork, visitWindowStart } from './vantage-work';

const NOW = new Date('2026-11-17T03:05:00Z');
const unit = (Id: number, extra: object = {}, work: object = {}) => ({
  Id,
  WorkId: 700,
  CategoryId: 3,
  LoggedDate: '2026-11-01T08:00:00Z',
  WorkStartDate: '2026-11-02T09:00:00Z',
  WorkEndDate: '2026-11-02T10:30:00Z',
  WorkHours: 1.5,
  ScheduledStartDate: '2026-11-02T09:00:00Z',
  MaintenanceWasPerformed: true,
  ActionDetails: 'Replaced drum',
  ModifiedDate: '2026-11-02T10:31:00Z',
  Work: { Id: 700, Reference: 'W-700', EquipmentId: 184, CustomerId: 55, CompletedDate: '2026-11-02T11:00:00Z', DeletedDate: null, ...work },
  Category: { Id: 3, Name: 'Service call', Type: { Id: 1, Name: 'Field' } },
  ...extra,
});

describe('mapWorkUnit', () => {
  it('reads hours, dates, category type and skips deleted work', () => {
    const row = mapWorkUnit(unit(5), NOW);
    expect(row).toMatchObject({
      workUnitId: 5, workId: 700, workReference: 'W-700', vantageEquipmentId: 184, customerId: 55,
      categoryId: 3, categoryName: 'Service call', categoryType: 'Field', workHours: 1.5,
      maintenancePerformed: true, actionDetails: 'Replaced drum',
    });
    expect(row?.workStart?.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(row?.completedAt?.toISOString()).toBe('2026-11-02T11:00:00.000Z');
    expect(mapWorkUnit(unit(6, {}, { DeletedDate: '2026-11-03T00:00:00Z' }), NOW)).toBeNull();
    expect(mapWorkUnit(unit(7, {}, { EquipmentId: null }), NOW)).toBeNull();
    expect(mapWorkUnit({ WorkId: 1, Work: { EquipmentId: 1 } }, NOW)).toBeNull();
  });
});

describe('visit window', () => {
  it('is 36 months back from now', () => {
    expect(VISIT_WINDOW_MONTHS).toBe(36);
    expect(visitWindowStart(NOW).toISOString()).toBe('2023-11-17T03:05:00.000Z');
  });
});

describe('runVantageWork', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('fetches the full 36-month window every run and replaces the previous rows', async () => {
    const v = fakeVantageWork([unit(1), unit(2)]);
    const first = await runVantageWork({ db: t.db, vantage: v.client, now: () => NOW });
    expect(first).toMatchObject({ status: 'success', stats: { visits: 2 } });
    expect(v.calls).toEqual([{ from: new Date('2023-11-17T03:05:00Z') }]);

    await t.db.insert(syncRuns).values({ job: QUEUES.vantageWork, status: 'success', startedAt: new Date('2026-11-16T03:05:00Z') });
    const again = fakeVantageWork([unit(2, { WorkHours: 2 }), unit(3)]);
    await runVantageWork({ db: t.db, vantage: again.client, now: () => NOW });
    expect(again.calls).toEqual([{ from: new Date('2023-11-17T03:05:00Z') }]);
    const rows = (await t.db.select().from(vantageWorkVisits)).sort((x, y) => x.workUnitId - y.workUnitId);
    expect(rows.map((r) => r.workUnitId)).toEqual([2, 3]);
    expect(rows[0]?.workHours).toBe(2);
  });

  it('keeps the previous rows when Vantage returns no records', async () => {
    await t.db.insert(vantageWorkVisits).values({ workUnitId: 5, workId: 700, workStart: new Date('2026-11-02T09:00:00Z'), raw: {} });
    const v = fakeVantageWork([]);
    await expect(runVantageWork({ db: t.db, vantage: v.client, now: () => NOW })).rejects.toBeInstanceOf(ParseError);
    expect((await t.db.select().from(vantageWorkVisits)).map((r) => r.workUnitId)).toEqual([5]);
  });

  it('does not insert units whose work is deleted, and drops stored ones', async () => {
    await t.db.insert(vantageWorkVisits).values({ workUnitId: 5, workId: 700, workStart: new Date('2026-11-02T09:00:00Z'), raw: {} });
    const v = fakeVantageWork([unit(5, {}, { DeletedDate: '2026-11-10T00:00:00Z' }), unit(6)]);
    const result = await runVantageWork({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result.stats).toMatchObject({ visits: 1, skipped: 1 });
    expect((await t.db.select().from(vantageWorkVisits)).map((r) => r.workUnitId)).toEqual([6]);
  });

  it('stops with a partial result on a rate limit', async () => {
    const v = fakeVantageWork(new RateLimitError('slow down', new Date('2026-11-17T04:00:00Z')));
    const result = await runVantageWork({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result.status).toBe('partial');
  });
});
