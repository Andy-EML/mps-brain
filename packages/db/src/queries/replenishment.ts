import { REPLENISH_COLOURS, deviceDisplayName, type ReplenishColour } from '@mps/core';
import { and, count, countDistinct, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import {
  drmsEquipment,
  replenishmentOrders,
  replenishmentProposals,
  users,
  vantageEquipment,
  vantageSalesOrders,
  type OrderStatus,
  type ProposalStatus,
  type ProposalTrigger,
} from '../schema';
import { getOrderStates, type OrderRef } from './order-state';
import { effectiveSettingsSubquery, type SettingSource } from './settings';
import { listShelfSummariesByIds } from './site-stock';
import { counterPivotSubquery, drmsEquipmentName, toNumberOrNull } from './shared';

/**
 * The toner-order review queue (`/orders`), its header stats and the device page's replenishment
 * card. Read-only; the decisions that change these rows live in `./replenishment-actions`.
 */

export type QueueTab = 'review' | 'in-progress' | 'ordered' | 'rejected';

/** How far back the *Ordered* and *Rejected* tabs look. */
export const ORDERED_TAB_DAYS = 90;
export const REJECTED_TAB_DAYS = 30;
const DEFAULT_QUEUE_LIMIT = 200;
const DEVICE_PAGE_ORDERS = 10;

export interface QueueProposal {
  id: number;
  colour: ReplenishColour;
  trigger: ProposalTrigger;
  /** Toner % when the proposal was raised; null for waste. */
  level: number | null;
  /** The device's **effective** threshold now (not the one stored at proposal time); null for waste. */
  threshold: number | null;
  thresholdSource: SettingSource | null;
  /** Latest reading from the counter pivot; null for waste or when there is none. */
  currentLevel: number | null;
  alarmDescription: string | null;
  quantity: number;
  status: ProposalStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  note: string | null;
  /** The site-stock shelf a top-up proposal belongs to; null for ordinary proposals. */
  shelfId: number | null;
  /** The MPS order this proposal went into (approved, ordered, failed); null before a decision. */
  orderId: number | null;
  /** The newest order of this colour on the device's current Vantage equipment, open or not. */
  lastOrder: (OrderRef & { open: boolean }) | null;
  openOrder: OrderRef | null;
}

export interface QueueOrder {
  id: number;
  status: OrderStatus;
  vantageReference: string | null;
  isOnHold: boolean | null;
  error: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  createdBy: string | null;
}

export interface QueueDevice {
  drmsId: string;
  /** The card heading: see `deviceDisplayName` (@mps/core). */
  displayName: string;
  name: string | null;
  model: string | null;
  serial: string | null;
  customerName: string | null;
  location: string | null;
  /** The current link's Vantage equipment; null when the device is unlinked. */
  vantageEquipmentId: number | null;
  /** `drms_equipment.is_colour`: a mono device has only a black cartridge. */
  isColour: boolean;
  /**
   * Latest toner % for every cartridge from the counter pivot, proposed or not; null when there is
   * no reading (always for cyan/magenta/yellow on a mono device).
   */
  tonerLevels: Record<TonerColour, number | null>;
  /** Set when any of the device's proposals is a shelf top-up. */
  shelf: { id: number; siteName: string; familyName: string; machines: number } | null;
  proposals: QueueProposal[];
  orders: QueueOrder[];
}

const decider = alias(users, 'decider');
const creator = alias(users, 'creator');

type ProposalRow = Awaited<ReturnType<typeof selectProposals>>[number];
type OrderRow = Awaited<ReturnType<typeof selectOrders>>[number];

function selectProposals(db: Db, where: SQL | undefined) {
  const p = replenishmentProposals;
  return db
    .select({
      id: p.id,
      drmsId: p.drmsEquipmentId,
      colour: p.colour,
      trigger: p.trigger,
      level: p.level,
      alarmDescription: p.alarmDescription,
      quantity: p.quantity,
      status: p.status,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt,
      decidedBy: decider.username,
      note: p.note,
      shelfId: p.shelfId,
      orderId: p.orderId,
    })
    .from(p)
    .leftJoin(decider, eq(decider.id, p.decidedBy))
    .where(where);
}

function selectOrders(db: Db, where: SQL | undefined, limit?: number) {
  const o = replenishmentOrders;
  const q = db
    .select({
      id: o.id,
      drmsId: o.drmsEquipmentId,
      status: o.status,
      vantageReference: o.vantageReference,
      isOnHold: o.isOnHold,
      error: o.error,
      createdAt: o.createdAt,
      submittedAt: o.submittedAt,
      createdBy: creator.username,
    })
    .from(o)
    .leftJoin(creator, eq(creator.id, o.createdBy))
    .where(where)
    .orderBy(desc(o.createdAt), desc(o.id));
  return limit === undefined ? q : q.limit(limit);
}

type TonerColour = Exclude<ReplenishColour, 'waste'>;
interface DeviceContext {
  device: Omit<QueueDevice, 'proposals' | 'orders' | 'shelf'>;
  thresholds: Record<TonerColour, { value: number | null; source: SettingSource }>;
}

/** Display fields, effective thresholds and current levels for a set of devices, in one query. */
async function deviceContexts(db: Db, drmsIds: string[]): Promise<Map<string, DeviceContext>> {
  const out = new Map<string, DeviceContext>();
  if (drmsIds.length === 0) return out;
  const eff = effectiveSettingsSubquery(db);
  const pivot = counterPivotSubquery(db);
  const rows = await db
    .select({
      drmsId: drmsEquipment.drmsId,
      name: drmsEquipment.productName,
      equipmentName: drmsEquipmentName(),
      model: drmsEquipment.modelName,
      serial: drmsEquipment.serial,
      isColour: drmsEquipment.isColour,
      drmsCustomerName: drmsEquipment.customerName,
      vantageCustomerName: vantageEquipment.customerName,
      location: vantageEquipment.location,
      vantageEquipmentId: eff.vantageEquipmentId,
      tBlack: eff.thresholdBlack,
      sBlack: eff.thresholdBlackSource,
      tCyan: eff.thresholdCyan,
      sCyan: eff.thresholdCyanSource,
      tMagenta: eff.thresholdMagenta,
      sMagenta: eff.thresholdMagentaSource,
      tYellow: eff.thresholdYellow,
      sYellow: eff.thresholdYellowSource,
      black: pivot.black,
      cyan: pivot.cyan,
      magenta: pivot.magenta,
      yellow: pivot.yellow,
    })
    .from(drmsEquipment)
    .innerJoin(eff, eq(eff.drmsId, drmsEquipment.drmsId))
    // `eff.vantageEquipmentId` is the current (not unlinked) link, so this is the live customer.
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, eff.vantageEquipmentId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
    .where(inArray(drmsEquipment.drmsId, drmsIds));

  for (const r of rows) {
    const customerName = r.vantageCustomerName ?? r.drmsCustomerName;
    out.set(r.drmsId, {
      device: {
        drmsId: r.drmsId,
        displayName: deviceDisplayName({ equipmentName: r.equipmentName, customerName, model: r.model, serial: r.serial, drmsId: r.drmsId }),
        name: r.name,
        model: r.model,
        serial: r.serial,
        customerName,
        location: r.location,
        vantageEquipmentId: r.vantageEquipmentId,
        isColour: r.isColour,
        tonerLevels: {
          black: toNumberOrNull(r.black),
          cyan: toNumberOrNull(r.cyan),
          magenta: toNumberOrNull(r.magenta),
          yellow: toNumberOrNull(r.yellow),
        },
      },
      thresholds: {
        black: { value: toNumberOrNull(r.tBlack), source: r.sBlack },
        cyan: { value: toNumberOrNull(r.tCyan), source: r.sCyan },
        magenta: { value: toNumberOrNull(r.tMagenta), source: r.sMagenta },
        yellow: { value: toNumberOrNull(r.tYellow), source: r.sYellow },
      },
    });
  }
  return out;
}

const colourRank = (c: ReplenishColour) => REPLENISH_COLOURS.indexOf(c);

/**
 * Groups proposal and order rows by device and decorates each proposal with its context: effective
 * threshold and source, the current level, and the colour's last/open order (`getOrderStates`,
 * keyed by the device's **current** Vantage equipment). Three queries whatever the row count.
 * Devices come back in first-seen order; callers sort.
 */
async function assemble(db: Db, proposals: ProposalRow[], orders: OrderRow[], now: Date): Promise<QueueDevice[]> {
  const ids = [...new Set([...proposals.map((p) => p.drmsId), ...orders.map((o) => o.drmsId)])];
  const contexts = await deviceContexts(db, ids);
  const linked = [...new Set([...contexts.values()].map((c) => c.device.vantageEquipmentId).filter((v): v is number => v !== null))];
  const states = await getOrderStates(db, linked, now);

  const shelfIds = [...new Set(proposals.map((p) => p.shelfId).filter((v): v is number => v !== null))];
  const shelves = new Map((await listShelfSummariesByIds(db, shelfIds)).map((s) => [s.id, s]));

  const devices = new Map<string, QueueDevice>();
  for (const id of ids) {
    const ctx = contexts.get(id);
    if (!ctx) continue;
    devices.set(id, { ...ctx.device, shelf: null, proposals: [], orders: [] });
  }
  for (const p of proposals) {
    const ctx = contexts.get(p.drmsId);
    const device = devices.get(p.drmsId);
    if (!ctx || !device) continue;
    const toner = p.colour === 'waste' ? null : p.colour;
    const state = device.vantageEquipmentId === null ? undefined : states.get(device.vantageEquipmentId)?.[p.colour];
    device.proposals.push({
      id: p.id,
      colour: p.colour,
      trigger: p.trigger,
      level: p.level,
      threshold: toner ? ctx.thresholds[toner].value : null,
      thresholdSource: toner ? ctx.thresholds[toner].source : null,
      currentLevel: toner ? ctx.device.tonerLevels[toner] : null,
      alarmDescription: p.alarmDescription,
      quantity: p.quantity,
      status: p.status,
      createdAt: p.createdAt,
      decidedAt: p.decidedAt,
      decidedBy: p.decidedBy,
      note: p.note,
      shelfId: p.shelfId,
      orderId: p.orderId,
      lastOrder: state?.last ?? null,
      openOrder: state?.open ?? null,
    });
    const shelf = p.shelfId === null ? undefined : shelves.get(p.shelfId);
    if (shelf && !device.shelf) device.shelf = { id: shelf.id, siteName: shelf.siteName, familyName: shelf.familyName, machines: shelf.machines };
  }
  for (const o of orders) {
    const { drmsId, ...order } = o;
    devices.get(drmsId)?.orders.push(order);
  }
  for (const d of devices.values()) {
    d.proposals.sort((a, b) => colourRank(a.colour) - colourRank(b.colour) || b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
    d.orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
  }
  return [...devices.values()];
}

/** Review order: the emptiest cartridge first (no reading last), then name. */
function byUrgency(a: QueueDevice, b: QueueDevice): number {
  const low = (d: QueueDevice) => Math.min(...d.proposals.map((p) => p.currentLevel ?? Infinity));
  return low(a) - low(b) || a.displayName.localeCompare(b.displayName) || a.drmsId.localeCompare(b.drmsId);
}

/** The other tabs: most recent activity (order sent or raised, proposal decided) first. */
function byRecency(a: QueueDevice, b: QueueDevice): number {
  const latest = (d: QueueDevice) =>
    Math.max(
      ...d.orders.map((o) => (o.submittedAt ?? o.createdAt).getTime()),
      ...d.proposals.map((p) => (p.decidedAt ?? p.createdAt).getTime()),
    );
  return latest(b) - latest(a) || a.drmsId.localeCompare(b.drmsId);
}

/**
 * A `failed` order still needs a person only while one of its proposals is still `failed`. Once
 * they have all been rejected (or retried) the row stays `failed` as history, but drops out of
 * *In progress* and `attentionOrders`.
 */
function failedAwaitingDecision(): SQL {
  const o = replenishmentOrders;
  return sql`(${o.status} = 'failed' and exists (select 1 from ${replenishmentProposals} fp where fp.order_id = ${o.id} and fp.status = 'failed'))`;
}

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/**
 * One tab of the toner-order queue, grouped by device.
 *
 * - *review*: devices with a `pending` proposal (only the pending ones shown);
 * - *in-progress*: orders `queued|submitting|uncertain`, or `failed` with a proposal still `failed`,
 *   and their proposals;
 * - *ordered*: orders `submitted` in the last {@link ORDERED_TAB_DAYS} days;
 * - *rejected*: proposals `rejected|superseded` in the last {@link REJECTED_TAB_DAYS} days.
 *
 * `limit` caps the number of devices.
 */
export async function listReplenishmentQueue(
  db: Db,
  args: { tab: QueueTab; limit?: number; now?: Date },
): Promise<QueueDevice[]> {
  const now = args.now ?? new Date();
  const p = replenishmentProposals;
  const o = replenishmentOrders;
  let devices: QueueDevice[];

  if (args.tab === 'review' || args.tab === 'rejected') {
    const where =
      args.tab === 'review'
        ? eq(p.status, 'pending')
        : and(inArray(p.status, ['rejected', 'superseded']), gte(p.decidedAt, daysBefore(now, REJECTED_TAB_DAYS)));
    devices = await assemble(db, await selectProposals(db, where), [], now);
  } else {
    const where =
      args.tab === 'in-progress'
        ? sql`(${inArray(o.status, ['queued', 'submitting', 'uncertain'])} or ${failedAwaitingDecision()})`
        : and(eq(o.status, 'submitted'), gte(o.submittedAt, daysBefore(now, ORDERED_TAB_DAYS)));
    const orders = await selectOrders(db, where);
    const proposals = orders.length === 0 ? [] : await selectProposals(db, inArray(p.orderId, orders.map((x) => x.id)));
    devices = await assemble(db, proposals, orders, now);
  }

  devices.sort(args.tab === 'review' ? byUrgency : byRecency);
  return devices.slice(0, args.limit ?? DEFAULT_QUEUE_LIMIT);
}

export interface ReplenishmentStats {
  awaitingReviewDevices: number;
  awaitingReviewProposals: number;
  /** Distinct devices with an MPS order still open (see `openMpsOrders`). */
  onOrderDevices: number;
  /** Our orders in flight: `queued|submitting|uncertain`, or `submitted` and not yet completed in Vantage. */
  openMpsOrders: number;
  /** Orders a person has to look at: `uncertain`, plus `failed` ones with a proposal still `failed`. */
  attentionOrders: number;
  /** Cartridges on orders that reached Vantage this calendar quarter (UTC). */
  cartridgesThisQuarter: number;
}

/** The queue's header stats, in three queries. */
export async function getReplenishmentStats(db: Db, now: Date = new Date()): Promise<ReplenishmentStats> {
  const p = replenishmentProposals;
  const o = replenishmentOrders;

  const [pending] = await db
    .select({ devices: countDistinct(p.drmsEquipmentId), proposals: count() })
    .from(p)
    .where(eq(p.status, 'pending'));

  // A submitted order is open until the pulled Vantage order says it completed; one not pulled yet
  // (no row) is still open.
  const open = sql`(${o.status} in ('queued', 'submitting', 'uncertain') or (${o.status} = 'submitted' and ${vantageSalesOrders.completedDate} is null))`;
  const [orders] = await db
    .select({
      onOrderDevices: sql<number>`count(distinct ${o.drmsEquipmentId}) filter (where ${open})`,
      openMpsOrders: sql<number>`count(*) filter (where ${open})`,
      attentionOrders: sql<number>`count(*) filter (where ${o.status} = 'uncertain' or ${failedAwaitingDecision()})`,
    })
    .from(o)
    .leftJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, o.vantageSalesOrderId));

  const quarterMonth = now.getUTCMonth() - (now.getUTCMonth() % 3);
  const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1));
  const quarterEnd = new Date(Date.UTC(now.getUTCFullYear(), quarterMonth + 3, 1));
  const [cartridges] = await db
    .select({ n: sql<number>`coalesce(sum(${p.quantity}), 0)` })
    .from(p)
    .innerJoin(o, eq(o.id, p.orderId))
    .where(and(eq(p.status, 'ordered'), gte(o.submittedAt, quarterStart), lt(o.submittedAt, quarterEnd)));

  return {
    awaitingReviewDevices: Number(pending?.devices ?? 0),
    awaitingReviewProposals: Number(pending?.proposals ?? 0),
    onOrderDevices: Number(orders?.onOrderDevices ?? 0),
    openMpsOrders: Number(orders?.openMpsOrders ?? 0),
    attentionOrders: Number(orders?.attentionOrders ?? 0),
    cartridgesThisQuarter: Number(cartridges?.n ?? 0),
  };
}

/** Devices with a pending proposal — the sidebar badge. */
export async function countAwaitingReview(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: countDistinct(replenishmentProposals.drmsEquipmentId) })
    .from(replenishmentProposals)
    .where(eq(replenishmentProposals.status, 'pending'));
  return Number(r?.n ?? 0);
}

/** The device page's card: live (`pending|approved`) proposals and the last few MPS orders. */
export async function listDeviceReplenishment(
  db: Db,
  drmsId: string,
  now: Date = new Date(),
): Promise<{ proposals: QueueProposal[]; orders: QueueOrder[] }> {
  const p = replenishmentProposals;
  const [proposals, orders] = await Promise.all([
    selectProposals(db, and(eq(p.drmsEquipmentId, drmsId), inArray(p.status, ['pending', 'approved']))),
    selectOrders(db, eq(replenishmentOrders.drmsEquipmentId, drmsId), DEVICE_PAGE_ORDERS),
  ]);
  const [device] = await assemble(db, proposals, orders, now);
  return { proposals: device?.proposals ?? [], orders: device?.orders ?? [] };
}
