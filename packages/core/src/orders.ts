/**
 * Working out which toner a Vantage sales-order line is for.
 *
 * Vantage has no colour field: the only signal is free text. The line's `Details` is filled in even
 * when the part is the generic `MISC` (a machine another reseller supplies), so it is matched
 * first, with the expanded item's description as a fallback.
 *
 * This is a convenience for the per-colour summary on the device page and for sub-project 3's
 * duplicate check. The line's own text is always displayed verbatim, so a line this cannot classify
 * is never hidden — which is why the rules here stay conservative and give up rather than guess.
 */

export type OrderColour = 'black' | 'cyan' | 'magenta' | 'yellow' | 'waste';
export type OrderLineColour = OrderColour | 'unknown';
export type OrderLineColourSource = 'details' | 'item' | 'none';

/** The colours the device page shows a row for, in K/C/M/Y then waste order. */
export const ORDER_COLOURS: readonly OrderColour[] = ['black', 'cyan', 'magenta', 'yellow', 'waste'];

export interface OrderLineText {
  /** The line's `Details` free text. */
  details?: string | null;
  /** The expanded `Item.Description`. */
  itemDescription?: string | null;
  /**
   * The expanded `Item.PartNumber`. Accepted so callers can hand over a whole line, but never used
   * to pick a colour: real part numbers are either generic (`MISC`) or opaque (`MIN90014`), and a
   * trailing letter is not a reliable channel.
   */
  partNumber?: string | null;
}

export interface OrderLineClassification {
  colour: OrderLineColour;
  source: OrderLineColourSource;
}

/**
 * Whole-word patterns. `black` also answers to a standalone `K`/`BK`, which is why the boundaries
 * matter: without them `CMYK` and `Konica` would both read as black.
 */
const COLOUR_PATTERNS: readonly (readonly [OrderColour, RegExp])[] = [
  ['cyan', /\bcyan\b/i],
  ['magenta', /\bmagenta\b/i],
  ['yellow', /\byellow\b/i],
  ['black', /\b(?:black|bk|k)\b/i],
];

/** Waste beats any colour on the same line: "Black Waste Toner Box" is a waste bottle, not black. */
const WASTE_PATTERN = /\bwaste\b/i;

/** The earliest colour word in the text, so "Black Toner - CMYK" is black and "Magenta/Yellow" is magenta. */
function detectColour(text: string | null | undefined): OrderColour | null {
  if (text == null || text.trim() === '') return null;
  if (WASTE_PATTERN.test(text)) return 'waste';

  let best: OrderColour | null = null;
  let bestIndex = Number.POSITIVE_INFINITY;
  for (const [colour, pattern] of COLOUR_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index < bestIndex) {
      bestIndex = match.index;
      best = colour;
    }
  }
  return best;
}

/** Classifies one sales-order line: `Details` first, then the item description, then give up. */
export function classifyOrderLine(line: OrderLineText): OrderLineClassification {
  const fromDetails = detectColour(line.details);
  if (fromDetails) return { colour: fromDetails, source: 'details' };

  const fromItem = detectColour(line.itemDescription);
  if (fromItem) return { colour: fromItem, source: 'item' };

  return { colour: 'unknown', source: 'none' };
}

export function isOrderColour(value: string | null | undefined): value is OrderColour {
  return value != null && (ORDER_COLOURS as readonly string[]).includes(value);
}
