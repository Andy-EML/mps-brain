import { REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLog, replenishmentOrders, replenishmentProposals, vantageSalesOrderLines, vantageSalesOrders } from '../schema';
import { adjustShelfUsed, salesOrderLinkOf, type ShelfAdjust } from './replenishment-actions';
import { shelfDevicesSubquery } from './site-stock';

/**
 * The Vantage sales-order watcher. The app never places a Vantage order: people raise them by hand,
 * so *Approve* only means "we intend to order". After every orders pull this moves the queue along by
 * itself, in one transaction, and a second run with nothing new changes nothing.
 *
 * 1. **Typed references.** A `submitted` order with no sales order whose `vantage_reference` equals
 *    a live sales order's reference (trimmed, ignoring case) is linked to it, and that sales order's
 *    lines are claimed for the order's proposals. A reference that matches nothing is left alone.
 * 2. **Approved proposals** on `queued` orders close against sales-order lines (see
 *    {@link matchSalesOrders}); an order whose proposals are all closed becomes `submitted`.
 * 3. **Pending site-stock top-ups** are withdrawn by a matching line, as the device loop does for
 *    ordinary pending proposals.
 */

/**
 * A sales order raised this many calendar days before the approval still counts: people often raise
 * the order in Vantage first and click Approve afterwards.
 */
export const MATCH_DAYS_BEFORE_APPROVAL = 2;
const DAY_MS = 86_400_000;

/**
 * Midnight UTC of the London calendar day `at` falls on. Vantage order dates are date-only and arrive
 * as midnight UTC of the London date, so a timestamp is compared as its London day, not as an instant:
 * a sales order dated today must not look older than an approval made this afternoon.
 */
export function londonDayAsUtc(at: Date): Date {
  // en-CA formats as YYYY-MM-DD.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Date(`${day}T00:00:00Z`);
}

export interface OrderWatchResult {
  /** Typed references linked to a sales order. */
  linked: number;
  /** Approved proposals closed by a sales-order line. */
  matched: number;
  /** Orders whose last approved proposal was closed, now `submitted`. */
  completed: number;
  /** Pending site-stock top-ups withdrawn because a sales order covers them. */
  topUpsSuperseded: number;
}

interface Candidate {
  lineId: number;
  colour: string;
  quantity: string | null;
  salesOrderId: number;
  reference: string | null;
  orderDate: Date;
  equipmentId: number | null;
}

/** "approved 2, Vantage 1" when the quantities differ, else null. Colour is what counts; this only informs. */
function quantityNote(approved: number, vantage: string | null): string | null {
  if (vantage === null) return null;
  const n = Number(vantage);
  return Number.isFinite(n) && n !== approved ? `approved ${approved}, Vantage ${n}` : null;
}

/**
 * Runs the whole watcher. Matching rules, for each proposal `approved` on a `queued` order:
 *
 * - a line matches when it has the same colour, its equipment (`coalesce(line, order header)`, the
 *   rule `getOrderStates` uses) is the order's Vantage equipment, its sales order is not deleted, the
 *   line is not returned, and the sales order's date is no earlier than the London day of the order's
 *   approval less {@link MATCH_DAYS_BEFORE_APPROVAL}. Completed sales orders match too.
 * - a site-stock top-up (`shelf_id` set) matches a line on any device currently on its shelf (and the
 *   order's own device), since the order may go on another machine at the site;
 * - several candidates: the oldest sales order, ties by lowest line id;
 * - a line closes at most one proposal, ever (`vantage_sales_order_line_id` is unique), so one sales
 *   order with a black and a cyan line can close a queued black order and a queued cyan one;
 * - a different quantity still closes it, with a short note;
 * - partial: only matched proposals close; the order is `submitted` only when none is still `approved`.
 *
 * Pending site-stock top-ups are then compared the same way against their own `created_at` (no slack:
 * the same baseline the device loop uses for ordinary pending proposals). A match makes the proposal
 * `superseded` ("ordered in Vantage (SO…)", which puts it on the Rejected tab with that note, where
 * the device loop's own supersedes already go) and takes its quantity off the shelf's used count so
 * the same empties cannot raise another top-up. Approved proposals pick first, so a pending top-up
 * never takes a line an approved order is waiting for.
 *
 * Writes one `audit_log` row (no user) when it did anything.
 */
export async function matchSalesOrders(db: Db, now: Date = new Date()): Promise<OrderWatchResult> {
  return db.transaction(async (tx) => {
    const p = replenishmentProposals;
    const o = replenishmentOrders;
    const result: OrderWatchResult = { linked: 0, matched: 0, completed: 0, topUpsSuperseded: 0 };
    const details = {
      linked: [] as { orderId: number; salesOrderId: number; proposalIds: number[] }[],
      matched: [] as { proposalId: number; orderId: number; salesOrderId: number; lineId: number }[],
      completedOrders: [] as number[],
      supersededTopUps: [] as { proposalId: number; salesOrderId: number; lineId: number; shelfId: number; colour: ReplenishColour; quantity: number }[],
    };
    const touchedOrders = new Set<number>();

    // Every line already spoken for, kept up to date through the run.
    const claimed = new Set(
      (await tx.select({ id: p.vantageSalesOrderLineId }).from(p).where(isNotNull(p.vantageSalesOrderLineId))).map((r) => r.id!),
    );

    // ---- 1. Typed references ---------------------------------------------------------------
    const unlinked = await tx
      .select({ id: o.id, reference: o.vantageReference })
      .from(o)
      .where(and(eq(o.status, 'submitted'), isNull(o.vantageSalesOrderId), isNotNull(o.vantageReference)))
      .orderBy(o.id);
    const wanted = new Map<string, number[]>(); // lower-cased reference -> order ids
    for (const u of unlinked) {
      const key = u.reference!.trim().toLowerCase();
      if (key) wanted.set(key, [...(wanted.get(key) ?? []), u.id]);
    }
    if (wanted.size > 0) {
      const sos = await tx
        .select({ id: vantageSalesOrders.vantageId, reference: vantageSalesOrders.reference })
        .from(vantageSalesOrders)
        .where(and(isNull(vantageSalesOrders.deletedDate), sql`lower(btrim(${vantageSalesOrders.reference})) in (${sql.join([...wanted.keys()].map((k) => sql`${k}`), sql`, `)})`))
        .orderBy(vantageSalesOrders.vantageId);
      const soByRef = new Map<string, number>();
      for (const s of sos) {
        const key = s.reference!.trim().toLowerCase();
        if (!soByRef.has(key)) soByRef.set(key, s.id);
      }
      for (const [key, orderIds] of wanted) {
        const salesOrderId = soByRef.get(key);
        if (salesOrderId === undefined) continue;
        const lines = await tx
          .select({ id: vantageSalesOrderLines.vantageId, colour: vantageSalesOrderLines.colour })
          .from(vantageSalesOrderLines)
          .where(and(eq(vantageSalesOrderLines.salesOrderId, salesOrderId), isNull(vantageSalesOrderLines.returnedDate)))
          .orderBy(vantageSalesOrderLines.vantageId);
        for (const orderId of orderIds) {
          const done = await tx
            .update(o)
            .set({ vantageSalesOrderId: salesOrderId })
            .where(and(eq(o.id, orderId), eq(o.status, 'submitted'), isNull(o.vantageSalesOrderId)))
            .returning({ id: o.id });
          if (done.length === 0) continue;
          // Its proposals take this sales order's lines, so the watcher cannot give them to another order.
          const mine = await tx
            .select({ id: p.id, colour: p.colour })
            .from(p)
            .where(and(eq(p.orderId, orderId), eq(p.status, 'ordered'), isNull(p.vantageSalesOrderLineId)))
            .orderBy(p.id);
          for (const prop of mine) {
            const line = lines.find((l) => l.colour === prop.colour && !claimed.has(l.id));
            await tx
              .update(p)
              .set({ vantageSalesOrderId: salesOrderId, vantageSalesOrderLineId: line?.id ?? null })
              .where(eq(p.id, prop.id));
            if (line) claimed.add(line.id);
          }
          details.linked.push({ orderId, salesOrderId, proposalIds: mine.map((m) => m.id) });
          touchedOrders.add(orderId);
          result.linked++;
        }
      }
    }

    // ---- 2 + 3. Approved proposals, then pending top-ups -------------------------------------
    const approved = await tx
      .select({
        id: p.id,
        orderId: p.orderId,
        colour: p.colour,
        quantity: p.quantity,
        note: p.note,
        shelfId: p.shelfId,
        orderEquipmentId: o.vantageEquipmentId,
        approvedAt: o.createdAt,
      })
      .from(p)
      .innerJoin(o, eq(o.id, p.orderId))
      .where(and(eq(p.status, 'approved'), eq(o.status, 'queued')))
      .orderBy(o.createdAt, p.id);
    const pending = await tx
      .select({ id: p.id, colour: p.colour, quantity: p.quantity, shelfId: p.shelfId, createdAt: p.createdAt })
      .from(p)
      .where(and(eq(p.status, 'pending'), isNotNull(p.shelfId)))
      .orderBy(p.createdAt, p.id);

    if (approved.length > 0 || pending.length > 0) {
      const threshold = (at: Date, slackDays: number) => new Date(londonDayAsUtc(at).getTime() - slackDays * DAY_MS);
      const floors = [
        ...approved.map((a) => threshold(a.approvedAt, MATCH_DAYS_BEFORE_APPROVAL)),
        ...pending.map((q) => threshold(q.createdAt, 0)),
      ];
      const floor = new Date(Math.min(...floors.map((f) => f.getTime())));

      const equipment = sql<number | null>`coalesce(${vantageSalesOrderLines.vantageEquipmentId}, ${vantageSalesOrders.vantageEquipmentId})`;
      const found = await tx
        .select({
          lineId: vantageSalesOrderLines.vantageId,
          colour: vantageSalesOrderLines.colour,
          quantity: vantageSalesOrderLines.quantity,
          salesOrderId: vantageSalesOrders.vantageId,
          reference: vantageSalesOrders.reference,
          orderDate: vantageSalesOrders.orderDate,
          equipmentId: equipment,
        })
        .from(vantageSalesOrderLines)
        .innerJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, vantageSalesOrderLines.salesOrderId))
        .where(
          and(
            isNull(vantageSalesOrders.deletedDate),
            isNull(vantageSalesOrderLines.returnedDate),
            inArray(vantageSalesOrderLines.colour, [...REPLENISH_COLOURS]),
            sql`${vantageSalesOrders.orderDate} >= ${floor}`,
          ),
        );
      // Oldest sales order first, then lowest line id: the first candidate in this list wins.
      const candidates: Candidate[] = found
        .map((f) => ({ ...f, orderDate: f.orderDate!, equipmentId: f.equipmentId === null ? null : Number(f.equipmentId) }) as Candidate)
        .sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime() || a.lineId - b.lineId);

      const shelfIds = [...new Set([...approved, ...pending].map((x) => x.shelfId).filter((id): id is number => id !== null))];
      const shelfEquipment = new Map<number, Set<number>>();
      if (shelfIds.length > 0) {
        const sd = shelfDevicesSubquery(tx);
        const members = await tx.select({ shelfId: sd.shelfId, equipmentId: sd.vantageEquipmentId }).from(sd).where(inArray(sd.shelfId, shelfIds));
        for (const m of members) shelfEquipment.set(m.shelfId, (shelfEquipment.get(m.shelfId) ?? new Set()).add(m.equipmentId));
      }

      const pick = (colour: string, equipmentIds: Set<number>, from: Date): Candidate | undefined =>
        candidates.find(
          (c) => c.colour === colour && !claimed.has(c.lineId) && c.equipmentId !== null && equipmentIds.has(c.equipmentId) && c.orderDate >= from,
        );

      for (const a of approved) {
        const equipmentIds = new Set([a.orderEquipmentId, ...(a.shelfId === null ? [] : (shelfEquipment.get(a.shelfId) ?? []))]);
        const hit = pick(a.colour, equipmentIds, threshold(a.approvedAt, MATCH_DAYS_BEFORE_APPROVAL));
        if (!hit) continue;
        const extra = quantityNote(a.quantity, hit.quantity);
        const done = await tx
          .update(p)
          .set({
            status: 'ordered',
            vantageSalesOrderId: hit.salesOrderId,
            vantageSalesOrderLineId: hit.lineId,
            ...(extra && { note: a.note ? `${a.note}; ${extra}` : extra }),
          })
          .where(and(eq(p.id, a.id), eq(p.status, 'approved')))
          .returning({ id: p.id });
        if (done.length === 0) continue; // decided by hand since we read it
        claimed.add(hit.lineId);
        details.matched.push({ proposalId: a.id, orderId: a.orderId!, salesOrderId: hit.salesOrderId, lineId: hit.lineId });
        touchedOrders.add(a.orderId!);
        result.matched++;
      }

      // Orders with no proposal still `approved` are done.
      const matchedOrders = [...new Set(details.matched.map((m) => m.orderId))];
      for (const orderId of matchedOrders) {
        const [left] = await tx
          .select({ id: p.id })
          .from(p)
          .where(and(eq(p.orderId, orderId), eq(p.status, 'approved')))
          .limit(1);
        if (left) continue;
        const link = await salesOrderLinkOf(tx, orderId);
        const done = await tx
          .update(o)
          .set({ status: 'submitted', submittedAt: now, resolvedAt: now, ...link })
          .where(and(eq(o.id, orderId), eq(o.status, 'queued')))
          .returning({ id: o.id });
        if (done.length === 0) continue;
        details.completedOrders.push(orderId);
        result.completed++;
      }

      const shelfAdjust: ShelfAdjust[] = [];
      for (const q of pending) {
        const hit = pick(q.colour, shelfEquipment.get(q.shelfId!) ?? new Set(), threshold(q.createdAt, 0));
        if (!hit) continue;
        const done = await tx
          .update(p)
          .set({
            status: 'superseded',
            decidedAt: now,
            note: `ordered in Vantage (${hit.reference ?? 'no reference'})`,
            vantageSalesOrderId: hit.salesOrderId,
            vantageSalesOrderLineId: hit.lineId,
          })
          .where(and(eq(p.id, q.id), eq(p.status, 'pending')))
          .returning({ id: p.id });
        if (done.length === 0) continue;
        claimed.add(hit.lineId);
        shelfAdjust.push({ shelfId: q.shelfId!, colour: q.colour, by: q.quantity });
        details.supersededTopUps.push({ proposalId: q.id, salesOrderId: hit.salesOrderId, lineId: hit.lineId, shelfId: q.shelfId!, colour: q.colour, quantity: q.quantity });
        result.topUpsSuperseded++;
      }
      await adjustShelfUsed(tx, shelfAdjust, -1);
    }

    if (result.linked + result.matched + result.completed + result.topUpsSuperseded > 0) {
      await tx.insert(auditLog).values({
        at: now,
        userId: null, // the system, not a person
        action: 'order.watch',
        entity: 'order',
        entityIds: [...touchedOrders].sort((a, b) => a - b),
        details,
      });
    }
    return result;
  });
}
