import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  counterSnapshots,
  counterValues,
  deviceLinks,
  drmsEquipment,
  replenishmentOrders,
  replenishmentProposals,
  users,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { countAwaitingReview, getReplenishmentStats, listDeviceReplenishment, listReplenishmentQueue } from './replenishment';
import { approveProposals, rejectProposals, resolveOrder, retryOrder } from './replenishment-actions';

const NOW = new Date('2026-09-21T12:00:00Z');

describe('replenishment queue', () => {
  let t: TestDb;
  let userId: number;
  let black: number;
  let cyan: number;
  let waste: number;

  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'd1', productName: 'Alpha MFP', modelName: 'bizhub C300i', serial: 'S1', isColour: true, customerName: 'Acme (DRMS)', raw: {} },
      { drmsId: 'd2', productName: 'Beta MFP', modelName: 'bizhub 301i', serial: 'S2', isColour: false, customerName: 'Beta (DRMS)', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 100, customerName: 'Acme', location: 'Reception', raw: {} },
      { vantageId: 101, customerName: 'Beta', raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'd1', vantageEquipmentId: 100, method: 'serial' },
      { drmsEquipmentId: 'd2', vantageEquipmentId: 101, method: 'serial' },
    ]);
    const [snap] = await t.db
      .insert(counterSnapshots)
      .values({ drmsEquipmentId: 'd1', counterId: 'c1', receivedTime: NOW, fetchedAt: NOW, raw: {} })
      .returning();
    await t.db.insert(counterValues).values([
      { snapshotId: snap!.id, name: 'BlackTonerLevel', value: 12 },
      { snapshotId: snap!.id, name: 'CyanTonerLevel', value: 4 },
    ]);
    const ps = await t.db
      .insert(replenishmentProposals)
      .values([
        { drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'pending', createdAt: NOW },
        { drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'cyan', trigger: 'threshold', level: 4, threshold: 10, status: 'pending', createdAt: NOW },
        { drmsEquipmentId: 'd2', vantageEquipmentId: 101, colour: 'waste', trigger: 'alarm', alarmId: 'a1', alarmDescription: 'TO-1 Waste toner box near full', status: 'pending', createdAt: NOW },
      ])
      .returning();
    [black, cyan, waste] = ps.map((p) => p.id) as [number, number, number];
  });
  afterEach(() => t.close());

  async function setOrderStatus(orderId: number, status: 'uncertain' | 'failed' | 'submitted', patch: { error?: string } = {}) {
    await t.db.update(replenishmentOrders).set({ status, ...patch }).where(eq(replenishmentOrders.id, orderId));
    if (status === 'failed') await t.db.update(replenishmentProposals).set({ status: 'failed' }).where(eq(replenishmentProposals.orderId, orderId));
  }

  it('approves selected proposals into one queued order with the Vantage body', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 2 }, { proposalId: black, quantity: 1 }], userId, now: NOW });
    const [o] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, orderId));
    expect(o).toMatchObject({ status: 'queued', vantageEquipmentId: 100, createdBy: userId });
    expect(o!.request).toEqual({ components: [{ Type: 1, RequestedQuantity: 1 }, { Type: 2, RequestedQuantity: 2 }] });
    const ps = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.orderId, orderId));
    expect(ps.map((p) => [p.colour, p.status, p.quantity])).toEqual(expect.arrayContaining([['black', 'approved', 1], ['cyan', 'approved', 2]]));
    expect(ps.every((p) => p.decidedBy === userId && p.decidedAt?.getTime() === NOW.getTime())).toBe(true);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toEqual([expect.objectContaining({ action: 'proposal.approve', entity: 'proposal', userId })]);
    expect(audits[0]!.details).toEqual({ orderId, items: [{ proposalId: cyan, quantity: 2 }, { proposalId: black, quantity: 1 }] });
  });

  it('uses the current link, not the equipment stored on the proposal', async () => {
    await t.db.insert(vantageEquipment).values({ vantageId: 200, raw: {} });
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW }).where(eq(deviceLinks.drmsEquipmentId, 'd1'));
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 200, method: 'manual' });
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    const [o] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, orderId));
    expect(o!.vantageEquipmentId).toBe(200);
  });

  it('refuses proposals from another device, already decided ones, and bad quantities — and writes nothing', async () => {
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: waste, quantity: 1 }], userId })).rejects.toMatchObject({ code: 'mixed_devices' });
    await rejectProposals(t.db, { proposalIds: [black], userId });
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId })).rejects.toMatchObject({ code: 'not_pending' });
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 0 }], userId })).rejects.toMatchObject({ code: 'bad_quantity' });
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 21 }], userId })).rejects.toMatchObject({ code: 'bad_quantity' });
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 1.5 }], userId })).rejects.toMatchObject({ code: 'bad_quantity' });
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [], userId })).rejects.toMatchObject({ code: 'empty' });
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: 9999, quantity: 1 }], userId })).rejects.toMatchObject({ code: 'not_found' });
    expect(await t.db.select().from(replenishmentOrders)).toEqual([]);
    const [c] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, cyan));
    expect(c).toMatchObject({ status: 'pending', orderId: null });
    // Only the one successful reject was audited.
    expect((await t.db.select().from(auditLog)).map((a) => a.action)).toEqual(['proposal.reject']);
  });

  it('refuses a device whose link has gone', async () => {
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW }).where(eq(deviceLinks.drmsEquipmentId, 'd1'));
    await expect(approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId })).rejects.toMatchObject({ code: 'unlinked' });
    expect(await t.db.select().from(replenishmentOrders)).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('rejects pending proposals with a note and one audit row, all or nothing', async () => {
    expect(await rejectProposals(t.db, { proposalIds: [black, waste], userId, note: 'customer has stock', now: NOW })).toEqual({ rejected: 2 });
    const rows = await t.db.select().from(replenishmentProposals);
    expect(rows.filter((p) => p.status === 'rejected').map((p) => [p.id, p.note, p.decidedBy])).toEqual(
      expect.arrayContaining([[black, 'customer has stock', userId], [waste, 'customer has stock', userId]]),
    );
    const audits = await t.db.select().from(auditLog);
    expect(audits).toEqual([expect.objectContaining({ action: 'proposal.reject', entity: 'proposal', entityIds: [black, waste], userId })]);
    await expect(rejectProposals(t.db, { proposalIds: [black, cyan], userId })).rejects.toMatchObject({ code: 'not_pending' });
    const [c] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, cyan));
    expect(c!.status).toBe('pending');
    await expect(rejectProposals(t.db, { proposalIds: [], userId })).rejects.toMatchObject({ code: 'empty' });
  });

  it('lists the review tab grouped by device, lowest level first, with threshold source and order context', async () => {
    await t.db.insert(vantageSalesOrders).values({ vantageId: 5, reference: 'SO5', orderDate: new Date('2026-08-01'), completedDate: new Date('2026-08-03'), vantageEquipmentId: 100, raw: {} });
    await t.db.insert(vantageSalesOrderLines).values({ vantageId: 50, salesOrderId: 5, colour: 'black', raw: {} });

    const q = await listReplenishmentQueue(t.db, { tab: 'review' });
    expect(q.map((d) => d.drmsId)).toEqual(['d1', 'd2']);
    expect(q[0]).toMatchObject({ name: 'Alpha MFP', model: 'bizhub C300i', serial: 'S1', customerName: 'Acme', location: 'Reception', vantageEquipmentId: 100, orders: [] });
    expect(q[0]!.proposals.map((p) => p.colour)).toEqual(['black', 'cyan']);
    expect(q[0]!.proposals.find((p) => p.colour === 'black')).toMatchObject({
      threshold: 15, thresholdSource: 'default', currentLevel: 12, level: 12, trigger: 'threshold', quantity: 1, status: 'pending',
      lastOrder: { reference: 'SO5', source: 'vantage', open: false }, openOrder: null,
    });
    expect(q[0]!.proposals.find((p) => p.colour === 'cyan')).toMatchObject({ threshold: 10, currentLevel: 4, lastOrder: null });
    expect(q[1]!.proposals).toEqual([
      expect.objectContaining({ colour: 'waste', trigger: 'alarm', threshold: null, thresholdSource: null, currentLevel: null, alarmDescription: 'TO-1 Waste toner box near full' }),
    ]);

    expect(await listReplenishmentQueue(t.db, { tab: 'review', limit: 1 })).toHaveLength(1);
  });

  it('falls back to the DRMS customer name for an unlinked device', async () => {
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW }).where(eq(deviceLinks.drmsEquipmentId, 'd2'));
    const q = await listReplenishmentQueue(t.db, { tab: 'review' });
    expect(q.find((d) => d.drmsId === 'd2')).toMatchObject({ customerName: 'Beta (DRMS)', location: null, vantageEquipmentId: null });
  });

  it('moves an approved device to in-progress and counts stats', async () => {
    await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    const ip = await listReplenishmentQueue(t.db, { tab: 'in-progress' });
    expect(ip.map((d) => d.drmsId)).toEqual(['d1']);
    expect(ip[0]!.orders).toEqual([expect.objectContaining({ status: 'queued', createdBy: 'op', vantageReference: null })]);
    expect(ip[0]!.proposals.map((p) => [p.colour, p.status])).toEqual([['black', 'approved']]);
    // The approved order is the open one for black now.
    expect(ip[0]!.proposals[0]!.openOrder).toMatchObject({ source: 'mps' });
    expect(await getReplenishmentStats(t.db)).toMatchObject({ awaitingReviewDevices: 2, awaitingReviewProposals: 2, onOrderDevices: 1, openMpsOrders: 1, attentionOrders: 0 });
    expect(await countAwaitingReview(t.db)).toBe(2);
  });

  it('lists the ordered and rejected tabs within their windows', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 3 }], userId, now: NOW });
    await t.db.update(replenishmentOrders).set({ status: 'submitted', submittedAt: NOW, vantageReference: 'SO77' }).where(eq(replenishmentOrders.id, orderId));
    await t.db.update(replenishmentProposals).set({ status: 'ordered' }).where(eq(replenishmentProposals.orderId, orderId));
    await rejectProposals(t.db, { proposalIds: [waste], userId, now: NOW });

    const ordered = await listReplenishmentQueue(t.db, { tab: 'ordered', now: NOW });
    expect(ordered.map((d) => d.drmsId)).toEqual(['d1']);
    expect(ordered[0]!.orders).toEqual([expect.objectContaining({ id: orderId, vantageReference: 'SO77' })]);
    expect(ordered[0]!.proposals.map((p) => [p.colour, p.status, p.quantity])).toEqual([['black', 'ordered', 3]]);
    expect(await listReplenishmentQueue(t.db, { tab: 'ordered', now: new Date(NOW.getTime() + 91 * 86_400_000) })).toEqual([]);

    const rejected = await listReplenishmentQueue(t.db, { tab: 'rejected', now: NOW });
    expect(rejected.map((d) => d.drmsId)).toEqual(['d2']);
    expect(rejected[0]!.proposals[0]).toMatchObject({ status: 'rejected', decidedBy: 'op' });
    expect(await listReplenishmentQueue(t.db, { tab: 'rejected', now: new Date(NOW.getTime() + 31 * 86_400_000) })).toEqual([]);

    // Submitted and not yet seen in Vantage: still on order. Cartridges count the quarter's orders.
    expect(await getReplenishmentStats(t.db, NOW)).toMatchObject({ onOrderDevices: 1, openMpsOrders: 1, cartridgesThisQuarter: 3 });
    expect((await getReplenishmentStats(t.db, new Date('2026-10-01T00:00:00Z'))).cartridgesThisQuarter).toBe(0);
    // Once Vantage completes it, it is no longer on order.
    await t.db.insert(vantageSalesOrders).values({ vantageId: 77, reference: 'SO77', completedDate: NOW, raw: {} });
    await t.db.update(replenishmentOrders).set({ vantageSalesOrderId: 77 }).where(eq(replenishmentOrders.id, orderId));
    expect(await getReplenishmentStats(t.db, NOW)).toMatchObject({ onOrderDevices: 0, openMpsOrders: 0, cartridgesThisQuarter: 3 });
  });

  it('resolves an uncertain order either way and retries a failed one', async () => {
    const a = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    await expect(resolveOrder(t.db, { orderId: a.orderId, outcome: 'ordered', userId })).rejects.toMatchObject({ code: 'bad_state' });
    await expect(retryOrder(t.db, { orderId: a.orderId, userId })).rejects.toMatchObject({ code: 'bad_state' });
    await expect(resolveOrder(t.db, { orderId: 9999, outcome: 'ordered', userId })).rejects.toMatchObject({ code: 'not_found' });

    await setOrderStatus(a.orderId, 'uncertain');
    expect((await getReplenishmentStats(t.db)).attentionOrders).toBe(1);
    await resolveOrder(t.db, { orderId: a.orderId, outcome: 'ordered', reference: ' SO123 ', userId, now: NOW });
    const [oa] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, a.orderId));
    expect(oa).toMatchObject({ status: 'submitted', vantageReference: 'SO123', resolvedBy: userId, resolvedAt: NOW, submittedAt: NOW });
    const [pa] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, black));
    expect(pa!.status).toBe('ordered');

    const b = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 1 }], userId });
    await setOrderStatus(b.orderId, 'uncertain');
    await resolveOrder(t.db, { orderId: b.orderId, outcome: 'failed', userId, now: NOW });
    const [ob] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, b.orderId));
    expect(ob).toMatchObject({ status: 'failed', resolvedBy: userId });
    const [pb] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, cyan));
    expect(pb!.status).toBe('failed');
    expect((await listReplenishmentQueue(t.db, { tab: 'in-progress' })).map((d) => d.orders.map((o) => o.status))).toEqual([['failed']]);

    await retryOrder(t.db, { orderId: b.orderId, userId, now: NOW });
    const [ob2] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, b.orderId));
    expect(ob2).toMatchObject({ status: 'queued', error: null });
    const [pb2] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, cyan));
    expect(pb2!.status).toBe('approved');
    await expect(retryOrder(t.db, { orderId: b.orderId, userId })).rejects.toMatchObject({ code: 'bad_state' });

    const audits = await t.db.select().from(auditLog);
    expect(audits.map((x) => x.action)).toEqual(['proposal.approve', 'order.resolve', 'proposal.approve', 'order.resolve', 'order.retry']);
    expect(audits[1]).toMatchObject({ entity: 'order', entityIds: [a.orderId], details: { outcome: 'ordered', reference: 'SO123' } });
  });

  it('will not retry over a newer live proposal for the same colour', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 1 }], userId });
    await setOrderStatus(orderId, 'failed', { error: 'Vantage said no' });
    // The engine does not treat a failed proposal as live, so it may propose the colour again.
    await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: 'd1', colour: 'cyan', trigger: 'threshold', level: 4, threshold: 10, status: 'pending' });
    await expect(retryOrder(t.db, { orderId, userId })).rejects.toMatchObject({ code: 'bad_state' });
    const [o] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, orderId));
    expect(o).toMatchObject({ status: 'failed', error: 'Vantage said no' });
  });

  it('lists a device page: live proposals and its orders', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    const r = await listDeviceReplenishment(t.db, 'd1');
    expect(r.proposals.map((p) => [p.colour, p.status])).toEqual([['black', 'approved'], ['cyan', 'pending']]);
    expect(r.orders.map((o) => o.id)).toEqual([orderId]);
    expect(await listDeviceReplenishment(t.db, 'nope')).toEqual({ proposals: [], orders: [] });
  });
});
