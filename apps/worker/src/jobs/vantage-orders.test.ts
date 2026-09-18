import { AuthError, RateLimitError } from '@mps/core';
import { syncRuns, vantageSalesOrderLines, vantageSalesOrders } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { QUEUES } from '@mps/queue';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantageOrders } from '../test-helpers';
import { mapSalesOrder, mapSalesOrderLine, runVantageOrders } from './vantage-orders';

const NOW = new Date('2026-09-18T02:40:00Z');

const line = (Id: number, extra: object = {}) => ({
  Id,
  Details: 'Xerox B310 Black Toner',
  Quantity: 2,
  ReturnedDate: null,
  EquipmentId: null,
  Item: { Id: 900, PartNumber: 'MISC', Description: 'Miscellaneous' },
  ...extra,
});

const order = (Id: number, extra: object = {}) => ({
  Id,
  Reference: `SO2609-0${Id}`,
  OrderDate: '2026-09-14T00:00:00Z',
  CompletedDate: null,
  IsOnHold: false,
  IsNonStock: false,
  TypeId: 1,
  Type: { Id: 1, Name: 'Consumable order' },
  EquipmentId: 5001,
  ContractId: 77,
  CustomerSellToId: 11,
  CustomerShipToId: 12,
  ModifiedDate: '2026-09-15T09:00:00Z',
  Lines: [line(Id * 10)],
  ...extra,
});

describe('mapSalesOrder / mapSalesOrderLine', () => {
  it('maps the header, flattens the expanded type and keeps raw', () => {
    const raw = order(7);
    const row = mapSalesOrder(raw, NOW);
    expect(row).toMatchObject({
      vantageId: 7,
      reference: 'SO2609-07',
      completedDate: null,
      isOnHold: false,
      isNonStock: false,
      typeId: 1,
      typeName: 'Consumable order',
      vantageEquipmentId: 5001,
      contractId: 77,
      customerSellToId: 11,
      customerShipToId: 12,
      deletedDate: null,
      raw,
    });
    expect(row.orderDate?.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    // The pull must never claim an order as one this app raised.
    expect(row.createdByMps).toBeUndefined();
  });

  it('tolerates a null EquipmentId and a missing Type', () => {
    const row = mapSalesOrder({ Id: 8, EquipmentId: null }, NOW);
    expect(row).toMatchObject({ vantageId: 8, vantageEquipmentId: null, typeName: null });
  });

  it('rejects a record without Id', () => {
    expect(() => mapSalesOrder({ Reference: 'SO1' }, NOW)).toThrow();
    expect(() => mapSalesOrderLine({ Details: 'x' }, 1, NOW)).toThrow();
  });

  it('maps a line, keeps Details verbatim and classifies its colour', () => {
    const raw = line(70, { Details: 'Konica Minolta C3351i Waste Toner', Item: { Id: 3, PartNumber: 'MIN90014', Description: 'Waste box' } });
    const row = mapSalesOrderLine(raw, 7, NOW);
    expect(row).toMatchObject({
      vantageId: 70,
      salesOrderId: 7,
      details: 'Konica Minolta C3351i Waste Toner',
      itemId: 3,
      itemPartNumber: 'MIN90014',
      itemDescription: 'Waste box',
      quantity: '2',
      colour: 'waste',
      colourSource: 'details',
      raw,
    });
  });

  it('falls back to the item description for the colour when Details has none', () => {
    const row = mapSalesOrderLine(
      line(71, { Details: 'Replacement cartridge', Item: { Id: 4, PartNumber: 'B1168', Description: 'Olivetti Magenta Toner' } }),
      7,
      NOW,
    );
    expect(row).toMatchObject({ colour: 'magenta', colourSource: 'item' });
  });
});

describe('runVantageOrders', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('pulls the last 24 months when there is no previous success', async () => {
    const v = fakeVantageOrders([order(1), order(2)]);
    const result = await runVantageOrders({ db: t.db, vantage: v.client, now: () => NOW });

    expect(result).toMatchObject({ status: 'success', stats: { orders: 2, lines: 2, full: 1 } });
    expect(v.calls).toEqual([{ includeDeleted: false, orderDateFrom: new Date('2024-09-18T02:40:00Z') }]);
    expect(await t.db.select().from(vantageSalesOrders)).toHaveLength(2);
    expect(await t.db.select().from(vantageSalesOrderLines)).toHaveLength(2);
  });

  it('pulls incrementally from the last success minus the overlap, including deleted rows', async () => {
    await t.db
      .insert(syncRuns)
      .values({ job: QUEUES.vantageOrders, status: 'success', startedAt: new Date('2026-09-17T02:40:00Z') });

    const v = fakeVantageOrders([order(1, { DeletedDate: '2026-09-17T12:00:00Z' })]);
    const result = await runVantageOrders({ db: t.db, vantage: v.client, now: () => NOW });

    expect(result.stats.full).toBe(0);
    expect(v.calls).toEqual([{ since: new Date('2026-09-17T00:40:00Z'), includeDeleted: true }]);
    const [row] = await t.db.select().from(vantageSalesOrders);
    expect(row?.deletedDate?.toISOString()).toBe('2026-09-17T12:00:00.000Z');
  });

  it('replaces an order lines on a re-pull instead of duplicating or orphaning them', async () => {
    await runVantageOrders({ db: t.db, vantage: fakeVantageOrders([order(1)]).client, now: () => NOW });
    expect(await t.db.select().from(vantageSalesOrderLines)).toHaveLength(1);

    // Same order, re-pulled: line 10 is gone, 11 and 12 are new.
    const again = fakeVantageOrders([
      order(1, { Reference: 'SO2609-0214', Lines: [line(11, { Details: 'Cyan Toner' }), line(12)] }),
    ]);
    const result = await runVantageOrders({ db: t.db, vantage: again.client, now: () => NOW });

    expect(result.stats).toMatchObject({ orders: 1, lines: 2 });
    const lines = await t.db.select().from(vantageSalesOrderLines);
    expect(lines.map((l) => l.vantageId).sort()).toEqual([11, 12]);
    const [header] = await t.db.select().from(vantageSalesOrders);
    expect(header?.reference).toBe('SO2609-0214');
  });

  it('never clears created_by_mps when re-pulling an order this app raised', async () => {
    await runVantageOrders({ db: t.db, vantage: fakeVantageOrders([order(1)]).client, now: () => NOW });
    await t.db
      .update(vantageSalesOrders)
      .set({ createdByMps: true })
      .where(eq(vantageSalesOrders.vantageId, 1));

    await runVantageOrders({
      db: t.db,
      vantage: fakeVantageOrders([order(1, { CompletedDate: '2026-09-16T10:00:00Z' })]).client,
      now: () => NOW,
    });

    const [row] = await t.db.select().from(vantageSalesOrders);
    expect(row?.createdByMps).toBe(true);
    expect(row?.completedDate?.toISOString()).toBe('2026-09-16T10:00:00.000Z');
  });

  it('handles an order with no lines', async () => {
    const v = fakeVantageOrders([order(1, { Lines: [] }), order(2, { Lines: undefined })]);
    const result = await runVantageOrders({ db: t.db, vantage: v.client, now: () => NOW });
    expect(result.stats).toMatchObject({ orders: 2, lines: 0 });
  });

  it('reports partial and does not retry when Vantage rate-limits or rejects the token', async () => {
    for (const err of [new RateLimitError('429', new Date(NOW.getTime() + 60_000)), new AuthError('401', 401)]) {
      const v = fakeVantageOrders(err);
      const result = await runVantageOrders({ db: t.db, vantage: v.client, now: () => NOW });
      expect(result.status).toBe('partial');
      expect(result.stats).toMatchObject({ orders: 0, lines: 0 });
      expect(result.errorSample).toContain('stopped');
    }
  });

  it('lets an unexpected error fail the run', async () => {
    const v = fakeVantageOrders(new Error('socket hang up'));
    await expect(runVantageOrders({ db: t.db, vantage: v.client, now: () => NOW })).rejects.toThrow('socket hang up');
  });
});
