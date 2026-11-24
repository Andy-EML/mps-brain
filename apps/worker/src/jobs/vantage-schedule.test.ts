import { AuthError, RateLimitError } from '@mps/core';
import { vantageScheduledUnits } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantageSchedule } from '../test-helpers';
import { mapScheduledUnit, runVantageSchedule, scheduleWindow } from './vantage-schedule';

const NOW = new Date('2026-11-23T08:00:00Z');
// Field names as seen on the live WorkUnit (checked 2026-11-23): the engineer is `WorkUnit.EngineerId`;
// `Work` has no engineer field.
const unit = (Id: number, extra: object = {}, work: object = {}) => ({
  Id,
  WorkId: 700,
  CategoryId: 3,
  EngineerId: 4,
  ScheduledStartDate: '2026-11-23T09:30:00Z',
  WorkStartDate: null,
  Work: { Id: 700, Reference: 'W-700', EquipmentId: 184, CustomerId: 55, CompletedDate: null, DeletedDate: null, ...work },
  Category: { Id: 3, Name: 'Service call', Type: { Id: 1, Name: 'Field' } },
  ...extra,
});

describe('mapScheduledUnit', () => {
  it('reads engineer, customer, equipment, category type, start and completion', () => {
    const row = mapScheduledUnit(unit(5, { WorkStartDate: '2026-11-23T09:40:00Z' }, { CompletedDate: '2026-11-23T11:00:00Z' }), NOW);
    expect(row).toMatchObject({
      workUnitId: 5, workId: 700, workReference: 'W-700', engineerId: 4, customerId: 55, vantageEquipmentId: 184,
      categoryId: 3, categoryName: 'Service call', categoryType: 'Field', syncedAt: NOW,
    });
    expect(row?.scheduledStart.toISOString()).toBe('2026-11-23T09:30:00.000Z');
    expect(row?.workStart?.toISOString()).toBe('2026-11-23T09:40:00.000Z');
    expect(row?.completedAt?.toISOString()).toBe('2026-11-23T11:00:00.000Z');
  });
  it('keeps a call with no machine and no engineer', () => {
    const row = mapScheduledUnit(unit(6, { EngineerId: null }, { EquipmentId: null }), NOW);
    expect(row).toMatchObject({ workUnitId: 6, vantageEquipmentId: null, engineerId: null });
    expect(row?.workStart).toBeNull();
    expect(row?.completedAt).toBeNull();
  });
  it('skips no id, no scheduled start and deleted Work', () => {
    expect(mapScheduledUnit({ ...unit(1), Id: undefined }, NOW)).toBeNull();
    expect(mapScheduledUnit(unit(2, { ScheduledStartDate: null }), NOW)).toBeNull();
    expect(mapScheduledUnit(unit(3, {}, { DeletedDate: '2026-11-22T00:00:00Z' }), NOW)).toBeNull();
  });
});

describe('scheduleWindow', () => {
  it('starts at London midnight today (BST: previous day 23:00Z)', () => {
    const w = scheduleWindow(new Date('2026-03-31T22:30:00Z'));
    expect(w.from.toISOString()).toBe('2026-03-30T23:00:00.000Z');
    // London today is 31 Mar, so today + tomorrow end at 00:00 BST on 2 Apr.
    expect(w.to.toISOString()).toBe('2026-04-01T23:00:00.000Z');
  });
  it('uses GMT in winter and copes with the clocks going forward inside the window', () => {
    expect(scheduleWindow(NOW)).toEqual({ from: new Date('2026-11-23T00:00:00Z'), to: new Date('2026-11-25T00:00:00Z') });
    // 28 Mar 2026: BST starts overnight, so 30 Mar 00:00 London is 29 Mar 23:00Z.
    expect(scheduleWindow(new Date('2026-03-28T12:00:00Z'))).toEqual({ from: new Date('2026-03-28T00:00:00Z'), to: new Date('2026-03-29T23:00:00Z') });
  });
  it('a call at 23:30Z on 31 Mar is on 1 Apr in London, so it is inside the window that starts on 31 Mar', () => {
    const w = scheduleWindow(new Date('2026-03-31T12:00:00Z'));
    const call = new Date('2026-03-31T23:30:00Z');
    expect(call >= w.from && call < w.to).toBe(true);
    // ...and a "now" of 00:10 BST on 1 Apr makes 1 Apr the first day.
    expect(scheduleWindow(new Date('2026-03-31T23:10:00Z')).from.toISOString()).toBe('2026-03-31T23:00:00.000Z');
  });
});

describe('runVantageSchedule', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('asks for the London window and replaces the rows', async () => {
    await t.db.insert(vantageScheduledUnits).values({ workUnitId: 99, workId: 1, scheduledStart: NOW, raw: {} });
    const v = fakeVantageSchedule([unit(1), unit(2, { EngineerId: 5 }), unit(3, {}, { DeletedDate: '2026-11-20T00:00:00Z' })]);
    const res = await runVantageSchedule({ db: t.db, vantage: v.client, now: () => NOW });
    expect(res).toMatchObject({ status: 'success', stats: { units: 2, skipped: 1 } });
    expect(v.calls).toEqual([{ from: new Date('2026-11-23T00:00:00Z'), to: new Date('2026-11-25T00:00:00Z') }]);
    const rows = (await t.db.select().from(vantageScheduledUnits)).sort((a, b) => a.workUnitId - b.workUnitId);
    expect(rows.map((r) => [r.workUnitId, r.engineerId])).toEqual([[1, 4], [2, 5]]);
  });

  it('clears the table on an empty answer (a weekend)', async () => {
    await t.db.insert(vantageScheduledUnits).values({ workUnitId: 99, workId: 1, scheduledStart: NOW, raw: {} });
    const res = await runVantageSchedule({ db: t.db, vantage: fakeVantageSchedule([]).client, now: () => NOW });
    expect(res).toMatchObject({ status: 'success', stats: { units: 0 } });
    expect(await t.db.select().from(vantageScheduledUnits)).toEqual([]);
  });

  it('keeps the previous rows when the fetch throws', async () => {
    await t.db.insert(vantageScheduledUnits).values({ workUnitId: 99, workId: 1, scheduledStart: NOW, raw: {} });
    await expect(runVantageSchedule({ db: t.db, vantage: fakeVantageSchedule(new Error('boom')).client, now: () => NOW })).rejects.toThrow('boom');
    expect((await t.db.select().from(vantageScheduledUnits)).map((r) => r.workUnitId)).toEqual([99]);
  });

  it('reports partial on a rate limit or auth error and keeps the previous rows', async () => {
    await t.db.insert(vantageScheduledUnits).values({ workUnitId: 99, workId: 1, scheduledStart: NOW, raw: {} });
    for (const err of [new RateLimitError('slow down', new Date('2026-11-23T08:10:00Z')), new AuthError('no', 401)]) {
      const res = await runVantageSchedule({ db: t.db, vantage: fakeVantageSchedule(err).client, now: () => NOW });
      expect(res.status).toBe('partial');
    }
    expect((await t.db.select().from(vantageScheduledUnits)).map((r) => r.workUnitId)).toEqual([99]);
  });
});
