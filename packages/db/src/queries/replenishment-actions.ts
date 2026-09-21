import { CONSUMABLE_TYPE, REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLog, deviceLinks, replenishmentOrders, replenishmentProposals } from '../schema';

/**
 * The toner-order queue's decisions: approve proposals into a queued Vantage order, reject them,
 * settle an `uncertain` order by hand, retry a `failed` one. Each is one transaction with one
 * `audit_log` row, and every state change is a guarded update (`where status = <expected>`) so two
 * operators on stale pages cannot both act on the same row — the loser gets a `ReplenishmentError`
 * and nothing is written.
 *
 * None of these call Vantage. Approval only queues the order; the `vantage-order-submit` job sends
 * it. `userId` is always supplied by the caller, from the session, never from the form.
 */

export type ReplenishmentErrorCode = 'not_pending' | 'mixed_devices' | 'unlinked' | 'bad_quantity' | 'not_found' | 'bad_state' | 'empty';

/** Anything an operator can run into from the UI; always safe to show them. */
export class ReplenishmentError extends Error {
  constructor(
    message: string,
    readonly code: ReplenishmentErrorCode,
  ) {
    super(message);
    this.name = 'ReplenishmentError';
  }
}

export const MAX_ORDER_QUANTITY = 20;

const STALE = 'Some of these have already been decided — refresh the page and try again.';

/** The `CreateConsumableOrder` body for these cartridges, components in K, C, M, Y, waste order. */
function orderRequest(lines: { colour: ReplenishColour; quantity: number }[]) {
  const components = [...lines]
    .sort((a, b) => REPLENISH_COLOURS.indexOf(a.colour) - REPLENISH_COLOURS.indexOf(b.colour))
    .map((l) => ({ Type: CONSUMABLE_TYPE[l.colour], RequestedQuantity: l.quantity }));
  return { components };
}

export interface ApproveItem {
  proposalId: number;
  quantity: number;
}

/**
 * Turns one device's pending proposals into a single `queued` order whose `request` is exactly the
 * `CreateConsumableOrder` body, components in K, C, M, Y, waste order. The order goes to the
 * device's **current** link, not the equipment recorded when the proposal was raised.
 */
export async function approveProposals(
  db: Db,
  args: { drmsId: string; items: ApproveItem[]; userId: number; now?: Date },
): Promise<{ orderId: number }> {
  const now = args.now ?? new Date();
  const { items } = args;
  if (items.length === 0) throw new ReplenishmentError('Select at least one cartridge to order.', 'empty');
  for (const i of items) {
    if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > MAX_ORDER_QUANTITY) {
      throw new ReplenishmentError(`A quantity is a whole number from 1 to ${MAX_ORDER_QUANTITY}.`, 'bad_quantity');
    }
  }
  const ids = items.map((i) => i.proposalId);
  if (new Set(ids).size !== ids.length) {
    throw new ReplenishmentError('Each cartridge can appear only once, with one quantity.', 'bad_quantity');
  }

  return db.transaction(async (tx) => {
    const p = replenishmentProposals;
    const rows = await tx.select({ id: p.id, drmsId: p.drmsEquipmentId, colour: p.colour, status: p.status }).from(p).where(inArray(p.id, ids));
    if (rows.length !== ids.length) throw new ReplenishmentError('A proposal no longer exists — refresh the page.', 'not_found');
    if (rows.some((r) => r.drmsId !== args.drmsId)) {
      throw new ReplenishmentError('An order is for one device; these proposals belong to more than one.', 'mixed_devices');
    }
    if (rows.some((r) => r.status !== 'pending')) throw new ReplenishmentError(STALE, 'not_pending');

    const [link] = await tx
      .select({ vantageEquipmentId: deviceLinks.vantageEquipmentId })
      .from(deviceLinks)
      .where(and(eq(deviceLinks.drmsEquipmentId, args.drmsId), isNull(deviceLinks.unlinkedAt)));
    if (!link) throw new ReplenishmentError('This device is no longer linked to Vantage equipment, so it cannot be ordered for.', 'unlinked');

    const colourOf = new Map(rows.map((r) => [r.id, r.colour]));
    const request = orderRequest(items.map((i) => ({ colour: colourOf.get(i.proposalId)!, quantity: i.quantity })));

    const [order] = await tx
      .insert(replenishmentOrders)
      .values({
        drmsEquipmentId: args.drmsId,
        vantageEquipmentId: link.vantageEquipmentId,
        status: 'queued',
        request,
        createdBy: args.userId,
        createdAt: now,
      })
      .returning({ id: replenishmentOrders.id });
    const orderId = order!.id;

    let updated = 0;
    for (const i of items) {
      const done = await tx
        .update(p)
        .set({ status: 'approved', quantity: i.quantity, orderId, decidedBy: args.userId, decidedAt: now })
        .where(and(eq(p.id, i.proposalId), eq(p.status, 'pending')))
        .returning({ id: p.id });
      updated += done.length;
    }
    // Someone else decided one between our read and our write: throwing rolls the order back too.
    if (updated !== items.length) throw new ReplenishmentError(STALE, 'not_pending');

    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'proposal.approve',
      entity: 'proposal',
      entityIds: ids,
      details: { orderId, items },
    });
    return { orderId };
  });
}

/**
 * Says no to proposals (any devices), all or nothing. Accepts `pending` ones and `failed` ones —
 * Vantage refused the order and the operator does not want it retried; the order row stays
 * `failed` as history. Suppresses re-proposing for a while.
 */
export async function rejectProposals(
  db: Db,
  args: { proposalIds: number[]; userId: number; note?: string; now?: Date },
): Promise<{ rejected: number }> {
  const now = args.now ?? new Date();
  const ids = [...new Set(args.proposalIds)];
  if (ids.length === 0) throw new ReplenishmentError('Select at least one proposal to reject.', 'empty');
  const note = args.note?.trim() || null;

  return db.transaction(async (tx) => {
    const p = replenishmentProposals;
    const done = await tx
      .update(p)
      .set({ status: 'rejected', decidedBy: args.userId, decidedAt: now, note })
      .where(and(inArray(p.id, ids), inArray(p.status, ['pending', 'failed'])))
      .returning({ id: p.id });
    if (done.length !== ids.length) throw new ReplenishmentError(STALE, 'not_pending');
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'proposal.reject',
      entity: 'proposal',
      entityIds: ids,
      details: { note },
    });
    return { rejected: done.length };
  });
}

async function loadOrder(tx: Pick<Db, 'select'>, orderId: number) {
  const o = replenishmentOrders;
  const [row] = await tx
    .select({ id: o.id, status: o.status, drmsId: o.drmsEquipmentId, vantageReference: o.vantageReference, error: o.error, submittedAt: o.submittedAt })
    .from(o)
    .where(eq(o.id, orderId));
  if (!row) throw new ReplenishmentError('That order no longer exists — refresh the page.', 'not_found');
  return row;
}

/**
 * Settles an `uncertain` order (the POST timed out or got a 5xx, so it may or may not exist in
 * Vantage) after a person has checked Vantage. `ordered` → `submitted` with the reference they
 * found and its proposals `ordered`; `failed` → `failed` and its proposals `failed`, which the
 * operator can then retry.
 */
export async function resolveOrder(
  db: Db,
  args: { orderId: number; outcome: 'ordered' | 'failed'; reference?: string; userId: number; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const reference = args.reference?.trim() || null;
  // The operator has just found the order in Vantage, so they can say which one it is.
  if (args.outcome === 'ordered' && !reference) {
    throw new ReplenishmentError('Enter the Vantage order reference you found for this order.', 'bad_state');
  }
  await db.transaction(async (tx) => {
    const order = await loadOrder(tx, args.orderId);
    if (order.status !== 'uncertain') throw new ReplenishmentError('Only an order whose outcome is unknown can be resolved.', 'bad_state');

    const o = replenishmentOrders;
    const ordered = args.outcome === 'ordered';
    const done = await tx
      .update(o)
      .set(
        ordered
          ? { status: 'submitted', vantageReference: reference, submittedAt: order.submittedAt ?? now, resolvedBy: args.userId, resolvedAt: now }
          : { status: 'failed', error: order.error ?? 'Marked as not placed in Vantage by an operator.', resolvedBy: args.userId, resolvedAt: now },
      )
      .where(and(eq(o.id, args.orderId), eq(o.status, 'uncertain')))
      .returning({ id: o.id });
    if (done.length === 0) throw new ReplenishmentError(STALE, 'bad_state');

    await tx
      .update(replenishmentProposals)
      .set({ status: ordered ? 'ordered' : 'failed' })
      .where(and(eq(replenishmentProposals.orderId, args.orderId), eq(replenishmentProposals.status, 'approved')));
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'order.resolve',
      entity: 'order',
      entityIds: [args.orderId],
      details: { outcome: args.outcome, reference },
    });
  });
}

/**
 * Puts a `failed` order back in the queue; the submit job sends it again. The request body is
 * rebuilt from the proposals still `failed` (a colour rejected since would otherwise be POSTed).
 * Refused when the engine has since raised a new live proposal for one of its colours —
 * a failed proposal is not "live", so that can happen — because re-approving would give the
 * device two live proposals for one colour.
 */
export async function retryOrder(db: Db, args: { orderId: number; userId: number; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  await db.transaction(async (tx) => {
    const order = await loadOrder(tx, args.orderId);
    if (order.status !== 'failed') throw new ReplenishmentError('Only a failed order can be retried.', 'bad_state');

    const p = replenishmentProposals;
    const failed = await tx.select({ colour: p.colour, quantity: p.quantity }).from(p).where(and(eq(p.orderId, args.orderId), eq(p.status, 'failed')));
    if (failed.length === 0) throw new ReplenishmentError('This order has nothing left to retry.', 'bad_state');
    const [clash] = await tx
      .select({ colour: p.colour })
      .from(p)
      .where(and(eq(p.drmsEquipmentId, order.drmsId), inArray(p.colour, failed.map((f) => f.colour)), inArray(p.status, ['pending', 'approved'])));
    if (clash) {
      throw new ReplenishmentError(`A newer ${clash.colour} proposal for this device is already in the queue; decide that one instead.`, 'bad_state');
    }

    const o = replenishmentOrders;
    const done = await tx
      .update(o)
      .set({ status: 'queued', error: null, request: orderRequest(failed) })
      .where(and(eq(o.id, args.orderId), eq(o.status, 'failed')))
      .returning({ id: o.id });
    if (done.length === 0) throw new ReplenishmentError(STALE, 'bad_state');

    await tx.update(p).set({ status: 'approved' }).where(and(eq(p.orderId, args.orderId), eq(p.status, 'failed')));
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'order.retry',
      entity: 'order',
      entityIds: [args.orderId],
      details: {},
    });
  });
}
