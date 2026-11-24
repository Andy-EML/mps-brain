import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pmPlan,
  users,
  vantageCustomers,
  vantageEngineers,
  vantageEquipment,
  vantageEquipmentContracts,
  vantageMeterReadings,
  vantageScheduledUnits,
  vantageWorkVisits,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { dismissPm } from './pm-actions';
import { askNote, planFromMap } from './pm-map';
import { addToPlan, moveCard } from './pm-plan';
import { SettingsError } from './settings';

const NOW = new Date('2026-11-23T09:00:00Z');
const DAY = 86_400_000;
const ago = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY);

describe('askNote', () => {
  it('uses the London day and short month', () => {
    expect(askNote('Dave', new Date('2026-11-24T09:00:00Z'))).toBe('Asked Dave for 24 Nov');
    expect(askNote('Dave', new Date('2026-06-30T23:30:00Z'))).toBe('Asked Dave for 1 Jul');
  });
});

describe('planFromMap', () => {
  let t: TestDb;
  let userId: number;
  let wid = 0;
  let rid = 0;

  beforeEach(async () => {
    t = await createTestDb();
    wid = 0;
    rid = 0;
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
    userId = u!.id;
    await t.db.insert(vantageCustomers).values({ vantageId: 7, name: 'Acme', raw: { PostCode: 'GU14 7PR', Latitude: '51.29', Longitude: '-0.75' } });
    await t.db.insert(vantageEngineers).values({ vantageId: 1, name: 'Dave Smith', raw: {} });
    await t.db.insert(vantageScheduledUnits).values({
      workUnitId: 50,
      workId: 50,
      engineerId: 1,
      customerId: 7,
      scheduledStart: new Date('2026-11-24T09:00:00Z'),
      categoryName: 'Break/fix',
      categoryType: 'Field',
      raw: {},
    });
  });
  afterEach(() => t.close());

  const item = { Item: { IsMetered: true, NominalCode: '4000' } };
  async function dueMachine(id: number) {
    await t.db.insert(vantageEquipment).values({ vantageId: id, customerName: 'Cust 7', vantageCustomerId: 7, serial: `SER${id}`, description: 'C300i', raw: item });
    await t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: id, contractId: id * 10, isActive: true });
    for (const [iso, v] of [[ago(300), 1000], [ago(10), 50_000]] as const) {
      await t.db.insert(vantageMeterReadings).values({ vantageId: ++rid, vantageEquipmentId: id, meterTypeId: 1, readingAt: iso, reading: v, raw: {} });
    }
    await t.db.insert(vantageWorkVisits).values({
      workUnitId: ++wid,
      workId: wid,
      vantageEquipmentId: id,
      categoryId: 1,
      categoryName: 'Break/fix',
      categoryType: 'Field',
      loggedAt: ago(600),
      workStart: ago(600),
      workHours: 2,
      raw: {},
    });
  }
  const plans = async () => Object.fromEntries((await t.db.select().from(pmPlan)).map((r) => [r.vantageEquipmentId, r]));

  it('adds unplanned machines to To plan', async () => {
    await dueMachine(1);
    await dueMachine(2);
    const r = await planFromMap(t.db, { vantageEquipmentIds: [1, 2], mode: 'add', userId, now: NOW });
    expect(r.done.sort()).toEqual([1, 2]);
    expect(r.skipped).toEqual([]);
    const p = await plans();
    expect(p[1]!.boardColumn).toBe('to_plan');
    expect(p[2]!.boardColumn).toBe('to_plan');
  });

  it('counts machines already To plan or Asked as done without changing them', async () => {
    await dueMachine(1);
    await dueMachine(2);
    await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(2) });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'asked', note: 'keep', userId, now: ago(2) });
    const r = await planFromMap(t.db, { vantageEquipmentIds: [1, 2], mode: 'add', userId, now: NOW });
    expect(r.done.sort()).toEqual([1, 2]);
    const p = await plans();
    expect(p[1]!.boardColumn).toBe('to_plan');
    expect(p[2]!.boardColumn).toBe('asked');
    expect(p[2]!.boardNote).toBe('keep');
  });

  it('asks engineer for many', async () => {
    await dueMachine(1);
    await dueMachine(2);
    const r = await planFromMap(t.db, { vantageEquipmentIds: [1, 2], mode: 'ask', workUnitId: 50, userId, now: NOW });
    expect(r.done.sort()).toEqual([1, 2]);
    expect(r.call?.engineerName).toBeTruthy();
    const p = await plans();
    for (const id of [1, 2]) {
      expect(p[id]!.boardColumn).toBe('asked');
      expect(p[id]!.boardNote).toContain(`Asked ${r.call!.engineerName} for`);
    }
  });

  it('skips machines that left the map set', async () => {
    await dueMachine(1);
    await dueMachine(2);
    await dismissPm(t.db, { vantageEquipmentId: 2, reason: 'not_now', note: null, servicedOn: null, userId, now: NOW });
    const r = await planFromMap(t.db, { vantageEquipmentIds: [1, 2, 999], mode: 'add', userId, now: NOW });
    expect(r.done).toEqual([1]);
    expect(r.skipped).toEqual([
      { vantageEquipmentId: 2, reason: 'not_on_map' },
      { vantageEquipmentId: 999, reason: 'not_on_map' },
    ]);
  });

  it('refuses when the call is gone', async () => {
    await dueMachine(1);
    const err = await planFromMap(t.db, { vantageEquipmentIds: [1], mode: 'ask', workUnitId: 999, userId, now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).code).toBe('call_gone');
    expect(await t.db.select().from(pmPlan)).toEqual([]);
  });

  it('add restarts a Done card on To plan', async () => {
    await dueMachine(1);
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: ago(3) });
    const r = await planFromMap(t.db, { vantageEquipmentIds: [1], mode: 'add', userId, now: NOW });
    expect(r.done).toEqual([1]);
    expect(r.skipped).toEqual([]);
    expect((await plans())[1]!.boardColumn).toBe('to_plan');
  });

  it('ask moves a Done card out of Done to Asked', async () => {
    await dueMachine(1);
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: ago(3) });
    const r = await planFromMap(t.db, { vantageEquipmentIds: [1], mode: 'ask', workUnitId: 50, userId, now: NOW });
    expect(r.done).toEqual([1]);
    expect(r.skipped).toEqual([]);
    expect((await plans())[1]!.boardColumn).toBe('asked');
  });

  it('already Asked gets the extra note line', async () => {
    await dueMachine(1);
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', note: 'Key code 1234', userId, now: ago(3) });
    await planFromMap(t.db, { vantageEquipmentIds: [1], mode: 'ask', workUnitId: 50, userId, now: NOW });
    const p = await plans();
    expect(p[1]!.boardColumn).toBe('asked');
    expect(p[1]!.boardNote).toMatch(/^Key code 1234\nAsked .+ for 24 Nov$/);
  });
});
