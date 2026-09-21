import type { ReplenishColour } from '@mps/core';
import type { OrderStatus, ProposalTrigger } from '@mps/db';
import type { SettingSource } from '@mps/db/queries';
import type { Tone } from '@/components/toner';

/**
 * Pure display helpers for the toner-order queue (`/orders`). Free of JSX so they can be
 * unit-tested without a DOM.
 */

const COLOUR_LABELS: Record<ReplenishColour, string> = {
  black: 'Black',
  cyan: 'Cyan',
  magenta: 'Magenta',
  yellow: 'Yellow',
  waste: 'Waste toner box',
};

/** `waste` → `Waste toner box`, as the mockup's cartridge list names it. */
export function colourLabel(colour: ReplenishColour): string {
  return COLOUR_LABELS[colour];
}

export interface TriggerFields {
  trigger: ProposalTrigger;
  level?: number | null;
  threshold?: number | null;
  alarmDescription?: string | null;
}

/** Why the proposal exists: `4% · below 10%`, or `DRMS alarm: Toner Near Empty(C)`. */
export function triggerLabel(p: TriggerFields): string {
  if (p.trigger === 'alarm') {
    const description = p.alarmDescription?.trim();
    return description ? `DRMS alarm: ${description}` : 'DRMS alarm';
  }
  const level = p.level == null ? '—' : `${Math.round(p.level)}%`;
  return p.threshold == null ? level : `${level} · below ${p.threshold}%`;
}

/** Where the effective threshold was set: `customer setting`. */
export function sourceLabel(source: SettingSource): string {
  return `${source} setting`;
}

const ORDER_TONES: Record<OrderStatus, Tone> = {
  queued: 'warn',
  submitting: 'warn',
  submitted: 'ok',
  failed: 'critical',
  uncertain: 'critical',
};

/** The badge tone for one of our orders: red when a person has to act on it. */
export function orderStatusTone(status: OrderStatus): Tone {
  return ORDER_TONES[status];
}

const ORDER_LABELS: Record<OrderStatus, string> = {
  queued: 'Queued',
  submitting: 'Sending',
  submitted: 'Ordered',
  failed: 'Failed',
  uncertain: 'Uncertain',
};

/** The badge text for one of our orders. */
export function orderStatusLabel(status: OrderStatus): string {
  return ORDER_LABELS[status];
}
