// Types only from @mps/db: this module is used by the client planner card.
import type { BoardColumn } from '@mps/db/queries';

/**
 * The planner board's visible columns. Planned shows the stored To plan and Asked cards (an asked
 * card carries a tag), Booked the derived bookings; Done cards are not shown on the board.
 */
export type VisibleColumn = 'planned' | 'booked';

export function visibleColumnOf(c: BoardColumn): VisibleColumn | null {
  if (c === 'to_plan' || c === 'asked') return 'planned';
  if (c === 'booked') return 'booked';
  return null;
}

/** One `askNote` line: `Asked <engineer> for <day> <month>`. */
const ASK_LINE = /^Asked (.+) for (\d{1,2} [A-Za-z]{3})$/;

/**
 * The tag an asked card shows in Planned: `Asked <engineer> · <day>` from the latest
 * `Asked <engineer> for <day>` line in its note, or `Asked engineer` when there is none. Null when
 * the card is not asked.
 */
export function askedTag(card: { column: BoardColumn; note: string | null }): string | null {
  if (card.column !== 'asked') return null;
  const lines = (card.note ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = ASK_LINE.exec(lines[i]!.trim());
    if (m) return `Asked ${m[1]} · ${m[2]}`;
  }
  return 'Asked engineer';
}

/** Vantage PM jobs make the reason `Booked: PM job in Vantage…` (see `boardColumnOf`). */
const VANTAGE_BOOKED = 'Booked: PM job in Vantage';

/**
 * A Booked card whose booking was recorded here (the Mark-booked form), so *Back to Planned* can undo
 * it. A card booked by a Vantage PM job is not: that booking is Vantage's.
 */
export function isManualBooked(card: { column: BoardColumn; reason: string | null }): boolean {
  return card.column === 'booked' && !(card.reason ?? '').startsWith(VANTAGE_BOOKED);
}
