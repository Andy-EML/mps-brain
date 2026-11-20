import { isOrderColour, type OrderColour, type ReplenishColour } from '@mps/core';
import type { Db } from '../client';
import { getDevice, listDeviceAlarms, listDeviceOrders } from './device';
import { loadYieldInputs, meterAt, meterPointsFor, type MeterSnapshot, type YieldMeterPoint } from './toner-yield';

/**
 * The detail panel behind one row of the `/orders` Review tab, loaded when the row is first opened.
 * Read-only, and composed from the device page's own queries so the two pages never disagree.
 */

export type ReviewTonerColour = Exclude<ReplenishColour, 'waste'>;

export type PagesSince =
  /** `estimated`: the meter at the order date was interpolated between two readings (show "~"). */
  | { kind: 'pages'; pages: number; estimated: boolean; orderDate: Date; baselineAt: Date; currentAt: Date }
  /** No meter at the order date, or nothing read since it. */
  | { kind: 'no-reading'; orderDate: Date }
  /** The meter is lower now than at the order: it was reset or the device swapped. */
  | { kind: 'meter-reset'; orderDate: Date }
  /** That colour never went out on this device (or it is not linked to Vantage). */
  | { kind: 'no-order' };

/** A toner/waste line (shown as a colour chip), or anything else on the order as its text. */
export type ReviewOrderLine =
  | { kind: 'toner'; colour: OrderColour; quantity: number | null }
  /** `text` is the line's Details, else its item description, else its part number. */
  | { kind: 'other'; text: string; quantity: number | null };

export interface ReviewOrder {
  vantageId: number;
  reference: string | null;
  orderDate: Date | null;
  open: boolean;
  /** Every line on the order, in Vantage's order, returned lines left out. */
  lines: ReviewOrderLine[];
}

export interface ReviewAlarm {
  alarmId: string;
  receivedTime: Date;
  description: string | null;
  category: string | null;
  totalCount: number | null;
  totalColorCount: number | null;
}

/** The latest reading of one meter; null when the newest snapshot did not carry it. */
export interface ReviewMeter {
  key: 'black' | 'colour' | 'scan';
  value: number | null;
}

export interface ReviewDeviceDetail {
  drmsId: string;
  isColour: boolean;
  /** K, then C/M/Y on a colour device, then waste — which DRMS never reports a level for. */
  levels: { colour: ReplenishColour; level: number | null }[];
  lastReadingAt: Date | null;
  /** No reading, or the newest is older than `STALE_READING_DAYS`. */
  readingStale: boolean;
  /** Black and scan always; colour only on a colour device, which is the only kind that has one. */
  meters: ReviewMeter[];
  orders: ReviewOrder[];
  alarms: ReviewAlarm[];
  /** Black always; cyan, magenta and yellow only on a colour device. */
  pagesSince: Partial<Record<ReviewTonerColour, PagesSince>>;
}

const DAY = 86_400_000;
export const STALE_READING_DAYS = 3;
const ALARM_DAYS = 30;
const ALARM_CATEGORIES = ['toner', 'waste', 'parts'];
/** The last few Vantage sales orders of any kind — toner, parts, service. */
const ORDER_COUNT = 6;
/** Alarms scanned for page-count readings (all categories), newest first. */
const ALARM_READING_LIMIT = 1000;

/**
 * Pages printed since an order: the newest reading minus the meter at the order date, which is the
 * toner-yield line's own `meterAt` (exact, interpolated across a gap of 45 days or less, else the
 * nearest reading). Nothing read since the order is unknown, not zero, and a negative difference is a
 * meter reset, never a page count.
 */
export function pagesSinceOrder(points: readonly YieldMeterPoint[], orderDate: Date | null): PagesSince {
  if (orderDate === null) return { kind: 'no-order' };
  const sorted = [...points].sort((x, y) => x.at.getTime() - y.at.getTime());
  const base = meterAt(sorted, orderDate);
  const current = sorted[sorted.length - 1];
  if (!base || !current || current.at.getTime() <= orderDate.getTime()) return { kind: 'no-reading', orderDate };
  const pages = current.value - base.value;
  if (pages < 0) return { kind: 'meter-reset', orderDate };
  const baselineAt = (base.before ?? base.after)!.at;
  return { kind: 'pages', pages, estimated: base.estimated, orderDate, baselineAt, currentAt: current.at };
}

/**
 * One colour's readings, oldest first: the merged DRMS + Vantage snapshots (the toner-yield line's own
 * series, `meterPointsFor`) plus the page counts DRMS puts on each alarm, mapped the same way: cyan,
 * magenta and yellow are the colour count; black is the total count (black + colour pages).
 */
export function meterPoints(input: {
  snapshots: MeterSnapshot[];
  alarms: readonly { receivedTime: Date; totalCount: number | null; totalColorCount: number | null }[];
  isColour: boolean;
  colour: ReviewTonerColour;
}): YieldMeterPoint[] {
  const points = meterPointsFor(input.colour, input.isColour, input.snapshots);
  for (const a of input.alarms) {
    const value = input.colour === 'black' ? a.totalCount : a.totalColorCount;
    if (value !== null && Number.isFinite(value)) points.push({ at: a.receivedTime, value });
  }
  return points.sort((x, y) => x.at.getTime() - y.at.getTime());
}

/** The words for a non-toner line, in the same order as the device page's order history. */
function lineLabel(line: { details: string | null; itemDescription: string | null; itemPartNumber: string | null }): string {
  for (const candidate of [line.details, line.itemDescription, line.itemPartNumber]) {
    if (candidate != null && candidate.trim() !== '') return candidate.trim();
  }
  return 'Unnamed line';
}

function reviewLine(line: {
  colour: string | null;
  quantity: number | null;
  details: string | null;
  itemDescription: string | null;
  itemPartNumber: string | null;
}): ReviewOrderLine {
  if (isOrderColour(line.colour)) return { kind: 'toner', colour: line.colour, quantity: line.quantity };
  return { kind: 'other', text: lineLabel(line), quantity: line.quantity };
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

  const meters: ReviewMeter[] = [
    { key: 'black', value: device.meters.black },
    ...(isColour ? [{ key: 'colour' as const, value: device.meters.colour }] : []),
    { key: 'scan', value: device.meters.scan },
  ];

  const reviewOrders: ReviewOrder[] = (orders?.orders ?? []).slice(0, ORDER_COUNT).map((o) => ({
    vantageId: o.vantageId,
    reference: o.reference,
    orderDate: o.orderDate,
    open: o.open,
    lines: o.lines.filter((l) => l.returnedDate === null).map(reviewLine),
  }));

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

  const snapshots = (await loadYieldInputs(db, [drmsId])).get(drmsId)?.snapshots ?? [];
  const pagesSince: ReviewDeviceDetail['pagesSince'] = {};
  for (const c of tonerColours) {
    pagesSince[c] = pagesSinceOrder(meterPoints({ snapshots, alarms, isColour, colour: c }), orders?.lastByColour[c]?.orderDate ?? null);
  }

  return {
    drmsId,
    isColour,
    levels,
    lastReadingAt,
    readingStale,
    meters,
    orders: reviewOrders,
    alarms: reviewAlarms,
    pagesSince,
  };
}
