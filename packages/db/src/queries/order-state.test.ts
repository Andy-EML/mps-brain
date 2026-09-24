import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drmsEquipment, replenishmentOrders, replenishmentProposals, vantageSalesOrderLines, vantageSalesOrders } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getOrderStates } from './order-state';

const NOW = new Date('2026-09-21T12:00:00Z');
const d = (iso: string) => new Date(iso);

describe('getOrderStates', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values({ drmsId: 'dev', raw: {} });
  });
  afterEach(() => t.close());

  async function order(id: number, o: { eq?: number | null; completed?: Date | null; deleted?: Date | null; date?: Date }, lines: { eq?: number | null; colour: string; returned?: Date | null }[]) {
    await t.db.insert(vantageSalesOrders).values({
      vantageId: id, reference: `SO${id}`, orderDate: o.date ?? d('2026-09-01'), completedDate: o.completed ?? null,
      deletedDate: o.deleted ?? null, vantageEquipmentId: o.eq ?? null, raw: {},
    });
    await t.db.insert(vantageSalesOrderLines).values(
      lines.map((l, i) => ({ vantageId: id * 10 + i, salesOrderId: id, vantageEquipmentId: l.eq ?? null, colour: l.colour, returnedDate: l.returned ?? null, raw: {} })),
    );
  }

  it('finds open orders through either link path and the last completion per colour', async () => {
    await order(1, { eq: 100, completed: null, date: d('2026-09-19') }, [{ colour: 'cyan' }]);
    await order(2, { eq: null, completed: d('2026-09-10'), date: d('2026-09-08') }, [{ eq: 100, colour: 'black' }]);
    await order(3, { eq: 100, completed: d('2026-08-01'), date: d('2026-07-30') }, [{ colour: 'black' }]);
    const s = (await getOrderStates(t.db, [100, 200], NOW)).get(100)!;
    expect(s.cyan.open).toEqual({ reference: 'SO1', orderDate: d('2026-09-19'), source: 'vantage' });
    expect(s.black).toEqual({ open: null, lastCompletedAt: d('2026-09-10'), lastCompletedReference: 'SO2', last: { reference: 'SO2', orderDate: d('2026-09-08'), source: 'vantage', open: false } });
    expect(s.magenta).toEqual({ open: null, lastCompletedAt: null, lastCompletedReference: null, last: null });
  });

  it('returns an empty state for an id with no orders', async () => {
    expect((await getOrderStates(t.db, [200], NOW)).get(200)?.waste).toEqual({ open: null, lastCompletedAt: null, lastCompletedReference: null, last: null });
  });

  it('ignores deleted orders, returned lines and unclassified lines', async () => {
    await order(4, { eq: 100, deleted: d('2026-09-02') }, [{ colour: 'yellow' }]);
    await order(5, { eq: 100 }, [{ colour: 'magenta', returned: d('2026-09-03') }, { colour: 'unknown' }]);
    const s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.yellow.open).toBeNull();
    expect(s.magenta.open).toBeNull();
  });

  it('counts our own in-flight orders until the Vantage order has been pulled', async () => {
    const [o] = await t.db.insert(replenishmentOrders).values({
      drmsEquipmentId: 'dev', vantageEquipmentId: 100, status: 'submitted', request: {}, vantageSalesOrderId: 77, submittedAt: d('2026-09-20T09:00:00Z'),
    }).returning();
    await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: 'dev', colour: 'waste', trigger: 'alarm', status: 'ordered', orderId: o!.id });
    let s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.waste.open).toMatchObject({ source: 'mps' });

    await order(77, { eq: 100, completed: d('2026-09-21T08:00:00Z') }, [{ colour: 'waste' }]);
    s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.waste.open).toBeNull();
    expect(s.waste.lastCompletedAt).toEqual(d('2026-09-21T08:00:00Z'));
  });

  it('stops counting an unpulled submitted order after the suppression window, but never an uncertain one', async () => {
    const [a] = await t.db.insert(replenishmentOrders).values({ drmsEquipmentId: 'dev', vantageEquipmentId: 100, status: 'submitted', request: {}, submittedAt: d('2026-09-01') }).returning();
    const [b] = await t.db.insert(replenishmentOrders).values({ drmsEquipmentId: 'dev', vantageEquipmentId: 100, status: 'uncertain', request: {}, submittedAt: d('2026-09-01') }).returning();
    await t.db.insert(replenishmentProposals).values([
      { drmsEquipmentId: 'dev', colour: 'black', trigger: 'threshold', status: 'ordered', orderId: a!.id },
      { drmsEquipmentId: 'dev', colour: 'cyan', trigger: 'threshold', status: 'ordered', orderId: b!.id },
    ]);
    const s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.black.open).toBeNull();
    expect(s.cyan.open).toMatchObject({ source: 'mps' });
  });

  it('a newer open mps order beats an older completed vantage order for `last`', async () => {
    await order(6, { eq: 100, completed: d('2026-09-01') }, [{ colour: 'yellow' }]);
    const [o] = await t.db.insert(replenishmentOrders).values({
      drmsEquipmentId: 'dev', vantageEquipmentId: 100, status: 'queued', request: {}, createdAt: d('2026-09-21T10:00:00Z'),
    }).returning();
    await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: 'dev', colour: 'yellow', trigger: 'threshold', status: 'pending', orderId: o!.id });
    const s = (await getOrderStates(t.db, [100], NOW)).get(100)!;
    expect(s.yellow.last).toMatchObject({ source: 'mps', open: true });
    expect(s.yellow.lastCompletedAt).toEqual(d('2026-09-01'));
  });
});
