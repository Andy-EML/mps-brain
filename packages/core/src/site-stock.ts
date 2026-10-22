/**
 * Site stock: a shelf of spare cartridges held at a customer site. DRMS "empty" alarms say a
 * cartridge was used; this decides which alarms count as a new use (the same empty cartridge
 * keeps alarming until it is swapped) and what to top the shelf up with. Pure — no I/O.
 */
import { REPLENISH_COLOURS, type ReplenishColour, type TonerColour } from './replenishment';

/** (agreed) A toner level at or above this since the previous use means a fresh cartridge went in. */
export const FRESH_CARTRIDGE_LEVEL = 80;
/** (agreed) With no level readings to go on, a repeat alarm this many days on counts as a new use. */
export const RECOUNT_DAYS = 14;
/** (agreed) A shelf holds, and a top-up orders, at most this many of one consumable. */
export const MAX_HOLDING = 20;

const DAY_MS = 86_400_000;

/** A count per consumable — shelf holdings, or what has been used since the last top-up. */
export type ShelfConsumableCounts = Record<ReplenishColour, number>;

const EMPTY_COLOUR: Record<string, TonerColour> = { K: 'black', BK: 'black', C: 'cyan', M: 'magenta', Y: 'yellow' };

/**
 * The consumable a DRMS alarm says has been used up: "Toner Empty(K)" or "Waste Toner Bottle Full".
 * The warnings ("Toner Near Empty", "Waste Toner Bottle Almost Full") are not uses.
 */
export function siteStockUse(description: string | null): ReplenishColour | null {
  if (!description) return null;
  const toner = /(?<!near\s)\bToner Empty\((BK|K|C|M|Y)\)/i.exec(description);
  if (toner) return EMPTY_COLOUR[toner[1]!.toUpperCase()] ?? null;
  if (/(?<!almost\s)\bWaste Toner Bottle Full\b/i.test(description)) return 'waste';
  return null;
}

export interface PriorUse {
  receivedAt: Date;
}

export interface LevelPoint {
  at: Date;
  value: number;
}

export type CountReason = 'before_counting_start' | 'first' | 'fresh_cartridge' | 'after_recount_days' | 'repeat';

/**
 * Whether an empty alarm is a new use of a shelf cartridge. `levelsSincePrevious` holds only the
 * readings strictly after `previous.receivedAt` (the caller filters); waste has no level.
 */
export function countUse(args: {
  colour: ReplenishColour;
  receivedAt: Date;
  countingFrom: Date;
  previous: PriorUse | null;
  levelsSincePrevious: LevelPoint[];
}): { counted: boolean; reason: CountReason } {
  const { colour, receivedAt, countingFrom, previous, levelsSincePrevious } = args;
  if (receivedAt < countingFrom) return { counted: false, reason: 'before_counting_start' };
  if (!previous) return { counted: true, reason: 'first' };

  const isWaste = colour === 'waste';
  if (!isWaste && levelsSincePrevious.some((p) => p.value >= FRESH_CARTRIDGE_LEVEL)) {
    return { counted: true, reason: 'fresh_cartridge' };
  }
  const longEnough = receivedAt.getTime() - previous.receivedAt.getTime() >= RECOUNT_DAYS * DAY_MS;
  if (longEnough && (isWaste || levelsSincePrevious.length === 0)) {
    return { counted: true, reason: 'after_recount_days' };
  }
  return { counted: false, reason: 'repeat' };
}

/**
 * The top-up order for a shelf. Nothing until some colour the shelf holds is used up
 * (`used >= holding`); then every held colour that has been used at all is topped up by what was used.
 */
export function topUpLines(
  holding: ShelfConsumableCounts,
  used: ShelfConsumableCounts,
): { colour: ReplenishColour; quantity: number }[] {
  const triggered = REPLENISH_COLOURS.some((c) => holding[c] > 0 && used[c] >= holding[c]);
  if (!triggered) return [];
  return REPLENISH_COLOURS.filter((c) => holding[c] > 0 && used[c] > 0).map((colour) => ({
    colour,
    quantity: Math.min(used[colour], MAX_HOLDING),
  }));
}
