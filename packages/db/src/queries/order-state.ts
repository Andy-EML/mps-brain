import { COMPLETED_SUPPRESS_DAYS, REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { replenishmentOrders, replenishmentProposals, vantageSalesOrderLines, vantageSalesOrders } from '../schema';

export interface OrderRef {
  reference: string | null;
  orderDate: Date | null;
  source: 'vantage' | 'mps';
}

export interface ColourOrderState {
  /** The newest open order for this colour, if any. */
  open: OrderRef | null;
  lastCompletedAt: Date | null;
  /** The newest order of this colour, open or not. */
  last: (OrderRef & { open: boolean }) | null;
}

const emptyState = (): Record<ReplenishColour, ColourOrderState> =>
  Object.fromEntries(REPLENISH_COLOURS.map((c) => [c, { open: null, lastCompletedAt: null, last: null }])) as Record<
    ReplenishColour,
    ColourOrderState
  >;

/**
 * Per Vantage equipment and colour: is an order open, when did one last complete, and what was the
 * last order. Feeds the engine's duplicate suppression and the review queue's context column.
 * Two queries in total, whatever the number of ids.
 */
export async function getOrderStates(
  db: Db,
  vantageEquipmentIds: number[],
  now: Date = new Date(),
): Promise<Map<number, Record<ReplenishColour, ColourOrderState>>> {
  const out = new Map<number, Record<ReplenishColour, ColourOrderState>>();
  for (const id of vantageEquipmentIds) out.set(id, emptyState());
  if (vantageEquipmentIds.length === 0) return out;

  const equipment = sql<number>`coalesce(${vantageSalesOrderLines.vantageEquipmentId}, ${vantageSalesOrders.vantageEquipmentId})`;
  const lines = await db
    .select({
      equipmentId: equipment,
      colour: vantageSalesOrderLines.colour,
      reference: vantageSalesOrders.reference,
      orderDate: vantageSalesOrders.orderDate,
      completedDate: vantageSalesOrders.completedDate,
    })
    .from(vantageSalesOrderLines)
    .innerJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, vantageSalesOrderLines.salesOrderId))
    .where(
      and(
        isNull(vantageSalesOrders.deletedDate),
        isNull(vantageSalesOrderLines.returnedDate),
        inArray(vantageSalesOrderLines.colour, [...REPLENISH_COLOURS]),
        sql`${equipment} in (${sql.join(vantageEquipmentIds.map((id) => sql`${id}`), sql`, `)})`,
      ),
    )
    .orderBy(desc(vantageSalesOrders.orderDate), desc(vantageSalesOrders.vantageId));

  for (const l of lines) {
    const state = out.get(Number(l.equipmentId))?.[l.colour as ReplenishColour];
    if (!state) continue;
    const open = l.completedDate === null;
    const ref: OrderRef = { reference: l.reference, orderDate: l.orderDate, source: 'vantage' };
    state.last ??= { ...ref, open };
    if (open) state.open ??= ref;
    else if (!state.lastCompletedAt || (l.completedDate && l.completedDate > state.lastCompletedAt)) {
      state.lastCompletedAt = l.completedDate;
    }
  }

  const windowStart = new Date(now.getTime() - COMPLETED_SUPPRESS_DAYS * 86_400_000);
  const ours = await db
    .select({
      equipmentId: replenishmentOrders.vantageEquipmentId,
      status: replenishmentOrders.status,
      reference: replenishmentOrders.vantageReference,
      createdAt: replenishmentOrders.createdAt,
      submittedAt: replenishmentOrders.submittedAt,
      pulled: vantageSalesOrders.vantageId,
      colour: replenishmentProposals.colour,
    })
    .from(replenishmentOrders)
    .innerJoin(replenishmentProposals, eq(replenishmentProposals.orderId, replenishmentOrders.id))
    .leftJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, replenishmentOrders.vantageSalesOrderId))
    .where(
      and(
        inArray(replenishmentOrders.vantageEquipmentId, vantageEquipmentIds),
        inArray(replenishmentOrders.status, ['queued', 'submitting', 'uncertain', 'submitted']),
      ),
    );

  for (const o of ours) {
    if (o.pulled !== null) continue; // the Vantage rows above already speak for it
    if (o.status === 'submitted' && (!o.submittedAt || o.submittedAt < windowStart)) continue;
    const state = out.get(o.equipmentId)?.[o.colour];
    if (!state) continue;
    const ref: OrderRef = { reference: o.reference, orderDate: o.submittedAt ?? o.createdAt, source: 'mps' };
    state.open ??= ref;
    state.last ??= { ...ref, open: true };
  }
  return out;
}
