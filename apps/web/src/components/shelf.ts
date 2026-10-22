import { RECOUNT_DAYS, REPLENISH_COLOURS, type ReplenishColour, type ShelfConsumableCounts } from '@mps/core';
import type { Tone } from './toner';
import { CONSUMABLE_LABELS, familyCarries } from '../lib/family-fields';

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
  after_recount_days: `counted, more than ${RECOUNT_DAYS} days since the last`,
  repeat: 'repeat, not counted',
  before_counting_start: 'before this shelf existed, not counted',
};

/** An event's outcome as the shelf page's log prints it. */
export function eventOutcome(event: { counted: boolean; reason: string }): string {
  return REASONS[event.reason] ?? (event.counted ? 'counted' : 'not counted');
}

/** What the alarm was, from the consumable it counted against: `Toner Empty (black)`, `Waste toner bottle full`. */
export function eventAlarmText(colour: ReplenishColour | null): string {
  if (colour === null) return 'Alarm';
  return colour === 'waste' ? 'Waste toner bottle full' : `Toner Empty (${colour})`;
}
