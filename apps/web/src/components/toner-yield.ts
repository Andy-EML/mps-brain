import type { CartridgeInterval, ColourYield, YieldCheck } from '@mps/db/queries';
import { formatDate, formatNumber, formatPercent } from '../lib/format';

/**
 * Display text for toner yield (`@mps/db` `toner-yield.ts`): the one-line note beside a proposal,
 * and the cells of the device page's "Toner yield" card. Pure, so it is unit-tested.
 *
 * Rated yields are mostly not entered yet and the meter history is short, so most figures are
 * unknown. Unknown is always said in words ("not enough meter history"), never shown as 0 or blank.
 */

export const CARTRIDGE_FAMILIES_HREF = '/settings/cartridge-families';

export const NOT_ENOUGH_HISTORY = 'not enough meter history';

/** A share (0.14) as a whole percent (`14%`). */
export const sharePercent = (share: number | null): string => (share === null ? '—' : formatPercent(share * 100));

/** `3,950 pages`, `1 page`. */
const pages = (n: number): string => `${formatNumber(Math.round(n))} ${Math.round(n) === 1 ? 'page' : 'pages'}`;

export interface YieldNote {
  text: string;
  /** Pages since the last order are under half a rated cartridge. */
  early: boolean;
  stale: boolean;
}

/**
 * The note under a proposal: `Last ordered 22 Oct 2026 · 3,950 pages since (14% of 28,000)`.
 * Without a rated yield it gives the pages alone; without meter readings around the order it says
 * so. Stale meters are added at the end, since "pages since" then undercounts.
 */
export function yieldNote(check: YieldCheck): YieldNote {
  const parts: string[] = [];
  if (check.lastOrderDate === null) {
    parts.push('No earlier order on record');
  } else {
    parts.push(`Last ordered ${formatDate(check.lastOrderDate)}`);
    if (check.pagesSinceLastOrder === null) parts.push(NOT_ENOUGH_HISTORY);
    else if (check.ratedYield !== null && check.pctOfRated !== null)
      parts.push(`${pages(check.pagesSinceLastOrder)} since (${sharePercent(check.pctOfRated)} of ${formatNumber(check.ratedYield)})`);
    else parts.push(`${pages(check.pagesSinceLastOrder)} since · no rated yield`);
  }
  if (check.stale) parts.push('stale meters');
  return { text: parts.join(' · '), early: check.early === true, stale: check.stale };
}

/** The "Avg achieved" cell: `21,400 (76%)`, or why there is no figure. */
export function avgAchievedText(c: Pick<ColourYield, 'avgAchieved' | 'avgPctOfRated' | 'cartridges'>): string {
  if (c.avgAchieved !== null) {
    const avg = formatNumber(Math.round(c.avgAchieved));
    return c.avgPctOfRated === null ? avg : `${avg} (${sharePercent(c.avgPctOfRated)} of rated)`;
  }
  if (c.cartridges.length === 0) return 'No orders on record';
  // The newest cartridge is still in use; a finished one needs the order after it.
  if (c.cartridges.length === 1) return 'Needs a second order';
  return 'Not enough meter history';
}

/** The "Pages since" cell: `3,950 (14%)`, or why there is no figure. */
export function pagesSinceCell(c: Pick<ColourYield, 'lastOrderDate' | 'pagesSinceLastOrder' | 'pctOfRatedSinceLastOrder'>): string {
  if (c.lastOrderDate === null) return '—';
  if (c.pagesSinceLastOrder === null) return 'Not enough meter history';
  const n = formatNumber(Math.round(c.pagesSinceLastOrder));
  return c.pctOfRatedSinceLastOrder === null ? n : `${n} (${sharePercent(c.pctOfRatedSinceLastOrder)})`;
}

export interface CartridgeRow {
  key: string;
  orderDate: Date;
  quantity: number;
  salesOrderId: number;
  /** Pages the delivery did, `—`-free: a number, "In use · 1,200 so far", or a reason. */
  pagesText: string;
  /** Pages per cartridge, or a reason. */
  perCartridgeText: string;
  inUse: boolean;
}

/**
 * Recent cartridges newest first, at most `limit`. The newest one is still in use, so it shows the
 * pages since it went out rather than a finished count.
 */
export function cartridgeRows(
  c: Pick<ColourYield, 'cartridges' | 'pagesSinceLastOrder'>,
  limit = 8,
): CartridgeRow[] {
  const list: CartridgeInterval[] = c.cartridges;
  const rows: CartridgeRow[] = [];
  for (let i = list.length - 1; i >= 0 && rows.length < limit; i--) {
    const k = list[i]!;
    const inUse = i === list.length - 1;
    let pagesText: string;
    let perCartridgeText: string;
    if (inUse) {
      pagesText = c.pagesSinceLastOrder === null ? `In use · ${NOT_ENOUGH_HISTORY}` : `In use · ${formatNumber(Math.round(c.pagesSinceLastOrder))} so far`;
      perCartridgeText = '—';
    } else if (k.pagesDone === null) {
      pagesText = 'Not enough meter history';
      perCartridgeText = '—';
    } else {
      pagesText = formatNumber(Math.round(k.pagesDone));
      perCartridgeText = k.pagesPerCartridge === null ? '—' : formatNumber(Math.round(k.pagesPerCartridge));
    }
    rows.push({ key: `${k.salesOrderId}-${k.lineId}`, orderDate: k.orderDate, quantity: k.quantity, salesOrderId: k.salesOrderId, pagesText, perCartridgeText, inUse });
  }
  return rows;
}
