import { CONSUMABLE_TYPE, REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLog, deviceLinks, replenishmentOrders, replenishmentProposals, siteStockShelves, vantageSalesOrders } from '../schema';

/**
 * The toner-order queue's decisions: approve proposals into a queued Vantage order, reject them,
 * and take a `queued` one out of the queue (raised by hand in Vantage, back to review, or deleted). Each is one transaction with one
 * `audit_log` row, and every state change is a guarded update (`where status = <expected>`) so two
 * operators on stale pages cannot both act on the same row — the loser gets a `ReplenishmentError`
 * and nothing is written.
 *
 * None of these call Vantage, and the app never places an order there: people raise them by hand in
 * Vantage. Approval records the intent and queues the order; the `vantage-orders` job's watcher
 * (`matchSalesOrders`, `./order-watch`) moves it on when the sales order appears. `userId` is always
 * supplied by the caller, from the session, never from the form. (The watcher is the exception: it
 * writes no user.)
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

/**
 * The `request` column's value: these cartridges as components in K, C, M, Y, waste order. Nothing
 * sends it to Vantage; the column is NOT NULL and keeps a record of what was approved.
 */
function orderRequest(lines: { colour: ReplenishColour; quantity: number }[]) {
  const components = [...lines]
    .sort((a, b) => REPLENISH_COLOURS.indexOf(a.colour) - REPLENISH_COLOURS.indexOf(b.colour))
    .map((l) => ({ Type: CONSUMABLE_TYPE[l.colour], RequestedQuantity: l.quantity }));
  return { components };
}

/** The shelf field that counts uses of each colour since the last recount. */
const USED_FIELD = {
  black: 'usedBlack',
  cyan: 'usedCyan',
  magenta: 'usedMagenta',
  yellow: 'usedYellow',
  waste: 'usedWaste',
} as const;

export interface ShelfAdjust {
  shelfId: number;
  colour: ReplenishColour;
  by: number;
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Moves shelf `used` counts by `sign * by`, never below zero. */
export async function adjustShelfUsed(tx: Tx, adjusts: ShelfAdjust[], sign: 1 | -1): Promise<void> {
  for (const a of adjusts) {
    const field = USED_FIELD[a.colour];
    await tx
      .update(siteStockShelves)
      .set({ [field]: sql`greatest(${siteStockShelves[field]} + ${sign * a.by}, 0)` })
      .where(eq(siteStockShelves.id, a.shelfId));
  }
}

export interface ApproveItem {
  proposalId: number;
  quantity: number;
}

/**
 * Turns one device's pending proposals into a single `queued` order whose `request` records the
 * approved components, in K, C, M, Y, waste order. The order is for the device's **current** link,
 * not the equipment recorded when the proposal was raised.
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
    const rows = await tx.select({ id: p.id, drmsId: p.drmsEquipmentId, colour: p.colour, status: p.status, shelfId: p.shelfId }).from(p).where(inArray(p.id, ids));
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

    // A top-up's cartridges are now on order, so they come off the shelf's used count.
    const rowOf = new Map(rows.map((r) => [r.id, r]));
    const shelfAdjust: ShelfAdjust[] = items.flatMap((i) => {
      const r = rowOf.get(i.proposalId)!;
      return r.shelfId === null ? [] : [{ shelfId: r.shelfId, colour: r.colour, by: i.quantity }];
    });
    await adjustShelfUsed(tx, shelfAdjust, -1);

    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'proposal.approve',
      entity: 'proposal',
      entityIds: ids,
      details: { orderId, items, ...(shelfAdjust.length > 0 && { shelfAdjust }) },
    });
    return { orderId };
  });
}

/**
 * Says no to proposals (any devices), all or nothing. Only `pending` ones can be rejected.
 * Suppresses re-proposing for a while.
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
      .where(and(inArray(p.id, ids), eq(p.status, 'pending')))
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
    .select({ id: o.id, status: o.status })
    .from(o)
    .where(eq(o.id, orderId));
  if (!row) throw new ReplenishmentError('That order no longer exists — refresh the page.', 'not_found');
  return row;
}

/**
 * The first step of every way out of `queued`: the guarded update that decides who won. Any other
 * status has its own flow.
 */
async function leaveQueue(tx: Tx, orderId: number, set: Partial<typeof replenishmentOrders.$inferInsert>): Promise<void> {
  const order = await loadOrder(tx, orderId);
  if (order.status !== 'queued') throw new ReplenishmentError('Only a queued order can be changed here.', 'bad_state');
  const o = replenishmentOrders;
  const done = await tx
    .update(o)
    .set(set)
    .where(and(eq(o.id, orderId), eq(o.status, 'queued')))
    .returning({ id: o.id });
  if (done.length === 0) throw new ReplenishmentError(STALE, 'bad_state');
}

/**
 * This order's proposals that are still `approved`: a colour rejected before a retry stays rejected.
 * The rest of an order's proposals have already been dealt with and are left alone.
 */
function approvedOn(orderId: number) {
  const p = replenishmentProposals;
  return and(eq(p.orderId, orderId), eq(p.status, 'approved'));
}

/**
 * The sales order(s) an order's `ordered` proposals were matched to, in proposal order: the first
 * one's id for `vantage_sales_order_id`, every distinct reference for `vantage_reference`
 * ("SO1, SO2"). Both null while nothing on the order has been matched.
 */
export async function salesOrderLinkOf(
  tx: Pick<Db, 'select'>,
  orderId: number,
): Promise<{ vantageSalesOrderId: number | null; vantageReference: string | null }> {
  const rows = await tx
    .select({ salesOrderId: replenishmentProposals.vantageSalesOrderId, reference: vantageSalesOrders.reference })
    .from(replenishmentProposals)
    .leftJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, replenishmentProposals.vantageSalesOrderId))
    .where(
      and(
        eq(replenishmentProposals.orderId, orderId),
        eq(replenishmentProposals.status, 'ordered'),
        isNotNull(replenishmentProposals.vantageSalesOrderId),
      ),
    )
    .orderBy(replenishmentProposals.id);
  const refs: string[] = [];
  for (const r of rows) if (r.reference && !refs.includes(r.reference)) refs.push(r.reference);
  return { vantageSalesOrderId: rows[0]?.salesOrderId ?? null, vantageReference: refs.length > 0 ? refs.join(', ') : null };
}

const MOVED_PROPOSAL = {
  id: replenishmentProposals.id,
  colour: replenishmentProposals.colour,
  quantity: replenishmentProposals.quantity,
  shelfId: replenishmentProposals.shelfId,
};

/** An approved top-up came off the shelf's used count; these rows' quantities go back on. */
function shelfAdjustOf(rows: { colour: ReplenishColour; quantity: number; shelfId: number | null }[]): ShelfAdjust[] {
  return rows.flatMap((r) => (r.shelfId === null ? [] : [{ shelfId: r.shelfId, colour: r.colour, by: r.quantity }]));
}

/**
 * After a person takes the still-`approved` proposals off a `queued` order, what is left of it. An
 * order the watcher had partly matched really was ordered in part, so it ends `submitted` (linked to
 * the sales order(s) that closed its other colours) rather than `cancelled`. An order with nothing
 * ordered on it stays `cancelled`. Returns the ids of the proposals that stayed `ordered`.
 */
async function endPartialOrder(tx: Tx, orderId: number, userId: number, now: Date): Promise<number[]> {
  const kept = await tx
    .select({ id: replenishmentProposals.id })
    .from(replenishmentProposals)
    .where(and(eq(replenishmentProposals.orderId, orderId), eq(replenishmentProposals.status, 'ordered')))
    .orderBy(replenishmentProposals.id);
  if (kept.length === 0) return [];
  const link = await salesOrderLinkOf(tx, orderId);
  await tx
    .update(replenishmentOrders)
    .set({ status: 'submitted', submittedAt: now, resolvedBy: userId, resolvedAt: now, ...link })
    .where(eq(replenishmentOrders.id, orderId));
  return kept.map((k) => k.id);
}

/**
 * A person has raised this `queued` order by hand in Vantage and says which one it is. `submitted`
 * with that reference, its proposals `ordered`; shelf counts stay as they are, having come off at
 * approval. Linking that reference to a pulled sales order is the watcher's job (`matchSalesOrders`).
 * On a partly matched order only the colours still `approved` are closed here, and the typed
 * reference is the order's.
 */
export async function markOrderOrdered(
  db: Db,
  args: { orderId: number; reference?: string; userId: number; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const reference = args.reference?.trim() || null;
  if (!reference) throw new ReplenishmentError('Enter the Vantage order reference for this order.', 'bad_state');
  await db.transaction(async (tx) => {
    await leaveQueue(tx, args.orderId, { status: 'submitted', vantageReference: reference, submittedAt: now, resolvedBy: args.userId, resolvedAt: now });
    const p = replenishmentProposals;
    const moved = await tx.update(p).set({ status: 'ordered' }).where(approvedOn(args.orderId)).returning({ id: p.id });
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'order.mark_ordered',
      entity: 'order',
      entityIds: [args.orderId],
      details: { reference, proposalIds: moved.map((m) => m.id) },
    });
  });
}

/**
 * Undoes an approval: the `queued` order is `cancelled` and its proposals go back to `pending` as
 * if never decided, keeping the quantity the operator chose. They stay live throughout (pending and
 * approved share the live-proposal indexes), so the engine cannot have raised a duplicate. A top-up's
 * quantity goes back on the shelf. Only proposals still `approved` move: on an order the watcher has
 * partly matched, the colours already in Vantage stay `ordered` and the order ends `submitted`.
 */
export async function returnOrderToReview(db: Db, args: { orderId: number; userId: number; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  await db.transaction(async (tx) => {
    await leaveQueue(tx, args.orderId, { status: 'cancelled', resolvedBy: args.userId, resolvedAt: now });
    const moved = await tx
      .update(replenishmentProposals)
      .set({ status: 'pending', orderId: null, decidedBy: null, decidedAt: null })
      .where(approvedOn(args.orderId))
      .returning(MOVED_PROPOSAL);
    const shelfAdjust = shelfAdjustOf(moved);
    await adjustShelfUsed(tx, shelfAdjust, 1);
    const keptOrdered = await endPartialOrder(tx, args.orderId, args.userId, now);
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'order.return_to_review',
      entity: 'order',
      entityIds: [args.orderId],
      details: { proposalIds: moved.map((m) => m.id), ...(shelfAdjust.length > 0 && { shelfAdjust }), ...(keptOrdered.length > 0 && { keptOrdered }) },
    });
  });
}

/**
 * Says no to a `queued` order, as Reject does to a proposal: the order is `cancelled` and its
 * proposals `rejected` with the reason, so they show on the Rejected tab and are held off in the
 * usual way (the engine looks at their status and `decidedAt`, not at the order). `orderId` stays.
 * A top-up's quantity goes back on the shelf. Only proposals still `approved` are rejected: colours
 * the watcher already matched stay `ordered`, and that order ends `submitted`, not `cancelled`.
 */
export async function deleteOrder(db: Db, args: { orderId: number; userId: number; note?: string; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  const note = args.note?.trim() || null;
  await db.transaction(async (tx) => {
    await leaveQueue(tx, args.orderId, { status: 'cancelled', resolvedBy: args.userId, resolvedAt: now });
    const moved = await tx
      .update(replenishmentProposals)
      .set({ status: 'rejected', note, decidedBy: args.userId, decidedAt: now })
      .where(approvedOn(args.orderId))
      .returning(MOVED_PROPOSAL);
    const shelfAdjust = shelfAdjustOf(moved);
    await adjustShelfUsed(tx, shelfAdjust, 1);
    const keptOrdered = await endPartialOrder(tx, args.orderId, args.userId, now);
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'order.delete',
      entity: 'order',
      entityIds: [args.orderId],
      details: { note, proposalIds: moved.map((m) => m.id), ...(shelfAdjust.length > 0 && { shelfAdjust }), ...(keptOrdered.length > 0 && { keptOrdered }) },
    });
  });
}
