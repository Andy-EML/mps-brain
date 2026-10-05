import { isOrderColour, type OrderColour, type ReplenishColour } from '@mps/core';
import type { Db } from '../client';
import { getCounterHistory, getDevice, listDeviceAlarms, listDeviceOrders } from './device';
import { METER_NAMES } from './shared';

/**
 * The detail panel behind one row of the `/orders` Review tab, loaded when the row is first opened.
 * Read-only, and composed from the device page's own queries so the two pages never disagree.
 */

export type ReviewTonerColour = Exclude<ReplenishColour, 'waste'>;

export interface MeterPoint {
  at: Date;
  value: number;
}

export type PagesSince =
  | { kind: 'pages'; pages: number; orderDate: Date; baselineAt: Date; currentAt: Date }
  /** No meter reading within `PAGES_SINCE_WINDOW_DAYS` before the order date. */
  | { kind: 'no-reading'; orderDate: Date }
  /** The meter is lower now than at the order: it was reset or the device swapped. */
  | { kind: 'meter-reset'; orderDate: Date }
  /** That colour never went out on this device (or it is not linked to Vantage). */
  | { kind: 'no-order' };

export interface ReviewOrder {
  vantageId: number;
  reference: string | null;
  orderDate: Date | null;
  open: boolean;
  /** The order's toner/waste lines only, returned lines left out. */
  lines: { colour: OrderColour; quantity: number | null }[];
}

export interface ReviewAlarm {
  alarmId: string;
  receivedTime: Date;
  description: string | null;
  category: string | null;
  totalCount: number | null;
  totalColorCount: number | null;
}

export interface ReviewDeviceDetail {
  drmsId: string;
  isColour: boolean;
  /** K, then C/M/Y on a colour device, then waste — which DRMS never reports a level for. */
  levels: { colour: ReplenishColour; level: number | null }[];
  lastReadingAt: Date | null;
  /** No reading, or the newest is older than `STALE_READING_DAYS`. */
  readingStale: boolean;
  orders: ReviewOrder[];
  alarms: ReviewAlarm[];
  /** Black always; cyan, magenta and yellow only on a colour device. */
  pagesSince: Partial<Record<ReviewTonerColour, PagesSince>>;
}

const DAY = 86_400_000;
export const PAGES_SINCE_WINDOW_DAYS = 45;
export const STALE_READING_DAYS = 3;
const ALARM_DAYS = 30;
const ALARM_CATEGORIES = ['toner', 'waste', 'parts'];
const ORDER_COUNT = 6;
/** Alarms scanned for page-count readings (all categories), newest first. */
const ALARM_READING_LIMIT = 1000;

/**
 * Pages printed since an order: the newest reading minus the nearest reading on or before the
 * order date. A reading more than `windowDays` before the order says nothing about the order, and
 * a negative difference is a meter reset, never a page count.
 */
export function pagesSinceOrder(
  points: readonly MeterPoint[],
  orderDate: Date | null,
  windowDays = PAGES_SINCE_WINDOW_DAYS,
): PagesSince {
  if (orderDate === null) return { kind: 'no-order' };
  const order = orderDate.getTime();
  let baseline: MeterPoint | null = null;
  let current: MeterPoint | null = null;
  for (const p of points) {
    const at = p.at.getTime();
    if (current === null || at > current.at.getTime()) current = p;
    if (at <= order && at >= order - windowDays * DAY && (baseline === null || at > baseline.at.getTime())) baseline = p;
  }
  if (baseline === null || current === null) return { kind: 'no-reading', orderDate };
  const pages = current.value - baseline.value;
  if (pages < 0) return { kind: 'meter-reset', orderDate };
  return { kind: 'pages', pages, orderDate, baselineAt: baseline.at, currentAt: current.at };
}

/**
 * One meter's readings, oldest first: the stored counter history plus the page counts DRMS puts on
 * each alarm. An alarm's `total_count` covers every page, so on a colour device black is the total
 * less the colour count (the same split as `Black:Total` / `Full Color:Total`).
 */
export function meterPoints(input: {
  counters: { black: readonly MeterPoint[]; colour: readonly MeterPoint[] };
  alarms: readonly { receivedTime: Date; totalCount: number | null; totalColorCount: number | null }[];
  isColour: boolean;
  meter: 'black' | 'colour';
}): MeterPoint[] {
  const points: MeterPoint[] = [...input.counters[input.meter]];
  for (const a of input.alarms) {
    let value: number | null;
    if (input.meter === 'colour') value = a.totalColorCount;
    else if (a.totalCount === null) value = null;
    else value = input.isColour ? (a.totalColorCount === null ? null : a.totalCount - a.totalColorCount) : a.totalCount;
    if (value !== null && Number.isFinite(value)) points.push({ at: a.receivedTime, value });
  }
  return points.sort((x, y) => x.at.getTime() - y.at.getTime());
}

export async function getReviewDeviceDetail(db: Db, drmsId: string, now: Date = new Date()): Promise<ReviewDeviceDetail | null> {
  const detail = await getDevice(db, drmsId);
  if (!detail) return null;
  const { device } = detail;
  const isColour = device.isColour;
  const vantageId = detail.link.vantageEquipmentId;

  const [orders, alarms] = await Promise.all([
    vantageId === null ? null : listDeviceOrders(db, vantageId, { limit: 200 }),
    listDeviceAlarms(db, drmsId, { limit: ALARM_READING_LIMIT }),
  ]);

  const tonerColours: ReviewTonerColour[] = isColour ? ['black', 'cyan', 'magenta', 'yellow'] : ['black'];
  const levels: ReviewDeviceDetail['levels'] = [
    ...tonerColours.map((colour) => ({ colour, level: device.toner[colour] })),
    { colour: 'waste' as const, level: null },
  ];

  const lastReadingAt = detail.latestSnapshotAt ?? device.lastCounterAt;
  const readingStale = lastReadingAt === null || now.getTime() - lastReadingAt.getTime() > STALE_READING_DAYS * DAY;

  const reviewOrders: ReviewOrder[] = [];
  for (const o of orders?.orders ?? []) {
    const lines = o.lines
      .filter((l) => l.returnedDate === null && isOrderColour(l.colour))
      .map((l) => ({ colour: l.colour as OrderColour, quantity: l.quantity }));
    if (lines.length === 0) continue;
    reviewOrders.push({ vantageId: o.vantageId, reference: o.reference, orderDate: o.orderDate, open: o.open, lines });
    if (reviewOrders.length === ORDER_COUNT) break;
  }

  const since = now.getTime() - ALARM_DAYS * DAY;
  const reviewAlarms: ReviewAlarm[] = alarms
    .filter((a) => a.receivedTime.getTime() >= since && a.category !== null && ALARM_CATEGORIES.includes(a.category))
    .map((a) => ({
      alarmId: a.alarmId,
      receivedTime: a.receivedTime,
      description: a.description,
      category: a.category,
      totalCount: a.totalCount,
      totalColorCount: a.totalColorCount,
    }));

  // Only as much counter history as the oldest last-order date needs.
  const orderDates = tonerColours.map((c) => orders?.lastByColour[c]?.orderDate ?? null);
  const oldest = Math.min(...orderDates.filter((x): x is Date => x !== null).map((x) => x.getTime()));
  const pagesSince: ReviewDeviceDetail['pagesSince'] = {};
  if (!Number.isFinite(oldest)) {
    for (const c of tonerColours) pagesSince[c] = { kind: 'no-order' };
  } else {
    const days = Math.ceil((now.getTime() - oldest) / DAY) + PAGES_SINCE_WINDOW_DAYS + 1;
    const history = await getCounterHistory(db, drmsId, [METER_NAMES.black, METER_NAMES.colour], days);
    const counters = { black: history[METER_NAMES.black] ?? [], colour: history[METER_NAMES.colour] ?? [] };
    tonerColours.forEach((c, i) => {
      const meter = c === 'black' ? 'black' : 'colour';
      pagesSince[c] = pagesSinceOrder(meterPoints({ counters, alarms, isColour, meter }), orderDates[i] ?? null);
    });
  }

  return {
    drmsId,
    isColour,
    levels,
    lastReadingAt,
    readingStale,
    orders: reviewOrders,
    alarms: reviewAlarms,
    pagesSince,
  };
}
