import type { OrderColour, ReplenishColour } from '@mps/core';
import type { PagesSince, QueueDevice, QueueProposal, ReviewOrderLine } from '@mps/db/queries';
// Relative, not `@/…`: Vitest has no `@/` alias and this module is unit-tested.
import { formatDate, formatNumber, formatPercent } from '../lib/format';
import { colourLabel } from './replenishment';

/**
 * Pure helpers for the collapsed rows of the `/orders` Review tab. Free of JSX so they can be
 * unit-tested without a DOM.
 */

/** Mirrors `MAX_ORDER_QUANTITY` in `@mps/db` (not imported: that module is server-side). */
export const MAX_QUANTITY = 20;

export function clampQuantity(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_QUANTITY, Math.max(1, Math.round(n))) : 1;
}

const ORDER: Record<ReplenishColour, number> = { black: 0, cyan: 1, magenta: 2, yellow: 3, waste: 4 };
const LETTER: Record<ReplenishColour, string> = { black: 'K', cyan: 'C', magenta: 'M', yellow: 'Y', waste: 'W' };

export interface ReviewChip {
  key: ReplenishColour;
  colour: ReplenishColour;
  letter: string;
  /** `1%`, or `—` when there is no reading; null for waste, which DRMS never reports a level for. */
  levelText: string | null;
  /** The colour has a proposal on this row (the chip is emphasised). */
  proposed: boolean;
  /** Raised by a DRMS consumable alarm rather than the level threshold. */
  alarm: boolean;
  /** Accessible name and tooltip: `Cyan 1% (proposed, DRMS alarm)`. */
  label: string;
}

const TONERS = ['black', 'cyan', 'magenta', 'yellow'] as const;

/**
 * One chip per cartridge the device has — K on a mono device (`is_colour` false), K C M Y on a
 * colour one — with its latest level, plus a waste chip only when waste is proposed. Proposed
 * colours are flagged, and an alarm-raised proposal carries the bell. A proposed colour without a
 * current reading falls back to the level at proposal time.
 */
export function reviewChips(
  device: Pick<QueueDevice, 'isColour' | 'tonerLevels' | 'proposals'>,
): ReviewChip[] {
  const byColour = new Map<ReplenishColour, QueueProposal>();
  for (const p of device.proposals) if (!byColour.has(p.colour) || p.trigger === 'alarm') byColour.set(p.colour, p);
  const colours = new Set<ReplenishColour>(device.isColour ? TONERS : ['black']);
  for (const c of byColour.keys()) colours.add(c);

  return [...colours]
    .sort((a, b) => ORDER[a] - ORDER[b])
    .map((colour) => {
      const p = byColour.get(colour);
      const level = colour === 'waste' ? null : (device.tonerLevels[colour] ?? p?.level ?? null);
      const levelText = colour === 'waste' ? null : level === null ? '—' : formatPercent(level);
      const proposed = p !== undefined;
      const alarm = p?.trigger === 'alarm';
      const levelLabel = colour === 'waste' ? null : level === null ? 'no reading' : levelText;
      const notes = [proposed ? 'proposed' : null, alarm ? 'DRMS alarm' : null].filter(Boolean);
      const label =
        [colourLabel(colour), levelLabel].filter(Boolean).join(' ') + (notes.length ? ` (${notes.join(', ')})` : '');
      return { key: colour, colour, letter: LETTER[colour], levelText, proposed, alarm, label };
    });
}

/**
 * The fields the row's "Approve all" form posts to `approveAction`: every proposal of the device,
 * each at its current quantity — the same shape as the per-line Approve selected form.
 */
export function approveAllFields(drmsId: string, proposals: readonly QueueProposal[]): [string, string][] {
  const fields: [string, string][] = [['drmsId', drmsId]];
  for (const p of proposals) {
    fields.push(['proposalId', String(p.id)], [`qty-${p.id}`, String(clampQuantity(p.quantity))]);
  }
  return fields;
}

/** `12,345 pages since 1 Aug 2026`, or why there is no count. */
export function pagesSinceText(p: PagesSince): string {
  switch (p.kind) {
    case 'pages':
      return `${formatNumber(p.pages)} ${p.pages === 1 ? 'page' : 'pages'} since ${formatDate(p.orderDate)}`;
    case 'no-reading':
      return `no reading at order time (${formatDate(p.orderDate)})`;
    case 'meter-reset':
      return `meter reset? (ordered ${formatDate(p.orderDate)})`;
    case 'no-order':
      return 'no previous order';
  }
}

/** Longest non-toner line text printed in the Review panel's order list; the hover has the rest. */
const LINE_TEXT_MAX = 60;
/** Non-toner lines printed per order; an order with more says how many it left out. */
const OTHER_LINES_MAX = 3;

export interface ReviewOrderLines {
  /** Toner and waste lines, drawn as colour chips. */
  toner: { colour: OrderColour; quantity: number | null }[];
  /** Everything else (parts, service, staples…): short text, with the full text for the hover. */
  other: { text: string; title: string }[];
  /** Non-toner lines not printed. */
  hidden: number;
}

/** One recent sales order's lines, as the Review panel prints them. */
export function reviewOrderLines(lines: readonly ReviewOrderLine[]): ReviewOrderLines {
  const toner: ReviewOrderLines['toner'] = [];
  const other: ReviewOrderLines['other'] = [];
  let hidden = 0;
  for (const line of lines) {
    if (line.kind === 'toner') {
      toner.push({ colour: line.colour, quantity: line.quantity });
      continue;
    }
    if (other.length === OTHER_LINES_MAX) {
      hidden += 1;
      continue;
    }
    const qty = line.quantity !== null && line.quantity > 1 ? ` ×${formatNumber(line.quantity)}` : '';
    const short = line.text.length > LINE_TEXT_MAX ? `${line.text.slice(0, LINE_TEXT_MAX - 1).trimEnd()}…` : line.text;
    other.push({ text: `${short}${qty}`, title: `${line.text}${qty}` });
  }
  return { toner, other, hidden };
}
