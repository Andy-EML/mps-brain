/**
 * Toner Delivery alarms. DRMS raises "Toner Delivery(X)" (and "Waste Toner Bottle Delivery") when a
 * new cartridge is fitted, so a Delivery is a fit event, not a request for stock. This module holds
 * every rule that follows from that, in one place: which alarms are Deliveries, the effective
 * toner level (the ONE helper every display and engine reads through), and which Delivery is the
 * fit of which order. Pure — no I/O.
 */
import type { ReplenishColour, TonerColour } from './replenishment';

/** A Delivery means a new cartridge went in: the level reads this until a newer reading says otherwise. */
export const DELIVERY_LEVEL = 100;
/** (default) Alarms for one colour on one device closer together than this are one cartridge change. */
export const SAME_CHANGE_DAYS = 3;
/**
 * Site-stock shelves: an Empty, a Delivery and a level rise for one colour on one device within this many
 * days are one spare used. Longer than {@link SAME_CHANGE_DAYS} because a Delivery can follow its Empty by
 * over a week (live data 2026-11-27: 386 of 456 within 3 days, 424 within 14). User chose 14.
 */
export const SHELF_SAME_CHANGE_DAYS = 14;

/**
 * Site stock: only Toner Delivery alarms received at or after this count as shelf uses. Deliveries were never
 * written to `site_stock_events` before this feature, so without a floor the first evaluate would count the
 * whole history. It is the deploy day (a constant, not a settings row: `spare_black_from` is a column and a
 * second one would need a migration; this ships index-only). Empties and level rises have their own floors.
 */
export const DELIVERY_COUNT_FROM = new Date('2026-11-27T00:00:00Z');

const DAY_MS = 86_400_000;
const BRACKET_COLOUR: Record<string, TonerColour> = { K: 'black', BK: 'black', C: 'cyan', M: 'magenta', Y: 'yellow' };

/**
 * The consumable a Delivery alarm fitted: `Toner Delivery(BK|K|C|M|Y)` or `Waste Toner Bottle
 * Delivery`, whatever the alarm's DRMS status. Null for every other alarm.
 */
export function deliveryColour(description: string | null | undefined): ReplenishColour | null {
  if (!description) return null;
  const toner = /\bToner Delivery\((BK|K|C|M|Y)\)/i.exec(description);
  if (toner) return BRACKET_COLOUR[toner[1]!.toUpperCase()] ?? null;
  if (/\bWaste Toner Bottle Delivery\b/i.test(description)) return 'waste';
  return null;
}

export const isDeliveryAlarm = (description: string | null | undefined): boolean => deliveryColour(description) !== null;

export interface EffectiveLevel {
  /** The level to show and decide on: 100 when a Delivery is newer than the reading, else the reading. */
  level: number | null;
  /** The Delivery that overrides the reading, or null when the reading stands. */
  newCartridgeAt: Date | null;
}

/**
 * THE effective toner level. When the latest Delivery alarm for the colour is newer than the latest
 * DRMS reading (or there is no reading), a new cartridge has gone in since: 100%, with the Delivery's
 * date for the "new cartridge <date>" note. Otherwise the reading stands. `readAt` is when the
 * reading was taken. The SQL mirror (`effectiveLevelSql`, @mps/db) is parity-tested against this.
 */
export function effectiveTonerLevel(args: {
  level: number | null;
  readAt: Date | null;
  deliveryAt: Date | null;
}): EffectiveLevel {
  const { level, readAt, deliveryAt } = args;
  if (deliveryAt !== null && (readAt === null || deliveryAt.getTime() > readAt.getTime())) {
    return { level: DELIVERY_LEVEL, newCartridgeAt: deliveryAt };
  }
  return { level, newCartridgeAt: null };
}

/** Delivery times, oldest first, with any within {@link SAME_CHANGE_DAYS} of the previous kept one dropped. */
export function dedupeDeliveries(times: Date[]): Date[] {
  const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
  const out: Date[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (!last || t.getTime() - last.getTime() > SAME_CHANGE_DAYS * DAY_MS) out.push(t);
  }
  return out;
}

/**
 * The fit date of each order of one colour: the first Delivery on or after the order's date and
 * before the next order's date, or null when there is none (the order date then stands). `orderDates`
 * are oldest first; several orders on one date share that date's fit. `deliveries` in any order.
 */
export function deliveryFitDates(orderDates: Date[], deliveries: Date[]): (Date | null)[] {
  const times = [...deliveries].sort((a, b) => a.getTime() - b.getTime());
  return orderDates.map((od, i) => {
    const start = od.getTime();
    // The next order on a later date; orders on the same date are one delivery.
    const next = orderDates.slice(i + 1).find((o) => o.getTime() > start);
    const end = next ? next.getTime() : Infinity;
    return times.find((t) => t.getTime() >= start && t.getTime() < end) ?? null;
  });
}

/**
 * A Delivery for the colour received at or after `alarmAt` means the cartridge named by an Empty / Near
 * Empty (or waste Full / Almost Full) alarm has since been changed, so that alarm is stale. Returns the
 * first such Delivery, or null. `deliveries` are one colour's Delivery times, any order.
 */
export function deliveryAtOrAfter(deliveries: Date[] | undefined, alarmAt: Date): Date | null {
  let hit: Date | null = null;
  for (const t of deliveries ?? []) if (t.getTime() >= alarmAt.getTime() && (hit === null || t < hit)) hit = t;
  return hit;
}
