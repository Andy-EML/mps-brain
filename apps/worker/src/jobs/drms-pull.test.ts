import { drmsCustomers, drmsEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsCustomer, DrmsEquipment } from '@mps/drms';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drmsDevice } from '../test-helpers';
import { mapDrmsEquipment, runDrmsPull } from './drms-pull';

function fakeDrms(equipment: DrmsEquipment[], customers: DrmsCustomer[] | Error) {
  return {
    listEquipment: async () => equipment,
    listCustomers: async () => {
      if (customers instanceof Error) throw customers;
      return customers;
    },
  };
}

describe('mapDrmsEquipment', () => {
  it('maps fields, normalises serial and parses DRMS dates', () => {
    const e = drmsDevice('g1', { SerialNumber: 'a1b-2', RegistrationTime: '2026-01-02 03:04:05', ErpId: '77' });
    const row = mapDrmsEquipment(e, new Date('2026-09-17T02:15:00Z'));
    expect(row).toMatchObject({ drmsId: 'g1', erpId: '77', serialNorm: 'A1B2', status: 'Registered', customerErpId: 'C1', missingSince: null, raw: e });
    expect(row.registrationTime?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('runDrmsPull', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('upserts devices and customers, keeping first-seen, flagging missing', async () => {
    const day1 = new Date('2026-09-16T02:15:00Z');
    const day2 = new Date('2026-09-17T02:15:00Z');
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1'), drmsDevice('g2')], [{ Id: 'c1', Name: 'Cust', ErpId: 'C1', CsrcIds: ['X'] }]), now: () => day1 });
    const result = await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1', { Status: 'PreRegistered' })], []), now: () => day2 });

    expect(result).toMatchObject({ status: 'success', stats: { equipment: 1, markedMissing: 1, customers: 0 } });
    const [g1] = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'g1'));
    expect(g1).toMatchObject({ status: 'PreRegistered', missingSince: null });
    expect(g1?.firstSeenAt.toISOString()).toBe(day1.toISOString());
    expect(g1?.lastSeenAt.toISOString()).toBe(day2.toISOString());
    const [g2] = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'g2'));
    expect(g2?.missingSince?.toISOString()).toBe(day2.toISOString());
    const [c1] = await t.db.select().from(drmsCustomers);
    expect(c1).toMatchObject({ drmsId: 'c1', erpId: 'C1', csrcIds: ['X'] });
  });

  it('clears missingSince when a device returns', async () => {
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1'), drmsDevice('g2')], []), now: () => new Date('2026-09-15T02:15:00Z') });
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-16T02:15:00Z') });
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1'), drmsDevice('g2')], []), now: () => new Date('2026-09-17T02:15:00Z') });
    const [g2] = await t.db.select().from(drmsEquipment).where(eq(drmsEquipment.drmsId, 'g2'));
    expect(g2?.missingSince).toBeNull();
  });

  it('keeps lastSnapshotFetchAt across pulls', async () => {
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-16T02:15:00Z') });
    await t.db.update(drmsEquipment).set({ lastSnapshotFetchAt: new Date('2026-09-16T06:00:00Z') });
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-17T02:15:00Z') });
    const [g1] = await t.db.select().from(drmsEquipment);
    expect(g1?.lastSnapshotFetchAt?.toISOString()).toBe('2026-09-16T06:00:00.000Z');
  });

  it('refuses to mark everything missing when DRMS returns nothing', async () => {
    await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], []), now: () => new Date('2026-09-16T02:15:00Z') });
    await expect(runDrmsPull({ db: t.db, drms: fakeDrms([], []), now: () => new Date('2026-09-17T02:15:00Z') })).rejects.toThrow('refusing');
  });

  it('is partial when customers fail but equipment succeeds', async () => {
    const result = await runDrmsPull({ db: t.db, drms: fakeDrms([drmsDevice('g1')], new Error('nope')), now: () => new Date() });
    expect(result.status).toBe('partial');
    expect(result.errorSample).toBe('customers: Error: nope');
    expect(await t.db.select().from(drmsEquipment)).toHaveLength(1);
  });
});
