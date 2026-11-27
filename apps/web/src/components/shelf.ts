import { RECOUNT_DAYS, REPLENISH_COLOURS, type ReplenishColour, type ShelfConsumableCounts } from '@mps/core';
import type { Tone } from './toner';
import { CONSUMABLE_LABELS, familyCarries } from '../lib/family-fields';
import { safeReturnPath } from '../lib/device-origin';
import { hrefWith } from '../lib/href';

const SITE_STOCK = '/site-stock';
const ORDERS = '/orders';
/**
 * What a shelf page's `back` may name: the Site stock list view, a customer page (or list), or a
 * Toner orders view — plus a device page (`DEVICE_PAGE`), whose shelf badge and card link here.
 */
const SHELF_BACK_BASES = [SITE_STOCK, '/customers', ORDERS] as const;
/** A device page path; its id is a DRMS id, percent-encoded as `deviceHref` builds it. */
const DEVICE_PAGE = /^\/devices\/[A-Za-z0-9._~%-]{1,200}$/;

/** `back` when it is somewhere a shelf page may return to, other than another shelf page. */
function shelfBack(back: unknown): string | null {
  const kept = safeReturnPath(back, SHELF_BACK_BASES, [DEVICE_PAGE]);
  return kept !== null && !kept.startsWith(`${SITE_STOCK}/`) ? kept : null;
}

/**
 * The shelf page. `back` is the page it was opened from — the Site stock list view (search, page,
 * sort, rows), a customer page, a Toner orders view or a device page — kept when it adds something, for the shelf page's breadcrumb.
 */
export function shelfHref(shelfId: number, back?: string): string {
  const kept = back != null && back !== SITE_STOCK ? shelfBack(back) : null;
  return hrefWith(`${SITE_STOCK}/${shelfId}`, { back: kept });
}

/** The shelf page's breadcrumb root: where `back` says it was opened from, else Site stock. */
export function shelfBackLink(back: unknown): { label: string; href: string } {
  const kept = shelfBack(back);
  if (kept === null) return { label: 'Site stock', href: SITE_STOCK };
  if (kept.startsWith('/customers/')) return { label: 'Customer', href: kept };
  if (kept.startsWith('/customers')) return { label: 'Customers', href: kept };
  if (kept.startsWith('/devices/')) return { label: 'Device', href: kept };
  if (kept === ORDERS || kept.startsWith(`${ORDERS}?`)) return { label: 'Toner orders', href: kept };
  return { label: 'Site stock', href: kept };
}

/**
 * The pure helpers behind the site stock pages: the used / held pills, a shelf's status, which
 * consumables a shelf takes off normal replenishment, and an Empty's counted / not counted reason
 * in plain words. No database imports, so client components can use them too.
 */

/** One letter per consumable, as the mockup's pills print them. */
export const CONSUMABLE_LETTERS: Record<ReplenishColour, string> = { black: 'K', cyan: 'C', magenta: 'M', yellow: 'Y', waste: 'W' };

/**
 * `full` — the last spare has gone in (used has reached a holding above 0), so the shelf gets
 * topped up; `holding` — spares left; `not_held` — the shelf keeps none of this consumable.
 */
export type PillState = 'full' | 'holding' | 'not_held';

export function pillState(holding: number, used: number): PillState {
  if (holding <= 0) return 'not_held';
  return used >= holding ? 'full' : 'holding';
}

/** The consumables a shelf of this family can hold: all five, or black and waste for mono. */
export function shelfColours(isColour: boolean): ReplenishColour[] {
  return REPLENISH_COLOURS.filter((c) => familyCarries(isColour, c));
}

export interface ShelfPill {
  colour: ReplenishColour;
  /** `K 3/3` */
  text: string;
  /** For hover and screen readers: `Black: 3 of 3 spares used, last one in`. */
  label: string;
  state: PillState;
}

interface Counted {
  isColour: boolean;
  holding: ShelfConsumableCounts;
  used: ShelfConsumableCounts;
}

/**
 * The list's pills: one per consumable the family carries that is held, or not held but with a
 * used count (only a manual correction can leave one), so nothing on the tally is hidden.
 */
export function shelfPills({ isColour, holding, used }: Counted): ShelfPill[] {
  return shelfColours(isColour)
    .filter((c) => holding[c] > 0 || used[c] > 0)
    .map((c) => {
      const state = pillState(holding[c], used[c]);
      return {
        colour: c,
        text: `${CONSUMABLE_LETTERS[c]} ${used[c]}/${holding[c]}`,
        label: `${CONSUMABLE_LABELS[c]}: ${used[c]} of ${holding[c]} spares used${state === 'full' ? ', last one in' : ''}`,
        state,
      };
    });
}

/** A live (pending or approved) top-up means one is on its way; otherwise the shelf is holding. */
export function shelfStatus(liveTopUp: boolean): { text: string; tone: Tone } {
  return liveTopUp ? { text: 'Top-up proposed', tone: 'critical' } : { text: 'Holding', tone: 'ok' };
}

/** The consumables the shelf covers: held (> 0), so they get no normal proposals on its machines. */
export function coveredColours(isColour: boolean, holding: ShelfConsumableCounts): ReplenishColour[] {
  return shelfColours(isColour).filter((c) => holding[c] > 0);
}

/** `black, cyan and waste toner`. */
export function coveredColoursText(colours: readonly ReplenishColour[]): string {
  const words = colours.map((c) => CONSUMABLE_LABELS[c].toLowerCase());
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const REASONS: Record<string, string> = {
  first: 'counted, first one from this machine',
  fresh_cartridge: 'counted, a fresh cartridge went in since the last',
  level_rise: 'counted, a fresh cartridge went in',
  delivery: 'counted, a new cartridge was delivered',
  same_change: 'same cartridge change as the last, not counted',
  delivery_same_change: 'same cartridge change as the last, not counted',
  after_recount_days: `counted, more than ${RECOUNT_DAYS} days since the last`,
  repeat: 'repeat, not counted',
  before_counting_start: 'before this shelf existed, not counted',
};

/** An event's outcome as the shelf page's log prints it. */
export function eventOutcome(event: { counted: boolean; reason: string }): string {
  return REASONS[event.reason] ?? (event.counted ? 'counted' : 'not counted');
}

/**
 * What the alarm was, from the consumable it counted against: `Toner Empty (black)`, `Waste toner
 * bottle full`. A use seen as a toner level rise (reason `level_rise`, no alarm) says so instead.
 */
export function eventAlarmText(colour: ReplenishColour | null, reason?: string): string {
  if (reason === 'level_rise') return colour === null ? 'Toner level rise' : `Toner level rise (${colour})`;
  if (reason === 'delivery' || reason === 'delivery_same_change') {
    return colour === null ? 'Toner Delivery' : colour === 'waste' ? 'Waste toner bottle delivery' : `Toner Delivery (${colour})`;
  }
  if (colour === null) return 'Alarm';
  return colour === 'waste' ? 'Waste toner bottle full' : `Toner Empty (${colour})`;
}
