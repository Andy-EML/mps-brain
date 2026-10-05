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
export type OrderLineColourSource = 'details' | 'item' | 'none' | 'mono-device';

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

/**
 * Conservative "this line is toner" check for the mono-device fallback below: the word "toner", or
 * a KM toner part number (`TN…`/`TNP…` followed by digits, e.g. `TN330A`, `TNP90`). Deliberately
 * narrow so it never catches staples, drums, imaging units or developer, none of which say "toner"
 * or carry a `TN`/`TNP` part number.
 */
const TONER_LIKE_PATTERN = /\btoner\b|\bTNP?\d+/i;

function looksLikeToner(line: OrderLineText): boolean {
  return TONER_LIKE_PATTERN.test(line.details ?? '') || TONER_LIKE_PATTERN.test(line.itemDescription ?? '');
}

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

export interface OrderLineContext {
  /**
   * Whether the line's device is known to print in colour. `false` (known mono) enables the
   * toner-shaped fallback below; `true` or an absent/unknown value (`null`/`undefined`) never does,
   * since guessing black on a colour device could hide a genuine CMY line.
   */
  deviceIsColour?: boolean | null;
}

/**
 * Classifies one sales-order line: `Details` first, then the item description, then give up.
 *
 * Mono (black-only) toner is often described with no colour word at all — e.g. "Konica Minolta
 * 300i Toner - TN330A" — because there is only one toner colour to name. When neither text carries
 * a colour or waste word and the caller says the device is mono, a line that still looks like
 * toner (the word "toner" or a `TN…`/`TNP…` part number) is classified black, tagged with the
 * distinct `mono-device` source so it stays auditable and separate from a real `Details`/`item`
 * colour word.
 */
export function classifyOrderLine(line: OrderLineText, context?: OrderLineContext): OrderLineClassification {
  const fromDetails = detectColour(line.details);
  if (fromDetails) return { colour: fromDetails, source: 'details' };

  const fromItem = detectColour(line.itemDescription);
  if (fromItem) return { colour: fromItem, source: 'item' };

  if (context?.deviceIsColour === false && looksLikeToner(line)) {
    return { colour: 'black', source: 'mono-device' };
  }

  return { colour: 'unknown', source: 'none' };
}

export function isOrderColour(value: string | null | undefined): value is OrderColour {
  return value != null && (ORDER_COLOURS as readonly string[]).includes(value);
}
