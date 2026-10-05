import type { ReplenishColour } from '@mps/core';
import type { PagesSince, QueueProposal } from '@mps/db/queries';
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
  key: number;
  colour: ReplenishColour;
  letter: string;
  /** `1%`; null for waste, which DRMS never reports a level for, or when no reading exists. */
  levelText: string | null;
  /** Raised by a DRMS consumable alarm rather than the level threshold. */
  alarm: boolean;
  /** Accessible name and tooltip: `Cyan 1% (DRMS alarm)`. */
  label: string;
}

/** One chip per proposed colour, K C M Y then waste, with the newest known level. */
export function reviewChips(proposals: readonly QueueProposal[]): ReviewChip[] {
  return [...proposals]
    .sort((a, b) => ORDER[a.colour] - ORDER[b.colour])
    .map((p) => {
      const level = p.colour === 'waste' ? null : (p.currentLevel ?? p.level);
      const levelText = level === null ? null : formatPercent(level);
      const alarm = p.trigger === 'alarm';
      const label = [colourLabel(p.colour), levelText].filter(Boolean).join(' ') + (alarm ? ' (DRMS alarm)' : '');
      return { key: p.id, colour: p.colour, letter: LETTER[p.colour], levelText, alarm, label };
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
