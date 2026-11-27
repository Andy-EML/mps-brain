import { LOW_LEVEL, RISE_LEVEL } from './cartridge-change';

/** A rise of at least this many points between consecutive readings means a cartridge was fitted. */
export const FIT_JUMP_POINTS = 30;
/** Pages since the order below this share of rated yield x quantity: probably not fitted. */
export const LOW_YIELD_HOLD_PCT = 0.5;
/** Pages since the order at or above this share of rated yield x quantity: never held. */
export const SAFETY_NET_PCT = 1;

export type HoldReason = 'not_fitted' | 'low_yield';

export interface HoldInput {
  colour: 'black' | 'cyan' | 'magenta' | 'yellow';
  lastOrder: { anchor: Date; orderDate: Date; reference: string | null; quantity: number } | null;
  /** That colour's DRMS level readings, any order. */
  levels: { at: Date; value: number }[];
  /** Pages since lastOrder.orderDate; null = not measurable. */
  pagesSince: number | null;
  pagesSinceEstimated: boolean;
  ratedYield: number | null;
  metersStale: boolean;
  /** Toner Delivery alarms for this colour on or after the order date: each is a cartridge fitted. Absent = none known. */
  deliveryFits?: number;
}

export interface HoldDecision {
  reason: HoldReason;
  detail: string;
}

/**
 * Count cartridge fits seen in the level readings after the anchor: a low reading later followed
 * by a rise to RISE_LEVEL, or a jump of FIT_JUMP_POINTS between consecutive readings. The last
 * reading at or before the anchor seeds the state, so a jump spanning the anchor counts.
 */
export function countFits(levels: { at: Date; value: number }[], anchor: Date): number {
  const sorted = [...levels].sort((a, b) => a.at.getTime() - b.at.getTime());
  let prev: number | null = null;
  let low = false;
  let rising = false; // just counted a fit; a staged rise is the same fill
  let fits = 0;
  for (const r of sorted) {
    if (r.at.getTime() <= anchor.getTime()) {
      prev = r.value;
      low = r.value <= LOW_LEVEL;
      continue;
    }
    if (prev !== null && r.value < prev) rising = false;
    if (prev !== null && r.value - prev >= FIT_JUMP_POINTS) {
      if (!rising) fits++;
      rising = true;
      low = false;
    } else if (low && r.value >= RISE_LEVEL) {
      fits++;
      rising = true;
      low = false;
    }
    if (r.value <= LOW_LEVEL) low = true;
    prev = r.value;
  }
  return fits;
}

const dateParts = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: 'Europe/London',
});
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2 Apr 2026" in Europe/London; fixed month names because ICU renders September as "Sept". */
function formatDate(d: Date): string {
  const p = Object.fromEntries(dateParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${Number(p.day)} ${SHORT_MONTHS[Number(p.month) - 1]} ${p.year}`;
}
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'Europe/London' });
const num = (n: number) => n.toLocaleString('en-GB');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Should a toner proposal be held because the last cartridge sent for the colour was probably never fitted? */
export function decideHold(input: HoldInput): HoldDecision | null {
  const { lastOrder, colour } = input;
  if (!lastOrder) return null;
  const quantity = lastOrder.quantity;
  // A Delivery alarm is DRMS saying a cartridge went in, which the level readings may have missed.
  const fits = Math.max(countFits(input.levels, lastOrder.anchor), input.deliveryFits ?? 0);
  if (fits >= quantity) return null;

  const full = input.ratedYield !== null ? input.ratedYield * quantity : null;
  const date = formatDate(lastOrder.orderDate);
  const spansAnchor = input.levels.some((l) => l.at.getTime() <= lastOrder.anchor.getTime());

  if (spansAnchor) {
    if (input.pagesSince !== null && full && input.pagesSince >= SAFETY_NET_PCT * full) return null;
    const ref = lastOrder.reference ? ` (${lastOrder.reference})` : '';
    const left = quantity - fits;
    const detail =
      quantity > 1
        ? `${quantity} ${colour} sent ${date}${ref}, ${fits} fitted since — ${left === 1 ? 'spare should' : `${left} spares should`} be on site`
        : `${cap(colour)} sent ${date}${ref}, no new cartridge seen since — spare should be on site`;
    return { reason: 'not_fitted', detail };
  }

  if (full === null || input.pagesSince === null || input.metersStale) return null;
  if (input.pagesSince >= LOW_YIELD_HOLD_PCT * full) return null;
  const pct = Math.round((input.pagesSince / full) * 100);
  const approx = input.pagesSinceEstimated ? '~' : '';
  const sent = quantity > 1 ? `${quantity} ${colour}` : colour;
  const month = monthFmt.format(lastOrder.orderDate);
  const noun = quantity > 1 ? 'cartridges' : 'cartridge';
  return {
    reason: 'low_yield',
    detail: `${approx}${num(input.pagesSince)} pages since ${sent} sent ${date} (${pct}% of ${num(full)}) — ${month} ${noun} probably not fitted`,
  };
}
