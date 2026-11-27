import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, deviceAlarms, deviceLinks, drmsEquipment, replenishmentOrders, replenishmentProposals, users, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { closeOrdersByDelivery } from './delivery-close';
import { approveProposals } from './replenishment-actions';

const APPROVED = new Date('2026-11-20T12:00:00Z');
const NOW = new Date('2026-11-27T12:00:00Z');

describe('closeOrdersByDelivery', () => {
  let t: TestDb;
  let userId: number;
  let black: number;
  let cyan: number;
  let seq = 0;

  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(drmsEquipment).values([{ drmsId: 'd1', modelName: 'bizhub C300i', serial: 'S1', isColour: true, raw: {} }]);
    await t.db.insert(vantageEquipment).values([{ vantageId: 100, raw: {} }]);
    await t.db.insert(deviceLinks).values([{ drmsEquipmentId: 'd1', vantageEquipmentId: 100, method: 'serial' }]);
    const ps = await t.db
      .insert(replenishmentProposals)
      .values([
        { drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'pending', createdAt: APPROVED },
        { drmsEquipmentId: 'd1', vantageEquipmentId: 100, colour: 'cyan', trigger: 'threshold', level: 4, threshold: 10, status: 'pending', createdAt: APPROVED },
      ])
      .returning();
    [black, cyan] = ps.map((p) => p.id) as [number, number];
  });
  afterEach(() => t.close());

  const delivery = (at: string, description = 'Toner Delivery(K)', status = 'EquipmentDiscovered') =>
    t.db.insert(deviceAlarms).values({ alarmId: `x${++seq}`, drmsEquipmentId: 'd1', receivedTime: new Date(at), description, status, category: 'toner', raw: {} });
  const approve = (items: { proposalId: number; quantity: number }[]) => approveProposals(t.db, { drmsId: 'd1', items, userId, now: APPROVED });
  const proposal = async (id: number) => (await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, id)))[0]!;
  const order = async (id: number) => (await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, id)))[0]!;

  it('closes an in-progress order when a Delivery for its colour arrives after approval', async () => {
    const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
    await delivery('2026-11-24T10:00:00Z'); // any DRMS status
    expect(await closeOrdersByDelivery(t.db, NOW)).toEqual({ closed: 1, completed: 1 });
    expect(await proposal(black)).toMatchObject({ status: 'ordered', note: 'closed by Toner Delivery alarm 2026-11-24' });
    expect(await order(orderId)).toMatchObject({ status: 'submitted', submittedAt: NOW, resolvedAt: NOW });
    expect((await t.db.select().from(auditLog)).filter((a) => a.action === 'order.delivery_close')).toHaveLength(1);
  });

  it('dates the note by the London day, not the UTC day', async () => {
    await approveProposals(t.db, { drmsId: 'd1', items: [{ proposalId: black, quantity: 1 }], userId, now: new Date('2026-06-30T12:00:00Z') });
    await delivery('2026-06-30T23:30:00Z'); // 00:30 on 1 July in London (BST)
    await closeOrdersByDelivery(t.db, NOW);
    expect(await proposal(black)).toMatchObject({ note: 'closed by Toner Delivery alarm 2026-07-01' });
  });

  it('ignores a Delivery before the approval, for another colour, or that is not a Delivery', async () => {
    const { orderId } = await approve([{ proposalId: black, quantity: 1 }]);
    await delivery('2026-11-19T10:00:00Z');
    await delivery('2026-11-24T10:00:00Z', 'Toner Delivery(C)');
    await delivery('2026-11-24T10:00:00Z', 'Toner Empty(K)');
    expect(await closeOrdersByDelivery(t.db, NOW)).toEqual({ closed: 0, completed: 0 });
    expect(await proposal(black)).toMatchObject({ status: 'approved' });
    expect((await order(orderId)).status).toBe('queued');
  });

  it('closes only the delivered colour of a two-colour order and leaves the order in progress', async () => {
    const { orderId } = await approve([
      { proposalId: black, quantity: 1 },
      { proposalId: cyan, quantity: 1 },
    ]);
    await delivery('2026-11-24T10:00:00Z');
    expect(await closeOrdersByDelivery(t.db, NOW)).toEqual({ closed: 1, completed: 0 });
    expect((await proposal(black)).status).toBe('ordered');
    expect((await proposal(cyan)).status).toBe('approved');
    expect((await order(orderId)).status).toBe('queued');
  });

  it('never touches a pending Review proposal', async () => {
    await delivery('2026-11-24T10:00:00Z');
    expect(await closeOrdersByDelivery(t.db, NOW)).toEqual({ closed: 0, completed: 0 });
    expect((await proposal(black)).status).toBe('pending');
    expect((await proposal(cyan)).status).toBe('pending');
  });

  it('is idempotent', async () => {
    await approve([{ proposalId: black, quantity: 1 }]);
    await delivery('2026-11-24T10:00:00Z');
    await closeOrdersByDelivery(t.db, NOW);
    expect(await closeOrdersByDelivery(t.db, NOW)).toEqual({ closed: 0, completed: 0 });
  });
});
