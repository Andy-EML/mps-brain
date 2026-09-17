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

  it('does an incremental pull including deleted rows since last success minus 2 hours', async () => {
    await t.db.insert(syncRuns).values({ job: 'vantage-pull', status: 'success', startedAt: new Date('2026-09-16T02:00:00Z') });
    const v = fakeVantage([], [equipment(10, { DeletedDate: '2026-09-16T12:00:00Z' })]);
    const result = await runVantagePull({ db: t.db, vantage: v.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: false });
    expect(result.stats.full).toBe(0);
    expect(v.calls[1]?.opts).toEqual({ since: new Date('2026-09-16T00:00:00Z'), includeDeleted: true });
    const [row] = await t.db.select().from(vantageEquipment);
    expect(row?.deletedDate?.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });

  it('updates existing rows and marks vanished rows deleted on a full pull', async () => {
    // 5 active rows each; the second pull returns 4 of 5 (80%), which is enough to trust deletions.
    const first = fakeVantage([1, 2, 3, 4, 5].map((id) => customer(id)), [10, 11, 12, 13, 14].map((id) => equipment(id)));
    await runVantagePull({ db: t.db, vantage: first.client, now: () => new Date('2026-09-16T02:00:00Z') }, { full: true });
    const second = fakeVantage(
      [customer(1, { Name: 'Renamed' }), customer(3), customer(4), customer(5)],
      [equipment(10, { SerialNumber: 'NEW' }), equipment(12), equipment(13), equipment(14)],
    );
    const result = await runVantagePull({ db: t.db, vantage: second.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: true });
    expect(result.status).toBe('success');
    expect(result.stats).toMatchObject({ customersMarkedDeleted: 1, equipmentMarkedDeleted: 1 });
    const [c1] = await t.db.select().from(vantageCustomers).where(eq(vantageCustomers.vantageId, 1));
    expect(c1?.name).toBe('Renamed');
    const [e10] = await t.db.select().from(vantageEquipment).where(eq(vantageEquipment.vantageId, 10));
    expect(e10).toMatchObject({ serialNorm: 'NEW', deletedDate: null });
    const [e11] = await t.db.select().from(vantageEquipment).where(eq(vantageEquipment.vantageId, 11));
    expect(e11?.deletedDate?.toISOString()).toBe('2026-09-17T02:00:00.000Z');
  });

  it('does not mark deletions when a full pull returns too few rows', async () => {
    const ids = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const first = fakeVantage([customer(1), customer(2)], ids.map((id) => equipment(id)));
    await runVantagePull({ db: t.db, vantage: first.client, now: () => new Date('2026-09-16T02:00:00Z') }, { full: true });

    const second = fakeVantage([], [equipment(10, { SerialNumber: 'NEW' })]);
    const result = await runVantagePull({ db: t.db, vantage: second.client, now: () => new Date('2026-09-17T02:00:00Z') }, { full: true });
    expect(result).toMatchObject({ status: 'partial', stats: { customersMarkedDeleted: 0, equipmentMarkedDeleted: 0 } });
    expect(result.errorSample).toContain('customers');
    expect(result.errorSample).toContain('equipment');
    const rows = await t.db.select().from(vantageEquipment);
    expect(rows.filter((r) => r.deletedDate !== null)).toEqual([]);
    expect(rows.find((r) => r.vantageId === 10)?.serialNorm).toBe('NEW');
    expect((await t.db.select().from(vantageCustomers)).filter((r) => r.deletedDate !== null)).toEqual([]);
  });
});
