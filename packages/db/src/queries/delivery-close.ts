import { deliveryColour } from '@mps/core';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLog, deviceAlarms, replenishmentOrders, replenishmentProposals } from '../schema';
import { londonDay } from './pm-due';
import { salesOrderLinkOf } from './replenishment-actions';
import { deliveryAlarmSql } from './shared';

/**
 * Closes in-progress orders that a Toner Delivery alarm shows were fitted. A Delivery for the device
 * and colour received at or after the order was approved means the cartridge is in, so the order comes
 * off the list the way `matchSalesOrders` closes one against a Vantage sales order: its `approved`
 * proposals become `ordered` (note "closed by Toner Delivery alarm <date>"), and an order with none
 * left `approved` becomes `submitted`. Pending proposals are never touched, and neither are site-stock
 * top-ups: a top-up restocks the shelf, it is not the cartridge that went into the machine.
 * Writes one `audit_log` row (no user) when it did anything.
 */
export async function closeOrdersByDelivery(db: Db, now: Date = new Date()): Promise<{ closed: number; completed: number }> {
  return db.transaction(async (tx) => {
    const p = replenishmentProposals;
    const o = replenishmentOrders;
    const open = await tx
      .select({ id: p.id, orderId: p.orderId, drmsId: p.drmsEquipmentId, colour: p.colour, note: p.note, approvedAt: o.createdAt })
      .from(p)
      .innerJoin(o, eq(o.id, p.orderId))
      .where(and(eq(p.status, 'approved'), eq(o.status, 'queued'), sql`${p.shelfId} is null`))
      .orderBy(o.createdAt, p.id);
    if (open.length === 0) return { closed: 0, completed: 0 };

    const floor = open.reduce((m, r) => (r.approvedAt < m ? r.approvedAt : m), open[0]!.approvedAt);
    const alarms = await tx
      .select({ drmsId: deviceAlarms.drmsEquipmentId, at: deviceAlarms.receivedTime, description: deviceAlarms.description })
      .from(deviceAlarms)
      .where(
        and(
          inArray(deviceAlarms.drmsEquipmentId, [...new Set(open.map((r) => r.drmsId))]),
          gte(deviceAlarms.receivedTime, floor),
          deliveryAlarmSql(),
        ),
      )
      .orderBy(deviceAlarms.receivedTime);

    const closed: { proposalId: number; orderId: number; deliveryAt: Date }[] = [];
    for (const r of open) {
      const hit = alarms.find((a) => a.drmsId === r.drmsId && deliveryColour(a.description) === r.colour && a.at >= r.approvedAt);
      if (!hit) continue;
      const note = `closed by Toner Delivery alarm ${londonDay(hit.at)}`;
      const done = await tx
        .update(p)
        .set({ status: 'ordered', note: r.note ? `${r.note}; ${note}` : note })
        .where(and(eq(p.id, r.id), eq(p.status, 'approved')))
        .returning({ id: p.id });
      if (done.length === 0) continue; // decided by hand since we read it
      closed.push({ proposalId: r.id, orderId: r.orderId!, deliveryAt: hit.at });
    }

    const completedOrders: number[] = [];
    for (const orderId of new Set(closed.map((c) => c.orderId))) {
      // Lock the order row first, so a proposal being approved or decided by hand at the same moment cannot slip
      // between this check and the status change below.
      await tx.select({ id: o.id }).from(o).where(eq(o.id, orderId)).for('update');
      const [left] = await tx.select({ id: p.id }).from(p).where(and(eq(p.orderId, orderId), eq(p.status, 'approved'))).limit(1);
      if (left) continue;
      const link = await salesOrderLinkOf(tx, orderId);
      const done = await tx
        .update(o)
        .set({ status: 'submitted', submittedAt: now, resolvedAt: now, ...link })
        .where(and(eq(o.id, orderId), eq(o.status, 'queued')))
        .returning({ id: o.id });
      if (done.length > 0) completedOrders.push(orderId);
    }

    if (closed.length > 0) {
      await tx.insert(auditLog).values({
        at: now,
        userId: null,
        action: 'order.delivery_close',
        entity: 'order',
        entityIds: [...new Set(closed.map((c) => c.orderId))].sort((a, b) => a - b),
        details: { closed, completedOrders },
      });
    }
    return { closed: closed.length, completed: completedOrders.length };
  });
}
