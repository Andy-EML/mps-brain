import { REPLENISH_COLOURS, dedupeDeliveries, deliveryColour, deliveryFitDates, type ReplenishColour } from '@mps/core';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { compareBy, deliveryAlarmSql, type SortSpec, type SortValue } from './shared';
import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  vantageEquipment,
  vantageMeterReadings,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';

/**
 * Toner yield: how many pages each cartridge actually did, per device and colour, against the
 * rated yield. Read-only. Two questions:
 *
 *  (a) Early: a colour was delivered on a Vantage sales order, and the pages printed since are less
 *      than {@link EARLY_PCT_THRESHOLD} of a rated cartridge, so a new request looks premature.
 *  (b) Under-yielding: the average pages per cartridge over the last {@link MAX_CARTRIDGES_FOR_AVERAGE}
 *      measurable cartridges is under {@link UNDER_YIELD_PCT_THRESHOLD} of rated.
 *
 * A "cartridge" is a delivery event: a non-returned sales-order line of that colour on a
 * non-deleted order (date = order date), on the device's linked Vantage equipment. Pages for a
 * cartridge are the meter movement from its delivery to the next delivery of the same colour,
 * divided by the line quantity. Order-to-order is an approximation (the cartridge goes in some days
 * after delivery), which averages out over several cartridges.
 *
 * The pure arithmetic is exported and unit-tested without a database; the loaders at the bottom
 * only fetch rows and feed it.
 */

/** Pages since the last delivery below this share of the rated yield means the request is early. */
export const EARLY_PCT_THRESHOLD = 0.5;
/** An average achieved yield below this share of rated means the device/colour is under-yielding. */
export const UNDER_YIELD_PCT_THRESHOLD = 0.7;
/** How many of the most recent measurable cartridges the average covers. */
export const MAX_CARTRIDGES_FOR_AVERAGE = 5;
/** Fewer measurable cartridges than this is too noisy to call under-yielding. */
export const MIN_CARTRIDGES_FOR_UNDER_YIELD = 2;
/** A device whose newest meter snapshot is older than this has stale "pages since" figures. */
export const STALE_SNAPSHOT_DAYS = 14;
/** With no meter reading at or before a date, a reading up to this many days after it will do. */
export const METER_LOOKAHEAD_DAYS = 14;

const DAY_MS = 86_400_000;
const BLACK_METER = 'Black:Total';
const COLOUR_METER = 'Full Color:Total';

export type YieldColour = ReplenishColour;
export type YieldStatus = 'ok' | 'no_rated_yield';

// ---------------------------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------------------------

/** One meter reading of the pages that count for a colour. */
export interface YieldMeterPoint {
  at: Date;
  value: number;
}

/** One DRMS counter fetch, reduced to the two meters this module needs. */
export interface MeterSnapshot {
  at: Date;
  black: number | null;
  colour: number | null;
}

/** A cartridge delivery: one sales-order line. */
export interface DeliveryEvent {
  orderDate: Date;
  salesOrderId: number;
  lineId: number;
  /** Cartridges on the line; null/invalid counts as 1. */
  quantity: number | null;
  /**
   * When a Toner Delivery alarm says this delivery was fitted (first Delivery on or after the order date,
   * before the next order of the colour). The meter is read from here instead of the order date; absent or
   * null = no Delivery seen, the order date stands.
   */
  fitDate?: Date | null;
}

export interface CartridgeInterval {
  orderDate: Date;
  /** Where the meter is read for this cartridge: the Delivery fit date when there is one, else the order date. */
  anchor: Date;
  /** The first sales order / line when several were raised the same day. */
  salesOrderId: number;
  lineId: number;
  /** Every line merged into this delivery (same colour, same order date). */
  lineIds: number[];
  quantity: number;
  /** Meter pages from this delivery to the next one; null for the newest or when not measurable. */
  pagesDone: number | null;
  /** `pagesDone / quantity`. */
  pagesPerCartridge: number | null;
}

/** The meter for `colour` out of one snapshot; null when a meter it needs is missing. */
export function pageMeterValue(colour: YieldColour, isColour: boolean, s: Pick<MeterSnapshot, 'black' | 'colour'>): number | null {
  // Cyan/magenta/yellow are only used by colour pages. Black toner and the waste bottle are used by
  // every page, mono or colour.
  if (colour === 'cyan' || colour === 'magenta' || colour === 'yellow') return s.colour;
  if (s.black === null) return null;
  if (s.colour !== null) return s.black + s.colour;
  // A mono device has no colour meter at all; on a colour device the total would be understated.
  return isColour ? null : s.black;
}

/** Vantage `MeterType` ids as seen live (2026-11-17): 1 Black, 2 Colour, 3 Scan, 4-11 colour coverage tiers, 12 Black A3. */
export const VANTAGE_BLACK_TYPE = 1;
export const VANTAGE_COLOUR_TYPE = 2;
/** Coverage-tier colour meters (Level 1-3, <3%, 2-4%, >3%, <4%, >4%): only ever used instead of type 2, and summed. */
export const VANTAGE_COLOUR_TIER_TYPES: readonly number[] = [4, 5, 6, 7, 8, 9, 10, 11];
/** `Black A3`: the A3 sheet count is kept apart from `Black`, scale unverified against DRMS, so the machine is skipped. */
export const VANTAGE_BLACK_A3_TYPE = 12;
/** A Vantage reading this close to a DRMS snapshot is the same reading (Vantage's come from DRMS billing); DRMS wins. */
export const VANTAGE_DEDUPE_HOURS = 36;

/** One Vantage `MeterReading`, reduced to what this module needs. */
export interface VantageMeterPoint {
  equipmentId: number;
  at: Date;
  typeId: number;
  value: number;
}

/**
 * Vantage readings of ONE machine to snapshots, one per reading time. Black = type 1; colour = type 2,
 * or the sum of the coverage-tier types on machines billed that way (verified: tiers 7 + 9 matched DRMS
 * `Full Color:Total` to within 12 pages). A machine with a `Black A3` meter yields nothing: its black
 * scale could not be verified against DRMS.
 */
export function vantageSnapshots(points: VantageMeterPoint[]): MeterSnapshot[] {
  if (points.some((p) => p.typeId === VANTAGE_BLACK_A3_TYPE)) return [];
  const byTime = new Map<number, MeterSnapshot & { tierSum: number | null }>();
  for (const p of points) {
    const key = p.at.getTime();
    let s = byTime.get(key);
    if (!s) {
      s = { at: p.at, black: null, colour: null, tierSum: null };
      byTime.set(key, s);
    }
    if (p.typeId === VANTAGE_BLACK_TYPE) s.black = p.value;
    else if (p.typeId === VANTAGE_COLOUR_TYPE) s.colour = p.value;
    else if (VANTAGE_COLOUR_TIER_TYPES.includes(p.typeId)) s.tierSum = (s.tierSum ?? 0) + p.value;
  }
  return [...byTime.values()]
    .map((s) => ({ at: s.at, black: s.black, colour: s.colour ?? s.tierSum }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * DRMS snapshots merged with Vantage ones, oldest first. A Vantage snapshot within
 * {@link VANTAGE_DEDUPE_HOURS} of a DRMS one is dropped (same reading, DRMS is the source). A Vantage
 * snapshot that would make the series go backwards against its neighbours (a lagging manual reading)
 * is dropped too; DRMS snapshots are never touched, so a real reset still shows.
 */
export function mergeSnapshots(drms: MeterSnapshot[], vantage: MeterSnapshot[]): MeterSnapshot[] {
  const dedupeMs = VANTAGE_DEDUPE_HOURS * 3_600_000;
  const drmsTimes = drms.map((d) => d.at.getTime()).sort((a, b) => a - b);
  const near = (t: number) => drmsTimes.some((d) => Math.abs(d - t) <= dedupeMs);
  const extra = vantage.filter((v) => !near(v.at.getTime()));
  const all = [...drms.map((s) => ({ s, v: false })), ...extra.map((s) => ({ s, v: true }))].sort((a, b) => a.s.at.getTime() - b.s.at.getTime());

  const total = (s: MeterSnapshot) => (s.black ?? 0) + (s.colour ?? 0);
  const out: { s: MeterSnapshot; v: boolean }[] = [];
  for (let i = 0; i < all.length; i++) {
    const cur = all[i]!;
    if (cur.v) {
      const prev = out[out.length - 1];
      const next = all.slice(i + 1).find((x) => !x.v);
      if ((prev && total(cur.s) < total(prev.s)) || (next && total(cur.s) > total(next.s))) continue;
    }
    out.push(cur);
  }
  return out.map((x) => x.s);
}

/** Snapshots to the meter series for one colour, oldest first, dropping snapshots that lack a meter. */
export function meterPointsFor(colour: YieldColour, isColour: boolean, snaps: MeterSnapshot[]): YieldMeterPoint[] {
  const out: YieldMeterPoint[] = [];
  for (const s of snaps) {
    const value = pageMeterValue(colour, isColour, s);
    if (value !== null) out.push({ at: s.at, value });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Longest gap between the two readings either side of a date that may still be interpolated across. */
export const INTERPOLATE_MAX_DAYS = 45;

export interface MeterAt {
  value: number;
  /** True when interpolated between two readings; false for an exact or fallback reading. */
  estimated: boolean;
  before: YieldMeterPoint | null;
  after: YieldMeterPoint | null;
}

/**
 * The meter at `t`: an exact reading; else a linear interpolation between the newest reading before and
 * the oldest after when they are at most {@link INTERPOLATE_MAX_DAYS} apart (value rounded, `estimated`);
 * else the newest before; else the oldest after if within {@link METER_LOOKAHEAD_DAYS}; else null.
 * `before`/`after` are the readings used. `points` must be oldest first.
 */
export function meterAt(points: YieldMeterPoint[], t: Date): MeterAt | null {
  const ms = t.getTime();
  let before: YieldMeterPoint | null = null;
  let after: YieldMeterPoint | null = null;
  for (const p of points) {
    if (p.at.getTime() <= ms) before = p;
    else {
      after = p;
      break;
    }
  }
  if (before && before.at.getTime() === ms) return { value: before.value, estimated: false, before, after: null };
  // A reading that goes down across the bracket is a reset or device swap: nothing to interpolate.
  if (before && after && after.value >= before.value) {
    const span = after.at.getTime() - before.at.getTime();
    if (span <= INTERPOLATE_MAX_DAYS * DAY_MS) {
      const value = Math.round(before.value + ((after.value - before.value) * (ms - before.at.getTime())) / span);
      return { value, estimated: true, before, after };
    }
  }
  if (before) return { value: before.value, estimated: false, before, after: null };
  if (after && after.at.getTime() - ms <= METER_LOOKAHEAD_DAYS * DAY_MS) {
    return { value: after.value, estimated: false, before: null, after };
  }
  return null;
}

const qty = (q: number | null): number => (q !== null && Number.isFinite(q) && q >= 1 ? Math.round(q) : 1);

/**
 * Cartridge deliveries oldest first with the pages each one did. Lines on the same order date are one
 * delivery (several lines the same day cannot be told apart in the meter, and a cancelled-and-reissued
 * order would otherwise count as a cartridge that did 0 pages). Pages are not measurable (null) when
 * either end has no meter, when both ends rest on the same readings (no data between the deliveries),
 * or when the meter went down (reset or device swap).
 */
export function buildCartridges(events: DeliveryEvent[], points: YieldMeterPoint[]): CartridgeInterval[] {
  const sorted = [...events].sort((a, b) => a.orderDate.getTime() - b.orderDate.getTime() || a.lineId - b.lineId);
  const groups: Omit<CartridgeInterval, 'pagesDone' | 'pagesPerCartridge'>[] = [];
  for (const e of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.orderDate.getTime() === e.orderDate.getTime()) {
      last.quantity += qty(e.quantity);
      last.lineIds.push(e.lineId);
      if (e.fitDate && (last.anchor.getTime() === last.orderDate.getTime() || e.fitDate < last.anchor)) last.anchor = e.fitDate;
    } else {
      groups.push({ orderDate: e.orderDate, anchor: e.fitDate ?? e.orderDate, salesOrderId: e.salesOrderId, lineId: e.lineId, lineIds: [e.lineId], quantity: qty(e.quantity) });
    }
  }
  return groups.map((g, i) => {
    const next = groups[i + 1];
    let pagesDone: number | null = null;
    if (next) {
      const a = meterAt(points, g.anchor);
      const b = meterAt(points, next.anchor);
      // Same bracketing readings at both ends = no reading between the deliveries.
      if (a && b && !(a.before === b.before && a.after === b.after) && b.value >= a.value) pagesDone = b.value - a.value;
    }
    return { ...g, pagesDone, pagesPerCartridge: pagesDone === null ? null : pagesDone / g.quantity };
  });
}

/** Total pages over total cartridges for the most recent `max` measurable cartridges. */
export function averageAchieved(
  cartridges: CartridgeInterval[],
  max: number = MAX_CARTRIDGES_FOR_AVERAGE,
): { avg: number | null; counted: number } {
  const measurable = cartridges.filter((c) => c.pagesDone !== null);
  // Whole deliveries are never split, so a quantity-2 delivery can push the count past `max`.
  const picked: CartridgeInterval[] = [];
  let counted = 0;
  for (let i = measurable.length - 1; i >= 0 && counted < max; i--) {
    picked.push(measurable[i]!);
    counted += measurable[i]!.quantity;
  }
  if (picked.length === 0) return { avg: null, counted: 0 };
  const pages = picked.reduce((s, c) => s + c.pagesDone!, 0);
  return { avg: pages / counted, counted };
}

/** `value / rated` or null when either is unknown or rated is not positive. */
export const pctOf = (value: number | null, rated: number | null): number | null =>
  value === null || rated === null || rated <= 0 ? null : value / rated;

/** Under-yielding needs a rated yield and at least {@link MIN_CARTRIDGES_FOR_UNDER_YIELD} measured cartridges. */
export function isUnderYielding(avgPct: number | null, counted: number): boolean | null {
  if (avgPct === null || counted < MIN_CARTRIDGES_FOR_UNDER_YIELD) return null;
  return avgPct < UNDER_YIELD_PCT_THRESHOLD;
}

/** Early: no previous delivery is never early; unknown pages or rated yield is unknown (null). */
export function isEarly(hasLastOrder: boolean, pctSince: number | null): boolean | null {
  if (!hasLastOrder) return false;
  return pctSince === null ? null : pctSince < EARLY_PCT_THRESHOLD;
}

/** Stale when there is no snapshot, or the newest is older than {@link STALE_SNAPSHOT_DAYS} at `now`. */
export function isStale(latestAt: Date | null, now: Date): boolean {
  return latestAt === null || now.getTime() - latestAt.getTime() > STALE_SNAPSHOT_DAYS * DAY_MS;
}

export interface ColourYield {
  colour: YieldColour;
  ratedYield: number | null;
  status: YieldStatus;
  cartridges: CartridgeInterval[];
  avgAchieved: number | null;
  avgPctOfRated: number | null;
  /** Cartridges behind `avgAchieved`. */
  cartridgesCounted: number;
  underYielding: boolean | null;
  lastOrderDate: Date | null;
  pagesSinceLastOrder: number | null;
  /** `pagesSinceLastOrder` starts from an interpolated meter (show "~"). */
  pagesSinceEstimated: boolean;
  pctOfRatedSinceLastOrder: number | null;
  early: boolean | null;
  stale: boolean;
}

/** All the arithmetic for one device + colour. `points` come from {@link meterPointsFor}. */
export function computeColourYield(args: {
  colour: YieldColour;
  ratedYield: number | null;
  events: DeliveryEvent[];
  points: YieldMeterPoint[];
  stale: boolean;
}): ColourYield {
  const { colour, ratedYield, events, points, stale } = args;
  const cartridges = buildCartridges(events, points);
  const { avg, counted } = averageAchieved(cartridges);
  const avgPct = pctOf(avg, ratedYield);

  const last = cartridges[cartridges.length - 1] ?? null;
  let pagesSince: number | null = null;
  let pagesSinceEstimated = false;
  if (last) {
    const base = meterAt(points, last.anchor);
    const current = points[points.length - 1];
    // No reading after the fit (the order date, or the Delivery that fitted it) means we can't tell how much it has printed: unknown, not 0.
    if (base && current && current.at.getTime() > last.anchor.getTime() && current.value >= base.value) {
      pagesSince = current.value - base.value;
      pagesSinceEstimated = base.estimated;
    }
  }
  const pctSince = pctOf(pagesSince, ratedYield);
  return {
    colour,
    ratedYield,
    status: ratedYield === null ? 'no_rated_yield' : 'ok',
    cartridges,
    avgAchieved: avg,
    avgPctOfRated: avgPct,
    cartridgesCounted: counted,
    underYielding: isUnderYielding(avgPct, counted),
    lastOrderDate: last?.orderDate ?? null,
    pagesSinceLastOrder: pagesSince,
    pagesSinceEstimated,
    pctOfRatedSinceLastOrder: pctSince,
    early: isEarly(last !== null, pctSince),
    stale,
  };
}

/** Colours a device is tracked for: all five on a colour device, black and waste on mono. */
export const yieldColoursFor = (isColour: boolean): YieldColour[] => (isColour ? [...REPLENISH_COLOURS] : ['black', 'waste']);

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

export interface DeviceInput {
  drmsEquipmentId: string;
  vantageEquipmentId: number | null;
  isColour: boolean;
  modelName: string | null;
  serial: string | null;
  customerName: string | null;
  familyId: number | null;
  familyName: string | null;
  rated: Record<YieldColour, number | null>;
  events: Map<YieldColour, DeliveryEvent[]>;
  /** Toner Delivery alarm times per colour (oldest first, one per cartridge change): each is a cartridge fitted. */
  deliveries: Map<YieldColour, Date[]>;
  /** DRMS snapshots merged with Vantage readings (or DRMS only when Vantage is switched off). */
  snapshots: MeterSnapshot[];
  /** How many of `snapshots` came from Vantage only. */
  vantageOnlySnapshots: number;
}

const isYieldColour = (c: string | null): c is YieldColour => c !== null && (REPLENISH_COLOURS as readonly string[]).includes(c);

/** Devices (with their active Vantage link and cartridge family), delivery events and meter snapshots. */
export async function loadYieldInputs(db: Db, drmsIds: string[] | null, opts: { requireLink?: boolean; vantageMeters?: boolean } = {}): Promise<Map<string, DeviceInput>> {
  const out = new Map<string, DeviceInput>();
  if (drmsIds !== null && drmsIds.length === 0) return out;

  const f = cartridgeFamilies;
  const deviceRows = await db
    .select({
      drmsEquipmentId: drmsEquipment.drmsId,
      vantageEquipmentId: deviceLinks.vantageEquipmentId,
      isColour: drmsEquipment.isColour,
      modelName: drmsEquipment.modelName,
      serial: drmsEquipment.serial,
      customerName: sql<string | null>`coalesce(${drmsEquipment.customerName}, ${vantageEquipment.customerName})`,
      familyId: f.id,
      familyName: f.name,
      black: f.ratedYieldBlack,
      cyan: f.ratedYieldCyan,
      magenta: f.ratedYieldMagenta,
      yellow: f.ratedYieldYellow,
      waste: f.ratedYieldWaste,
    })
    .from(drmsEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(cartridgeFamilyModels, eq(cartridgeFamilyModels.model, drmsEquipment.modelName))
    .leftJoin(f, eq(f.id, cartridgeFamilyModels.familyId))
    .where(
      and(
        drmsIds === null ? undefined : inArray(drmsEquipment.drmsId, drmsIds),
        opts.requireLink ? isNotNull(deviceLinks.vantageEquipmentId) : undefined,
      ),
    );
  for (const r of deviceRows) {
    out.set(r.drmsEquipmentId, {
      drmsEquipmentId: r.drmsEquipmentId,
      vantageEquipmentId: r.vantageEquipmentId,
      isColour: r.isColour,
      modelName: r.modelName,
      serial: r.serial,
      customerName: r.customerName,
      familyId: r.familyId,
      familyName: r.familyName,
      rated: { black: r.black, cyan: r.cyan, magenta: r.magenta, yellow: r.yellow, waste: r.waste },
      events: new Map(),
      deliveries: new Map(),
      snapshots: [],
      vantageOnlySnapshots: 0,
    });
  }
  if (out.size === 0) return out;

  // Delivery events, by the Vantage equipment each device is linked to.
  const byVantage = new Map<number, DeviceInput>();
  for (const d of out.values()) if (d.vantageEquipmentId !== null) byVantage.set(d.vantageEquipmentId, d);
  if (byVantage.size > 0) {
    const equipmentOf = sql<number>`coalesce(${vantageSalesOrderLines.vantageEquipmentId}, ${vantageSalesOrders.vantageEquipmentId})`;
    const lines = await db
      .select({
        equipmentId: equipmentOf,
        colour: vantageSalesOrderLines.colour,
        lineId: vantageSalesOrderLines.vantageId,
        salesOrderId: vantageSalesOrderLines.salesOrderId,
        quantity: vantageSalesOrderLines.quantity,
        orderDate: vantageSalesOrders.orderDate,
      })
      .from(vantageSalesOrderLines)
      .innerJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, vantageSalesOrderLines.salesOrderId))
      .where(
        and(
          isNull(vantageSalesOrders.deletedDate),
          isNull(vantageSalesOrderLines.returnedDate),
          isNotNull(vantageSalesOrders.orderDate),
          inArray(vantageSalesOrderLines.colour, [...REPLENISH_COLOURS]),
          inArray(equipmentOf, [...byVantage.keys()]),
        ),
      )
      .orderBy(asc(vantageSalesOrders.orderDate), asc(vantageSalesOrderLines.vantageId));
    for (const l of lines) {
      const dev = byVantage.get(Number(l.equipmentId));
      if (!dev || !isYieldColour(l.colour) || !l.orderDate) continue;
      const q = l.quantity === null ? null : Number(l.quantity);
      const list = dev.events.get(l.colour) ?? [];
      list.push({ orderDate: l.orderDate, salesOrderId: l.salesOrderId, lineId: l.lineId, quantity: q !== null && Number.isFinite(q) ? q : null });
      dev.events.set(l.colour, list);
    }
  }

  // Toner Delivery alarms (any DRMS status) say a cartridge was fitted: they give each order its fit date.
  const deliveryRows = await db
    .select({ drmsId: deviceAlarms.drmsEquipmentId, at: deviceAlarms.receivedTime, description: deviceAlarms.description })
    .from(deviceAlarms)
    .where(and(inArray(deviceAlarms.drmsEquipmentId, [...out.keys()]), deliveryAlarmSql()))
    .orderBy(asc(deviceAlarms.receivedTime));
  for (const r of deliveryRows) {
    const colour = deliveryColour(r.description);
    const dev = out.get(r.drmsId);
    if (!colour || !dev) continue;
    dev.deliveries.set(colour, [...(dev.deliveries.get(colour) ?? []), r.at]);
  }
  for (const dev of out.values()) {
    for (const [colour, times] of dev.deliveries) dev.deliveries.set(colour, dedupeDeliveries(times));
    for (const [colour, events] of dev.events) {
      const dates = [...new Set(events.map((e) => e.orderDate.getTime()))].sort((a, b) => a - b).map((t) => new Date(t));
      const fits = deliveryFitDates(dates, dev.deliveries.get(colour) ?? []);
      const fitOf = new Map(dates.map((dt, i) => [dt.getTime(), fits[i] ?? null]));
      dev.events.set(colour, events.map((e) => ({ ...e, fitDate: fitOf.get(e.orderDate.getTime()) ?? null })));
    }
  }

  // Meter snapshots: one row per snapshot, the two meters pivoted.
  const rows = await db
    .select({
      drmsEquipmentId: counterSnapshots.drmsEquipmentId,
      snapshotId: counterSnapshots.id,
      at: counterSnapshots.receivedTime,
      name: counterValues.name,
      value: counterValues.value,
    })
    .from(counterValues)
    .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
    .where(
      and(
        inArray(counterValues.name, [BLACK_METER, COLOUR_METER]),
        isNotNull(counterSnapshots.receivedTime),
        inArray(counterSnapshots.drmsEquipmentId, [...out.keys()]),
      ),
    )
    .orderBy(asc(counterSnapshots.receivedTime), asc(counterSnapshots.id));
  const snaps = new Map<number, MeterSnapshot & { drmsId: string }>();
  for (const r of rows) {
    if (!r.at) continue;
    let s = snaps.get(r.snapshotId);
    if (!s) {
      s = { drmsId: r.drmsEquipmentId, at: r.at, black: null, colour: null };
      snaps.set(r.snapshotId, s);
    }
    if (r.name === BLACK_METER) s.black = r.value;
    else s.colour = r.value;
  }
  for (const s of snaps.values()) out.get(s.drmsId)?.snapshots.push({ at: s.at, black: s.black, colour: s.colour });

  // Vantage meter readings (last 24 months, `vantage-meters` job), by the linked Vantage equipment.
  if (opts.vantageMeters !== false && byVantage.size > 0) {
    const readings = await db
      .select({
        equipmentId: vantageMeterReadings.vantageEquipmentId,
        at: vantageMeterReadings.readingAt,
        typeId: vantageMeterReadings.meterTypeId,
        value: vantageMeterReadings.reading,
      })
      .from(vantageMeterReadings)
      .where(inArray(vantageMeterReadings.vantageEquipmentId, [...byVantage.keys()]))
      .orderBy(asc(vantageMeterReadings.readingAt));
    const byEquipment = new Map<number, VantageMeterPoint[]>();
    for (const r of readings) {
      const list = byEquipment.get(r.equipmentId) ?? [];
      list.push(r);
      byEquipment.set(r.equipmentId, list);
    }
    for (const [equipmentId, points] of byEquipment) {
      const dev = byVantage.get(equipmentId);
      if (!dev) continue;
      const merged = mergeSnapshots(dev.snapshots, vantageSnapshots(points));
      dev.vantageOnlySnapshots = merged.length - dev.snapshots.length;
      dev.snapshots = merged;
    }
  }
  return out;
}

export interface DeviceYield {
  drmsEquipmentId: string;
  vantageEquipmentId: number | null;
  isColour: boolean;
  modelName: string | null;
  serial: string | null;
  customerName: string | null;
  familyId: number | null;
  familyName: string | null;
  /** Newest meter snapshot (either meter); null when the device has none. */
  latestSnapshotAt: Date | null;
  stale: boolean;
  colours: ColourYield[];
}

function computeDevice(d: DeviceInput, now: Date): DeviceYield {
  const latest = d.snapshots.reduce<Date | null>((m, s) => (m === null || s.at > m ? s.at : m), null);
  const stale = isStale(latest, now);
  return {
    drmsEquipmentId: d.drmsEquipmentId,
    vantageEquipmentId: d.vantageEquipmentId,
    isColour: d.isColour,
    modelName: d.modelName,
    serial: d.serial,
    customerName: d.customerName,
    familyId: d.familyId,
    familyName: d.familyName,
    latestSnapshotAt: latest,
    stale,
    colours: yieldColoursFor(d.isColour).map((colour) =>
      computeColourYield({
        colour,
        ratedYield: d.rated[colour],
        events: d.events.get(colour) ?? [],
        points: meterPointsFor(colour, d.isColour, d.snapshots),
        stale,
      }),
    ),
  };
}

/** Every linked device's yield; `vantageMeters: false` gives the DRMS-snapshots-only figures for comparison. */
export async function getFleetYields(db: Db, now: Date = new Date(), opts: { vantageMeters?: boolean } = {}): Promise<DeviceYield[]> {
  const inputs = await loadYieldInputs(db, null, { requireLink: true, vantageMeters: opts.vantageMeters });
  return [...inputs.values()].map((i) => computeDevice(i, now));
}

/** Per-colour yield for one DRMS device; null when the device does not exist. */
export async function getDeviceYield(db: Db, drmsEquipmentId: string, now: Date = new Date()): Promise<DeviceYield | null> {
  const dev = (await loadYieldInputs(db, [drmsEquipmentId])).get(drmsEquipmentId);
  return dev ? computeDevice(dev, now) : null;
}

export interface YieldCheck {
  colour: YieldColour;
  lastOrderDate: Date | null;
  pagesSinceLastOrder: number | null;
  /** `pagesSinceLastOrder` starts from an interpolated meter (show "~"). */
  pagesSinceEstimated: boolean;
  /** Pages since the last order as a share of the rated yield (1 = a full cartridge). */
  pctOfRated: number | null;
  ratedYield: number | null;
  early: boolean | null;
  stale: boolean;
  status: YieldStatus;
}

/**
 * The early-request check for review-queue rows: proposal id to the device/colour's last order and
 * pages since. A proposal whose device does not exist, or whose colour the device is not tracked for
 * (cyan on a mono device), is left out. A proposal already closed by its own sales-order line does
 * not count that line as the "last order".
 */
export async function getYieldCheckForProposals(db: Db, proposalIds: number[], now: Date = new Date()): Promise<Map<number, YieldCheck>> {
  const out = new Map<number, YieldCheck>();
  if (proposalIds.length === 0) return out;
  const p = replenishmentProposals;
  const props = await db
    .select({ id: p.id, drmsEquipmentId: p.drmsEquipmentId, colour: p.colour, lineId: p.vantageSalesOrderLineId })
    .from(p)
    .where(inArray(p.id, proposalIds));
  const devices = await loadYieldInputs(db, [...new Set(props.map((r) => r.drmsEquipmentId))]);
  for (const r of props) {
    const input = devices.get(r.drmsEquipmentId);
    if (!input || !yieldColoursFor(input.isColour).includes(r.colour)) continue;
    const stale = isStale(input.snapshots.reduce<Date | null>((m, s) => (m === null || s.at > m ? s.at : m), null), now);
    const c = computeColourYield({
      colour: r.colour,
      ratedYield: input.rated[r.colour],
      events: (input.events.get(r.colour) ?? []).filter((e) => r.lineId === null || e.lineId !== r.lineId),
      points: meterPointsFor(r.colour, input.isColour, input.snapshots),
      stale,
    });
    out.set(r.id, {
      colour: c.colour,
      lastOrderDate: c.lastOrderDate,
      pagesSinceLastOrder: c.pagesSinceLastOrder,
      pagesSinceEstimated: c.pagesSinceEstimated,
      pctOfRated: c.pctOfRatedSinceLastOrder,
      ratedYield: c.ratedYield,
      early: c.early,
      stale: c.stale,
      status: c.status,
    });
  }
  return out;
}

export interface UnderYieldingRow {
  drmsEquipmentId: string;
  customerName: string | null;
  serial: string | null;
  model: string | null;
  family: string | null;
  colour: YieldColour;
  ratedYield: number;
  avgAchieved: number;
  avgPctOfRated: number;
  cartridgesCounted: number;
  lastOrderDate: Date | null;
  stale: boolean;
}

export const YIELD_SORT_KEYS = ['customer', 'serial', 'model', 'family', 'colour', 'achieved', 'cartridges', 'lastOrder'] as const;
export type YieldSortKey = (typeof YIELD_SORT_KEYS)[number];

const YIELD_SORT: Record<YieldSortKey, (r: UnderYieldingRow) => SortValue> = {
  customer: (r) => r.customerName,
  serial: (r) => r.serial,
  model: (r) => r.model,
  family: (r) => r.family,
  colour: (r) => r.colour,
  achieved: (r) => r.avgPctOfRated,
  cartridges: (r) => r.cartridgesCounted,
  lastOrder: (r) => r.lastOrderDate,
};

/** The rows in the chosen order (device then colour as tiebreak, blanks last); no sort is worst first, same tiebreak. */
export function sortUnderYielding(rows: UnderYieldingRow[], sort?: SortSpec<YieldSortKey>): UnderYieldingRow[] {
  const id = (r: UnderYieldingRow) => `${r.drmsEquipmentId}:${r.colour}`;
  // The default (worst first) breaks ties on the same id as a chosen sort, so pages never overlap.
  const worstFirst = (a: UnderYieldingRow, b: UnderYieldingRow) =>
    a.avgPctOfRated - b.avgPctOfRated || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
  return [...rows].sort(compareBy(YIELD_SORT, sort, id, worstFirst));
}

/** Fleet list of device/colours flagged under-yielding, worst first. */
export async function listUnderYielding(db: Db, now: Date = new Date(), sort?: SortSpec<YieldSortKey>): Promise<UnderYieldingRow[]> {
  const inputs = await loadYieldInputs(db, null, { requireLink: true });
  const rows: UnderYieldingRow[] = [];
  for (const input of inputs.values()) {
    if (input.events.size === 0) continue;
    const d = computeDevice(input, now);
    for (const c of d.colours) {
      if (c.underYielding !== true || c.ratedYield === null || c.avgAchieved === null || c.avgPctOfRated === null) continue;
      rows.push({
        drmsEquipmentId: d.drmsEquipmentId,
        customerName: d.customerName,
        serial: d.serial,
        model: d.modelName,
        family: d.familyName,
        colour: c.colour,
        ratedYield: c.ratedYield,
        avgAchieved: c.avgAchieved,
        avgPctOfRated: c.avgPctOfRated,
        cartridgesCounted: c.cartridgesCounted,
        lastOrderDate: c.lastOrderDate,
        stale: c.stale,
      });
    }
  }
  return sortUnderYielding(rows, sort);
}
