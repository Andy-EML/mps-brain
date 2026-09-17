import { syncRuns, vantageCustomers, vantageEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantage } from '../test-helpers';
import { mapVantageEquipment, runVantagePull } from './vantage-pull';

const customer = (Id: number, extra: object = {}) => ({ Id, Reference: `C${Id}`, Name: `Cust ${Id}`, IsActive: true, ...extra });
const equipment = (Id: number, extra: object = {}) => ({
  Id,
  SerialNumber: `ab-${Id}`,
  AssetNumber: `EQ${Id}`,
  Description: 'bizhub',
  Item: { PartNumber: 'C300i', Description: 'bizhub C300i' },
  Customer: { Id: 1, Reference: 'C1', Name: 'Cust 1' },
  ModifiedDate: '2026-09-10T08:00:00Z',
  ...extra,
});

describe('mapVantageEquipment', () => {
  it('maps expanded item and customer, normalises serial, keeps raw', () => {
    const raw = equipment(5);
    const row = mapVantageEquipment(raw, new Date('2026-09-17T02:00:00Z'));
    expect(row).toMatchObject({
      vantageId: 5,
      serial: 'ab-5',
      serialNorm: 'AB5',
      assetNumber: 'EQ5',
      itemPartNumber: 'C300i',
      vantageCustomerId: 1,
      customerReference: 'C1',
      customerName: 'Cust 1',
      deletedDate: null,
      raw,
    });
    expect(row.modifiedDate?.toISOString()).toBe('2026-09-10T08:00:00.000Z');
  });
  it('rejects a record without Id', () => {
    expect(() => mapVantageEquipment({ SerialNumber: 'x' }, new Date())).toThrow();
  });
});

describe('runVantagePull', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('does a full pull when there is no previous success', async () => {
    const v = fakeVantage([customer(1)], [equipment(10), equipment(11)]);
    const result = await runVantagePull({ db: t.db, vantage: v.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: false });
    expect(result).toMatchObject({ status: 'success', stats: { customers: 1, equipment: 2, full: 1 } });
    expect(v.calls.map((c) => c.opts)).toEqual([{ includeDeleted: false }, { includeDeleted: false }]);
    expect(await t.db.select().from(vantageEquipment)).toHaveLength(2);
  });

  it('does an incremental pull including deleted rows since last success minus 10 minutes', async () => {
    await t.db.insert(syncRuns).values({ job: 'vantage-pull', status: 'success', startedAt: new Date('2026-09-16T02:00:00Z') });
    const v = fakeVantage([], [equipment(10, { DeletedDate: '2026-09-16T12:00:00Z' })]);
    const result = await runVantagePull({ db: t.db, vantage: v.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: false });
    expect(result.stats.full).toBe(0);
    expect(v.calls[1]?.opts).toEqual({ since: new Date('2026-09-16T01:50:00Z'), includeDeleted: true });
    const [row] = await t.db.select().from(vantageEquipment);
    expect(row?.deletedDate?.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });

  it('updates existing rows and marks vanished rows deleted on a full pull', async () => {
    const first = fakeVantage([customer(1), customer(2)], [equipment(10), equipment(11)]);
    await runVantagePull({ db: t.db, vantage: first.client, now: () => new Date('2026-09-16T02:00:00Z') }, { full: true });
    const second = fakeVantage([customer(1, { Name: 'Renamed' })], [equipment(10, { SerialNumber: 'NEW' })]);
    const result = await runVantagePull({ db: t.db, vantage: second.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: true });
    expect(result.stats).toMatchObject({ customersMarkedDeleted: 1, equipmentMarkedDeleted: 1 });
    const [c1] = await t.db.select().from(vantageCustomers).where(eq(vantageCustomers.vantageId, 1));
    expect(c1?.name).toBe('Renamed');
    const [e10] = await t.db.select().from(vantageEquipment).where(eq(vantageEquipment.vantageId, 10));
    expect(e10).toMatchObject({ serialNorm: 'NEW', deletedDate: null });
    const [e11] = await t.db.select().from(vantageEquipment).where(eq(vantageEquipment.vantageId, 11));
    expect(e11?.deletedDate?.toISOString()).toBe('2026-09-17T02:00:00.000Z');
  });
});
