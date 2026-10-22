import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  cartridgeFamilies,
  cartridgeFamilyModels,
  counterSnapshots,
  counterValues,
  deviceLinks,
  drmsEquipment,
  replenishmentOrders,
  replenishmentProposals,
  siteStockShelves,
  users,
  vantageCustomers,
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
      { drmsId: 'd1', productName: 'Alpha MFP', modelName: 'bizhub C300i', serial: 'S1', isColour: true, customerName: 'Acme (DRMS)', raw: { Name: 'Acme Upstairs C300i' } },
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
    // DRMS's equipment Name when it says more than the model, else customer + model.
    expect(q.map((d) => d.displayName)).toEqual(['Acme Upstairs C300i', 'Beta bizhub 301i']);
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

  it('gives each device its colour flag and every latest toner level, proposed or not', async () => {
    const q = await listReplenishmentQueue(t.db, { tab: 'review' });
    expect(q.find((d) => d.drmsId === 'd1')).toMatchObject({
      isColour: true,
      tonerLevels: { black: 12, cyan: 4, magenta: null, yellow: null },
    });
    // A mono device with no snapshot: no readings at all.
    expect(q.find((d) => d.drmsId === 'd2')).toMatchObject({
      isColour: false,
      tonerLevels: { black: null, cyan: null, magenta: null, yellow: null },
    });

    // A mono device's stray colour level is dropped by the shared pivot.
    const [snap] = await t.db
      .insert(counterSnapshots)
      .values({ drmsEquipmentId: 'd2', counterId: 'c2', receivedTime: NOW, fetchedAt: NOW, raw: {} })
      .returning();
    await t.db.insert(counterValues).values([
      { snapshotId: snap!.id, name: 'BlackTonerLevel', value: 55 },
      { snapshotId: snap!.id, name: 'CyanTonerLevel', value: 0 },
    ]);
    const again = await listReplenishmentQueue(t.db, { tab: 'review' });
    expect(again.find((d) => d.drmsId === 'd2')!.tonerLevels).toEqual({ black: 55, cyan: null, magenta: null, yellow: null });
  });

  it('falls back to the DRMS customer name for an unlinked device', async () => {
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW }).where(eq(deviceLinks.drmsEquipmentId, 'd2'));
    const q = await listReplenishmentQueue(t.db, { tab: 'review' });
    expect(q.find((d) => d.drmsId === 'd2')).toMatchObject({ customerName: 'Beta (DRMS)', location: null, vantageEquipmentId: null });
  });

  it('moves an approved device to in-progress and counts stats', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    const ip = await listReplenishmentQueue(t.db, { tab: 'in-progress' });
    expect(ip.map((d) => d.drmsId)).toEqual(['d1']);
    expect(ip[0]!.orders).toEqual([expect.objectContaining({ status: 'queued', createdBy: 'op', vantageReference: null })]);
    expect(ip[0]!.proposals.map((p) => [p.colour, p.status, p.orderId])).toEqual([['black', 'approved', orderId]]);
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
    await expect(resolveOrder(t.db, { orderId: a.orderId, outcome: 'ordered', reference: 'SO1', userId })).rejects.toMatchObject({ code: 'bad_state' });
    await expect(retryOrder(t.db, { orderId: a.orderId, userId })).rejects.toMatchObject({ code: 'bad_state' });
    await expect(resolveOrder(t.db, { orderId: 9999, outcome: 'ordered', reference: 'SO1', userId })).rejects.toMatchObject({ code: 'not_found' });

    await setOrderStatus(a.orderId, 'uncertain');
    expect((await getReplenishmentStats(t.db)).attentionOrders).toBe(1);
    // Marking it ordered needs the reference the operator found in Vantage.
    await expect(resolveOrder(t.db, { orderId: a.orderId, outcome: 'ordered', userId })).rejects.toMatchObject({ code: 'bad_state' });
    await expect(resolveOrder(t.db, { orderId: a.orderId, outcome: 'ordered', reference: '   ', userId })).rejects.toMatchObject({ code: 'bad_state' });
    expect((await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, a.orderId)))[0]!.status).toBe('uncertain');
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

  it('rejects a failed order\'s proposals, which takes the order out of in-progress and attention', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }, { proposalId: cyan, quantity: 1 }], userId, now: NOW });
    await setOrderStatus(orderId, 'failed', { error: 'Vantage said no' });
    expect((await getReplenishmentStats(t.db, NOW)).attentionOrders).toBe(1);

    // One of two rejected: the order still has a failed proposal, so it still needs a person.
    await rejectProposals(t.db, { proposalIds: [black], userId, now: NOW });
    expect((await listReplenishmentQueue(t.db, { tab: 'in-progress', now: NOW })).map((d) => d.drmsId)).toEqual(['d1']);
    expect((await getReplenishmentStats(t.db, NOW)).attentionOrders).toBe(1);

    expect(await rejectProposals(t.db, { proposalIds: [cyan], userId, note: 'not wanted', now: NOW })).toEqual({ rejected: 1 });
    const ps = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.orderId, orderId));
    expect(ps.map((p) => p.status)).toEqual(['rejected', 'rejected']);
    const [o] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, orderId));
    expect(o!.status).toBe('failed');
    expect(await listReplenishmentQueue(t.db, { tab: 'in-progress', now: NOW })).toEqual([]);
    expect((await getReplenishmentStats(t.db, NOW)).attentionOrders).toBe(0);
    const rejected = await listReplenishmentQueue(t.db, { tab: 'rejected', now: NOW });
    expect(rejected.find((d) => d.drmsId === 'd1')!.proposals.map((p) => [p.colour, p.status])).toEqual([['black', 'rejected'], ['cyan', 'rejected']]);
    await expect(retryOrder(t.db, { orderId, userId })).rejects.toMatchObject({ code: 'bad_state' });

    // Already rejected: not rejectable again.
    await expect(rejectProposals(t.db, { proposalIds: [cyan], userId })).rejects.toMatchObject({ code: 'not_pending' });
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(['proposal.approve', 'proposal.reject', 'proposal.reject']);
  });

  it('retries only the colours still failed, rebuilding the request body', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 2 }, { proposalId: cyan, quantity: 3 }], userId });
    await setOrderStatus(orderId, 'failed', { error: 'Vantage said no' });
    await rejectProposals(t.db, { proposalIds: [black], userId });
    await retryOrder(t.db, { orderId, userId });
    const [o] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, orderId));
    expect(o).toMatchObject({ status: 'queued', error: null });
    expect(o!.request).toEqual({ components: [{ Type: 2, RequestedQuantity: 3 }] });
    const ps = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.orderId, orderId));
    expect(Object.fromEntries(ps.map((p) => [p.colour, p.status]))).toEqual({ black: 'rejected', cyan: 'approved' });
  });

  it('will not reject an approved proposal', async () => {
    await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    await expect(rejectProposals(t.db, { proposalIds: [black], userId })).rejects.toMatchObject({ code: 'not_pending' });
  });

  it('lists a device page: live proposals and its orders', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    const r = await listDeviceReplenishment(t.db, 'd1');
    expect(r.proposals.map((p) => [p.colour, p.status])).toEqual([['black', 'approved'], ['cyan', 'pending']]);
    expect(r.orders.map((o) => o.id)).toEqual([orderId]);
    expect(await listDeviceReplenishment(t.db, 'nope')).toEqual({ proposals: [], orders: [] });
  });
});

describe('site stock top-ups adjust shelf counts', () => {
  let t: TestDb;
  let userId: number;
  let shelfId: number;
  let black: number;
  let cyan: number;

  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(drmsEquipment).values({ drmsId: 'd1', modelName: 'bizhub C300i', serial: 'S1', isColour: true, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 100, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 100, method: 'serial' });
    const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'C-series', isColour: true }).returning();
    const [shelf] = await t.db
      .insert(siteStockShelves)
      .values({ vantageCustomerId: 1, familyId: fam!.id, usedBlack: 3, usedCyan: 2, countingFrom: NOW })
      .returning();
    shelfId = shelf!.id;
    const ps = await t.db
      .insert(replenishmentProposals)
      .values(
        (['black', 'cyan'] as const).map((colour, i) => ({
          drmsEquipmentId: 'd1',
          vantageEquipmentId: 100,
          colour,
          trigger: 'site_stock' as const,
          status: 'pending' as const,
          quantity: [3, 2][i]!,
          shelfId,
          createdAt: NOW,
        })),
      )
      .returning();
    [black, cyan] = ps.map((p) => p.id) as [number, number];
  });
  afterEach(() => t.close());

  const shelf = async () => (await t.db.select().from(siteStockShelves).where(eq(siteStockShelves.id, shelfId)))[0]!;

  it('shows the shelf on a top-up device in the review queue, and none on a normal one', async () => {
    await t.db.insert(vantageCustomers).values({ vantageId: 1, name: 'Site One', raw: {} });
    await t.db.update(drmsEquipment).set({ status: 'REGISTERED' });
    await t.db.update(vantageEquipment).set({ vantageCustomerId: 1 });
    await t.db.insert(cartridgeFamilyModels).values({ familyId: (await t.db.select().from(cartridgeFamilies))[0]!.id, model: 'bizhub C300i' });
    await t.db.insert(drmsEquipment).values({ drmsId: 'd2', modelName: 'bizhub 301i', serial: 'S2', isColour: false, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 101, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd2', vantageEquipmentId: 101, method: 'serial' });
    await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: 'd2', vantageEquipmentId: 101, colour: 'black', trigger: 'threshold', status: 'pending', createdAt: NOW });

    const devices = await listReplenishmentQueue(t.db, { tab: 'review', now: NOW });
    const topUp = devices.find((d) => d.drmsId === 'd1')!;
    const normal = devices.find((d) => d.drmsId === 'd2')!;
    expect(topUp.shelf).toEqual({ id: shelfId, siteName: 'Site One', familyName: 'C-series', machines: 1 });
    expect(topUp.proposals.map((p) => p.shelfId)).toEqual([shelfId, shelfId]);
    expect(normal.shelf).toBeNull();
    expect(normal.proposals[0]!.shelfId).toBeNull();
  });

  it('approving a top-up subtracts approved quantities', async () => {
    // A cyan use was counted after the proposal was raised: used cyan is now 3.
    await t.db.update(siteStockShelves).set({ usedCyan: 3 }).where(eq(siteStockShelves.id, shelfId));
    await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 3 }, { proposalId: cyan, quantity: 1 }], userId, now: NOW });
    expect(await shelf()).toMatchObject({ usedBlack: 0, usedCyan: 2 });
    const [a] = await t.db.select().from(auditLog);
    expect(a!.details).toMatchObject({
      shelfAdjust: expect.arrayContaining([
        { shelfId, colour: 'black', by: 3 },
        { shelfId, colour: 'cyan', by: 1 },
      ]),
    });
  });

  it('approving a smaller quantity leaves the remainder, and never goes below zero', async () => {
    await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId });
    expect(await shelf()).toMatchObject({ usedBlack: 2, usedCyan: 2 });
    await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: cyan, quantity: 5 }], userId });
    expect((await shelf()).usedCyan).toBe(0);
  });

  it('rejecting a pending top-up leaves counts', async () => {
    await rejectProposals(t.db, { proposalIds: [black, cyan], userId, now: NOW });
    expect(await shelf()).toMatchObject({ usedBlack: 3, usedCyan: 2 });
    const [a] = await t.db.select().from(auditLog);
    expect(a!.details).not.toHaveProperty('shelfAdjust');
  });

  it('rejecting a failed top-up restores counts', async () => {
    const { orderId } = await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 3 }, { proposalId: cyan, quantity: 2 }], userId, now: NOW });
    expect(await shelf()).toMatchObject({ usedBlack: 0, usedCyan: 0 });
    await t.db.update(replenishmentOrders).set({ status: 'failed' }).where(eq(replenishmentOrders.id, orderId));
    await t.db.update(replenishmentProposals).set({ status: 'failed' }).where(eq(replenishmentProposals.orderId, orderId));
    await rejectProposals(t.db, { proposalIds: [black], userId, now: NOW });
    expect(await shelf()).toMatchObject({ usedBlack: 3, usedCyan: 0 });
    const audits = await t.db.select().from(auditLog);
    expect(audits.at(-1)!.details).toMatchObject({ shelfAdjust: [{ shelfId, colour: 'black', by: 3 }] });
  });
});
