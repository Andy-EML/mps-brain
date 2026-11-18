import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  cartridgeFamilies,
  cartridgeFamilyModels,
  deviceLinks,
  drmsEquipment,
  replenishmentOrders,
  replenishmentProposals,
  siteStockShelves,
  users,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getOrderStates } from './order-state';
import { getReplenishmentStats } from './replenishment';
import { approveProposals, markOrderOrdered } from './replenishment-actions';
import { MATCH_DAYS_BEFORE_APPROVAL, londonDayAsUtc, matchSalesOrders } from './order-watch';

// Approval happens at NOW; the watcher runs a little later.
const NOW = new Date('2026-09-21T12:00:00Z');
const LATER = new Date('2026-09-22T09:00:00Z');
const day = (d: string) => new Date(`${d}T00:00:00Z`);

describe('order watcher', () => {
  let t: TestDb;
  let userId: number;
  let black: number;
  let cyan: number;

  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'd1', modelName: 'bizhub C300i', serial: 'S1', isColour: true, raw: {} },
      { drmsId: 'd2', modelName: 'bizhub C300i', serial: 'S2', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 100, raw: {} },
      { vantageId: 101, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'd1', vantageEquipmentId: 100, method: 'serial' },
      { drmsEquipmentId: 'd2', vantageEquipmentId: 101, method: 'serial' },
    ]);
    const ps = await t.db
      .insert(replenishmentProposals)
      .values([
        { drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'pending', createdAt: NOW },
        { drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'cyan', trigger: 'threshold', level: 4, threshold: 10, status: 'pending', createdAt: NOW },
      ])
      .returning();
    [black, cyan] = ps.map((p) => p.id) as [number, number];
  });
  afterEach(() => t.close());

  const order = async (id: number) => (await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, id)))[0]!;
  const proposal = async (id: number) => (await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, id)))[0]!;
  const audits = async () => (await t.db.select().from(auditLog)).filter((a) => a.action === 'order.watch');

  async function so(id: number, extra: Partial<typeof vantageSalesOrders.$inferInsert> = {}) {
    await t.db.insert(vantageSalesOrders).values({ vantageId: id, reference: `SO${id}`, orderDate: day('2026-09-21'), vantageEquipmentId: 100, raw: {}, ...extra });
  }
  async function line(id: number, salesOrderId: number, colour: string, extra: Partial<typeof vantageSalesOrderLines.$inferInsert> = {}) {
    await t.db.insert(vantageSalesOrderLines).values({ vantageId: id, salesOrderId, colour, quantity: '1', raw: {}, ...extra });
  }
  const approve = (items: { proposalId: number; quantity: number }[], drmsId = 'd1') => approveProposals(t.db, { drmsId, items, userId, now: NOW });
  const approveBoth = () =>
    approve([
      { proposalId: black, quantity: 1 },
      { proposalId: cyan, quantity: 1 },
    ]);

  it('closes an order when a sales order has a line of the same colour on its equipment', async () => {
    const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
    await so(7, { reference: 'SO2609-07' });
    await line(70, 7, 'black');

    const result = await matchSalesOrders(t.db, LATER);

    expect(result).toMatchObject({ matched: 1, completed: 1, linked: 0, topUpsSuperseded: 0 });
    expect(await order(orderId)).toMatchObject({
      status: 'submitted',
      vantageSalesOrderId: 7,
      vantageReference: 'SO2609-07',
      submittedAt: LATER,
      resolvedAt: LATER,
      resolvedBy: null,
    });
    expect(await proposal(black)).toMatchObject({ status: 'ordered', vantageSalesOrderId: 7, vantageSalesOrderLineId: 70 });
  });

  it('writes one audit row listing the ids, with no user, and nothing when there is nothing to do', async () => {
    const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
    expect(await matchSalesOrders(t.db, LATER)).toMatchObject({ matched: 0 });
    expect(await audits()).toHaveLength(0);

    await so(7);
    await line(70, 7, 'black');
    await matchSalesOrders(t.db, LATER);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: null, entity: 'order', entityIds: [orderId], at: LATER });
    expect(rows[0]!.details).toMatchObject({
      matched: [{ proposalId: black, orderId, salesOrderId: 7, lineId: 70 }],
      completedOrders: [orderId],
    });
  });

  it('is safe to re-run: a second run with nothing new changes nothing', async () => {
    const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
    await so(7);
    await line(70, 7, 'black');
    await matchSalesOrders(t.db, LATER);
    const before = [await order(orderId), await proposal(black), await t.db.select().from(auditLog)];

    const again = await matchSalesOrders(t.db, new Date('2026-09-23T09:00:00Z'));

    expect(again).toEqual({ linked: 0, matched: 0, completed: 0, topUpsSuperseded: 0 });
    expect([await order(orderId), await proposal(black), await t.db.select().from(auditLog)]).toEqual(before);
  });

  it('matches a completed sales order: one can be raised and finished between pulls', async () => {
    const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
    await so(7, { completedDate: new Date('2026-09-21T15:00:00Z') });
    await line(70, 7, 'black');
    await matchSalesOrders(t.db, LATER);
    expect((await order(orderId)).status).toBe('submitted');
  });

  describe('what does not match', () => {
    it.each([
      ['another colour', async (s: (id: number, e?: object) => Promise<void>, l: (id: number, so: number, c: string, e?: object) => Promise<void>) => { await s(7); await l(70, 7, 'cyan'); }],
      ['another equipment', async (s: (id: number, e?: object) => Promise<void>, l: (id: number, so: number, c: string, e?: object) => Promise<void>) => { await s(7, { vantageEquipmentId: 101 }); await l(70, 7, 'black'); }],
      ['a deleted sales order', async (s: (id: number, e?: object) => Promise<void>, l: (id: number, so: number, c: string, e?: object) => Promise<void>) => { await s(7, { deletedDate: LATER }); await l(70, 7, 'black'); }],
      ['a returned line', async (s: (id: number, e?: object) => Promise<void>, l: (id: number, so: number, c: string, e?: object) => Promise<void>) => { await s(7); await l(70, 7, 'black', { returnedDate: LATER }); }],
      ['a sales order too old', async (s: (id: number, e?: object) => Promise<void>, l: (id: number, so: number, c: string, e?: object) => Promise<void>) => { await s(7, { orderDate: day('2026-09-18') }); await l(70, 7, 'black'); }],
      ['a sales order with no date', async (s: (id: number, e?: object) => Promise<void>, l: (id: number, so: number, c: string, e?: object) => Promise<void>) => { await s(7, { orderDate: null }); await l(70, 7, 'black'); }],
    ])('leaves the order alone for %s', async (_name, seed) => {
      const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
      await seed(so, line);
      expect(await matchSalesOrders(t.db, LATER)).toMatchObject({ matched: 0 });
      expect((await order(orderId)).status).toBe('queued');
      expect((await proposal(black)).status).toBe('approved');
    });

    it('lets a line name its own equipment over the header, as order-state does', async () => {
      const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
      await so(7, { vantageEquipmentId: 101 });
      await line(70, 7, 'black', { vantageEquipmentId: 100 });
      await matchSalesOrders(t.db, LATER);
      expect((await order(orderId)).status).toBe('submitted');
    });
  });

  it(`counts calendar days: an order date ${MATCH_DAYS_BEFORE_APPROVAL} days before the approval day still matches`, async () => {
    expect(londonDayAsUtc(new Date('2026-07-01T23:30:00Z')).toISOString()).toBe('2026-07-02T00:00:00.000Z'); // 00:30 BST, the next London day
    // Approved at 12:00 on the 21st: raised on the 19th, a date-only midnight, still counts; the 18th does not.
    const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
    await so(7, { orderDate: day('2026-09-18') });
    await line(70, 7, 'black');
    await matchSalesOrders(t.db, LATER);
    expect((await order(orderId)).status).toBe('queued');
    await t.db.update(vantageSalesOrders).set({ orderDate: day('2026-09-19') }).where(eq(vantageSalesOrders.vantageId, 7));
    await matchSalesOrders(t.db, LATER);
    expect((await order(orderId)).status).toBe('submitted');
  });

  describe('partial matches', () => {
    it('closes the colour that is in Vantage and leaves the other in progress', async () => {
      const { orderId } = await approveBoth();
      await so(7, { reference: 'SO-K' });
      await line(70, 7, 'black');

      expect(await matchSalesOrders(t.db, LATER)).toMatchObject({ matched: 1, completed: 0 });

      expect(await proposal(black)).toMatchObject({ status: 'ordered', vantageSalesOrderId: 7, vantageSalesOrderLineId: 70 });
      expect(await proposal(cyan)).toMatchObject({ status: 'approved', vantageSalesOrderId: null });
      expect(await order(orderId)).toMatchObject({ status: 'queued', vantageSalesOrderId: null, submittedAt: null });
    });

    it('completes the order once the last colour turns up, naming both sales orders', async () => {
      const { orderId } = await approveBoth();
      await so(7, { reference: 'SO-K' });
      await line(70, 7, 'black');
      await matchSalesOrders(t.db, LATER);
      await so(8, { reference: 'SO-C', orderDate: day('2026-09-22') });
      await line(80, 8, 'cyan');
      const later = new Date('2026-09-22T11:00:00Z');

      expect(await matchSalesOrders(t.db, later)).toMatchObject({ matched: 1, completed: 1 });

      expect(await order(orderId)).toMatchObject({ status: 'submitted', vantageSalesOrderId: 7, vantageReference: 'SO-K, SO-C', submittedAt: later, resolvedAt: later });
      expect(await proposal(cyan)).toMatchObject({ status: 'ordered', vantageSalesOrderId: 8, vantageSalesOrderLineId: 80 });
    });

    it('closes both colours from one sales order that has both lines', async () => {
      const { orderId } = await approveBoth();
      await so(7);
      await line(70, 7, 'black');
      await line(71, 7, 'cyan');
      await matchSalesOrders(t.db, LATER);
      expect((await order(orderId)).status).toBe('submitted');
      expect((await proposal(cyan)).vantageSalesOrderLineId).toBe(71);
    });
  });

  describe('which candidate wins, and claiming per line', () => {
    it('takes the oldest sales order, then the lowest line id', async () => {
      await approve([{ proposalId: black, quantity: 1 }]);
      await so(7, { orderDate: day('2026-09-22') });
      await line(70, 7, 'black');
      await so(8, { orderDate: day('2026-09-21') });
      await line(82, 8, 'black');
      await line(81, 8, 'black');
      await matchSalesOrders(t.db, LATER);
      expect(await proposal(black)).toMatchObject({ vantageSalesOrderId: 8, vantageSalesOrderLineId: 81 });
    });

    it('one sales order closes a queued black and a queued cyan, each on its own line', async () => {
      const k = await approve([{ proposalId: black, quantity: 1 }]);
      const c = await approve([{ proposalId: cyan, quantity: 1 }]);
      await so(7);
      await line(70, 7, 'black');
      await line(71, 7, 'cyan');
      await matchSalesOrders(t.db, LATER);
      expect((await order(k.orderId)).status).toBe('submitted');
      expect((await order(c.orderId)).status).toBe('submitted');
    });

    it('one line closes one proposal only, now and on every later pull', async () => {
      const first = await approve([{ proposalId: black, quantity: 1 }]);
      await so(7);
      await line(70, 7, 'black');
      await matchSalesOrders(t.db, LATER);
      expect((await order(first.orderId)).status).toBe('submitted');

      // The next black empties and is approved. The only black line in Vantage is already spoken for.
      const [next] = await t.db
        .insert(replenishmentProposals)
        .values({ drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'black', trigger: 'threshold', status: 'pending', createdAt: LATER })
        .returning();
      const second = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: next!.id, quantity: 1 }], userId, now: LATER });
      await matchSalesOrders(t.db, LATER);
      await matchSalesOrders(t.db, new Date('2026-09-23T09:00:00Z'));
      expect((await order(second.orderId)).status).toBe('queued');
      expect((await proposal(black)).vantageSalesOrderLineId).toBe(70);

      // A second line is what closes it.
      await line(71, 7, 'black');
      await matchSalesOrders(t.db, new Date('2026-09-23T10:00:00Z'));
      expect((await order(second.orderId)).status).toBe('submitted');
      expect((await proposal(next!.id)).vantageSalesOrderLineId).toBe(71);
    });

    it('the database refuses a line claimed twice', async () => {
      await approve([{ proposalId: black, quantity: 1 }]);
      await t.db.update(replenishmentProposals).set({ vantageSalesOrderLineId: 70 }).where(eq(replenishmentProposals.id, black));
      await expect(t.db.update(replenishmentProposals).set({ vantageSalesOrderLineId: 70 }).where(eq(replenishmentProposals.id, cyan))).rejects.toThrow();
    });
  });

  it('puts a short note on the proposal when the quantity differs, and still closes it', async () => {
    const { orderId } = await approve([{ proposalId: black, quantity: 2 }]);
    await so(7);
    await line(70, 7, 'black', { quantity: '1' });
    await matchSalesOrders(t.db, LATER);
    expect(await proposal(black)).toMatchObject({ status: 'ordered', note: 'approved 2, Vantage 1' });
    expect((await order(orderId)).status).toBe('submitted');
  });

  it('adds no note when the quantities agree', async () => {
    await approve([{ proposalId: black, quantity: 2 }]);
    await so(7);
    await line(70, 7, 'black', { quantity: '2' });
    await matchSalesOrders(t.db, LATER);
    expect((await proposal(black)).note).toBeNull();
  });

  describe('site stock', () => {
    let shelfId: number;
    let topUp: number;

    beforeEach(async () => {
      await t.db.update(drmsEquipment).set({ status: 'REGISTERED' });
      await t.db.update(vantageEquipment).set({ vantageCustomerId: 1 });
      await t.db.insert(drmsEquipment).values({ drmsId: 'd3', modelName: 'bizhub C300i', serial: 'S3', isColour: true, status: 'REGISTERED', raw: {} });
      await t.db.insert(vantageEquipment).values({ vantageId: 102, vantageCustomerId: 2, raw: {} });
      await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd3', vantageEquipmentId: 102, method: 'serial' });
      const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'C-series', isColour: true }).returning();
      await t.db.insert(cartridgeFamilyModels).values({ familyId: fam!.id, model: 'bizhub C300i' });
      const [shelf] = await t.db
        .insert(siteStockShelves)
        .values({ vantageCustomerId: 1, familyId: fam!.id, holdingBlack: 2, usedBlack: 2, countingFrom: day('2026-09-01') })
        .returning();
      shelfId = shelf!.id;
      // d2's black proposal is the top-up's: the shelf is at customer 1, as are d1 and d2.
      const [p] = await t.db
        .insert(replenishmentProposals)
        .values({ drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'black', trigger: 'site_stock', status: 'pending', quantity: 2, shelfId, createdAt: NOW })
        .returning();
      topUp = p!.id;
      await t.db.delete(replenishmentProposals).where(eq(replenishmentProposals.id, black));
    });

    it('an approved top-up matches a line on any device currently on the shelf', async () => {
      const { orderId } = await approve([{ proposalId: topUp, quantity: 2 }]);
      // The shelf's used count came off at approval and must not move again.
      expect((await t.db.select().from(siteStockShelves))[0]).toMatchObject({ usedBlack: 0 });
      await so(7, { vantageEquipmentId: 101 }); // d2, the other machine on the shelf
      await line(70, 7, 'black', { quantity: '2' });

      await matchSalesOrders(t.db, LATER);

      expect((await order(orderId)).status).toBe('submitted');
      expect(await proposal(topUp)).toMatchObject({ status: 'ordered', vantageSalesOrderLineId: 70, note: null });
      expect((await t.db.select().from(siteStockShelves))[0]).toMatchObject({ usedBlack: 0 });
    });

    it('a device off the shelf does not count', async () => {
      const { orderId } = await approve([{ proposalId: topUp, quantity: 2 }]);
      await so(7, { vantageEquipmentId: 102 }); // d3 is at another customer
      await line(70, 7, 'black');
      await matchSalesOrders(t.db, LATER);
      expect((await order(orderId)).status).toBe('queued');
    });

    it('a pending top-up is superseded by a line made after it, and comes off the used count', async () => {
      await so(7, { vantageEquipmentId: 101, orderDate: day('2026-09-21') });
      await line(70, 7, 'black', { quantity: '2' });

      const result = await matchSalesOrders(t.db, LATER);

      expect(result).toMatchObject({ topUpsSuperseded: 1, matched: 0 });
      expect(await proposal(topUp)).toMatchObject({ status: 'superseded', decidedAt: LATER, note: 'ordered in Vantage (SO7)', vantageSalesOrderId: 7, vantageSalesOrderLineId: 70 });
      expect((await t.db.select().from(siteStockShelves))[0]).toMatchObject({ usedBlack: 0 });
      const [row] = await audits();
      expect(row!.details).toMatchObject({ supersededTopUps: [{ proposalId: topUp, salesOrderId: 7, lineId: 70, shelfId, colour: 'black', quantity: 2 }] });
    });

    it('a pending top-up ignores a sales order from before it was raised', async () => {
      await so(7, { vantageEquipmentId: 101, orderDate: day('2026-09-20') });
      await line(70, 7, 'black');
      await matchSalesOrders(t.db, LATER);
      expect((await proposal(topUp)).status).toBe('pending');
      expect((await t.db.select().from(siteStockShelves))[0]).toMatchObject({ usedBlack: 2 });
    });

    it('an approved order gets the line before a pending top-up does', async () => {
      await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: 'd2', vantageEquipmentId: 101, colour: 'black', trigger: 'threshold', status: 'pending', createdAt: NOW });
      const [d2black] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.drmsEquipmentId, 'd2'));
      const { orderId } = await approve([{ proposalId: d2black!.id, quantity: 1 }], 'd2');
      await so(7, { vantageEquipmentId: 101 });
      await line(70, 7, 'black');
      await matchSalesOrders(t.db, LATER);
      expect((await order(orderId)).status).toBe('submitted');
      expect((await proposal(topUp)).status).toBe('pending');
    });
  });

  describe('references typed by hand', () => {
    it('links a submitted order to the sales order whose reference matches, trimmed and ignoring case', async () => {
      const { orderId } = await approveBoth();
      await markOrderOrdered(t.db, { orderId, reference: '  so2609-07 ', userId, now: NOW });
      await so(7, { reference: 'SO2609-07' });
      await line(70, 7, 'black');
      await line(71, 7, 'cyan');

      const result = await matchSalesOrders(t.db, LATER);

      expect(result).toMatchObject({ linked: 1, matched: 0 });
      expect(await order(orderId)).toMatchObject({ vantageSalesOrderId: 7, vantageReference: 'so2609-07', status: 'submitted' });
      // Its lines are claimed for its proposals, which stay as they were.
      expect(await proposal(black)).toMatchObject({ status: 'ordered', vantageSalesOrderId: 7, vantageSalesOrderLineId: 70 });
      expect(await proposal(cyan)).toMatchObject({ status: 'ordered', vantageSalesOrderId: 7, vantageSalesOrderLineId: 71 });
      expect((await audits())[0]!.details).toMatchObject({ linked: [{ orderId, salesOrderId: 7 }] });
    });

    it('a claimed line cannot close another order', async () => {
      const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
      await markOrderOrdered(t.db, { orderId, reference: 'SO7', userId, now: NOW });
      // The next black is queued; the only black line belongs to the typed order's SO.
      const [next] = await t.db
        .insert(replenishmentProposals)
        .values({ drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'black', trigger: 'threshold', status: 'pending', createdAt: NOW })
        .returning();
      const second = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: next!.id, quantity: 1 }], userId, now: NOW });
      await so(7, { reference: 'SO7' });
      await line(70, 7, 'black');

      await matchSalesOrders(t.db, LATER);

      expect((await proposal(black)).vantageSalesOrderLineId).toBe(70);
      expect((await order(second.orderId)).status).toBe('queued');
    });

    it('once linked, the order clears from the stats when the sales order completes, and order-state speaks through Vantage', async () => {
      const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
      await markOrderOrdered(t.db, { orderId, reference: 'SO7', userId, now: NOW });
      // Not pulled yet: counted open, and shown as our own order.
      expect(await getReplenishmentStats(t.db, LATER)).toMatchObject({ openMpsOrders: 1, onOrderDevices: 1 });
      expect((await getOrderStates(t.db, [100], LATER)).get(100)!.black.open).toMatchObject({ source: 'mps', reference: 'SO7' });

      await so(7, { reference: 'SO7' });
      await line(70, 7, 'black');
      await matchSalesOrders(t.db, LATER);
      // Linked and open in Vantage: still open, but the Vantage row speaks for it, not a second MPS one.
      expect(await getReplenishmentStats(t.db, LATER)).toMatchObject({ openMpsOrders: 1 });
      expect((await getOrderStates(t.db, [100], LATER)).get(100)!.black.open).toMatchObject({ source: 'vantage', reference: 'SO7' });

      await t.db.update(vantageSalesOrders).set({ completedDate: new Date('2026-09-23T10:00:00Z') }).where(eq(vantageSalesOrders.vantageId, 7));
      expect(await getReplenishmentStats(t.db, LATER)).toMatchObject({ openMpsOrders: 0, onOrderDevices: 0 });
      const black0 = (await getOrderStates(t.db, [100], LATER)).get(100)!.black;
      expect(black0.open).toBeNull();
      expect(black0.lastCompletedReference).toBe('SO7');
    });

    it('leaves a reference that matches nothing as it is: open, unlinked, with no audit row', async () => {
      const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
      await markOrderOrdered(t.db, { orderId, reference: 'SO7-typo', userId, now: NOW });
      await so(7, { reference: 'SO7' });
      await line(70, 7, 'black');

      expect(await matchSalesOrders(t.db, LATER)).toMatchObject({ linked: 0, matched: 0 });

      expect(await order(orderId)).toMatchObject({ vantageSalesOrderId: null, vantageReference: 'SO7-typo', status: 'submitted' });
      expect(await audits()).toHaveLength(0);
      expect(await getReplenishmentStats(t.db, LATER)).toMatchObject({ openMpsOrders: 1 });
    });

    it('never links to a deleted sales order', async () => {
      const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
      await markOrderOrdered(t.db, { orderId, reference: 'SO7', userId, now: NOW });
      await so(7, { reference: 'SO7', deletedDate: LATER });
      await matchSalesOrders(t.db, LATER);
      expect((await order(orderId)).vantageSalesOrderId).toBeNull();
    });
  });
});
