import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceLinks, drmsEquipment, vantageCustomers, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { searchVantageCustomers } from './customers';

describe('searchVantageCustomers', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageCustomers).values([
      { vantageId: 1, name: 'Acme Printing', reference: 'ACM001', raw: {} },
      { vantageId: 2, name: 'Beta School', reference: 'BET001', raw: {} },
      // Matches "acme" but has no linked DRMS device.
      { vantageId: 3, name: 'Acme Holdings', reference: 'ACM002', raw: {} },
      // Linked, but its only link has been closed.
      { vantageId: 4, name: 'Acme Old', reference: 'ACM003', raw: {} },
      // Deleted in Vantage.
      { vantageId: 5, name: 'Acme Gone', reference: 'ACM004', deletedDate: new Date('2026-01-01T00:00:00Z'), raw: {} },
    ]);
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'd1', raw: {} },
      { drmsId: 'd2', raw: {} },
      { drmsId: 'd3', raw: {} },
      { drmsId: 'd4', raw: {} },
      { drmsId: 'd5', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 101, vantageCustomerId: 1, raw: {} },
      { vantageId: 102, vantageCustomerId: 1, raw: {} },
      { vantageId: 103, vantageCustomerId: 1, raw: {} }, // not linked: not counted
      { vantageId: 201, vantageCustomerId: 2, raw: {} },
      { vantageId: 301, vantageCustomerId: 3, raw: {} },
      { vantageId: 401, vantageCustomerId: 4, raw: {} },
      { vantageId: 501, vantageCustomerId: 5, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'd1', vantageEquipmentId: 101, method: 'serial' },
      { drmsEquipmentId: 'd2', vantageEquipmentId: 102, method: 'serial' },
      { drmsEquipmentId: 'd3', vantageEquipmentId: 201, method: 'serial' },
      { drmsEquipmentId: 'd4', vantageEquipmentId: 401, method: 'serial', unlinkedAt: new Date('2026-09-01T00:00:00Z') },
      { drmsEquipmentId: 'd5', vantageEquipmentId: 501, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  it('matches the name case-insensitively, only customers with a linked device, with device counts', async () => {
    expect(await searchVantageCustomers(t.db, 'aCmE')).toEqual([
      { vantageId: 1, name: 'Acme Printing', reference: 'ACM001', deviceCount: 2 },
    ]);
  });

  it('matches the reference case-insensitively', async () => {
    expect(await searchVantageCustomers(t.db, 'bet0')).toEqual([
      { vantageId: 2, name: 'Beta School', reference: 'BET001', deviceCount: 1 },
    ]);
  });

  it('orders by name and honours the limit', async () => {
    const all = await searchVantageCustomers(t.db, 'e');
    expect(all.map((r) => r.name)).toEqual(['Acme Printing', 'Beta School']);
    expect(await searchVantageCustomers(t.db, 'e', 1)).toHaveLength(1);
  });

  it('treats % and _ in the query as plain text', async () => {
    expect(await searchVantageCustomers(t.db, '%')).toEqual([]);
    expect(await searchVantageCustomers(t.db, 'ACM_01')).toEqual([]);
  });
});
