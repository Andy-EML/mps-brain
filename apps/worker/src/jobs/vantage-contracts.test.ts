import { RateLimitError } from '@mps/core';
import { vantageEquipmentContracts } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantageContracts } from '../test-helpers';
import { mapEquipmentContracts, runVantageContracts } from './vantage-contracts';

const NOW = new Date('2026-11-17T02:55:00Z');
const active = { Id: 10, Reference: 'C-10', StatusId: 1, IsOnHold: false, CancellationDate: null, DeletedDate: null };
const cancelled = { Id: 11, Reference: 'C-11', StatusId: 1, IsOnHold: false, CancellationDate: '2026-01-01T00:00:00Z', DeletedDate: null };
const equipment = (Id: number, extra: object = {}) => ({
  Id,
  Meters: [{ TypeId: 1, Charge: { Id: 1, Contract: active } }],
  ContractCharges: [{ Id: 2, Contract: cancelled }],
  ...extra,
});

describe('mapEquipmentContracts', () => {
  it('emits one row per distinct contract with is_active from isActiveContract', () => {
    const rows = mapEquipmentContracts(equipment(184, { Meters: [{ Charge: { Contract: active } }, { Charge: { Contract: active } }] }), NOW);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.contractId === 10)).toMatchObject({ vantageEquipmentId: 184, contractReference: 'C-10', isActive: true });
    expect(rows.find((r) => r.contractId === 11)).toMatchObject({ isActive: false });
  });
  it('returns nothing without an equipment id', () => {
    expect(mapEquipmentContracts({ Meters: [] }, NOW)).toEqual([]);
  });
});

describe('runVantageContracts', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('replaces previous rows', async () => {
    await t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: 999, contractId: 1, isActive: true });
    const v = fakeVantageContracts([equipment(184)]);
    const result = await runVantageContracts({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result).toMatchObject({ status: 'success', stats: { equipment: 1, contracts: 2 } });
    const rows = await t.db.select().from(vantageEquipmentContracts);
    expect(rows.map((r) => r.vantageEquipmentId)).toEqual([184, 184]);
  });

  it('keeps the previous rows and fails when Vantage returns no equipment', async () => {
    await t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: 999, contractId: 1, isActive: true });
    const v = fakeVantageContracts([]);
    await expect(runVantageContracts({ db: t.db, vantage: v.client, now: () => NOW })).rejects.toThrow(/no records/);
    expect(await t.db.select().from(vantageEquipmentContracts)).toHaveLength(1);
  });

  it('keeps the previous rows and is partial on a rate limit', async () => {
    await t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: 999, contractId: 1, isActive: true });
    const v = fakeVantageContracts(new RateLimitError('slow down', new Date('2026-11-17T03:00:00Z')));
    const result = await runVantageContracts({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result.status).toBe('partial');
    expect(await t.db.select().from(vantageEquipmentContracts)).toHaveLength(1);
  });
});
