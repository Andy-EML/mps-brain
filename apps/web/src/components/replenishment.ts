import type { ReplenishColour } from '@mps/core';
import type { OrderStatus, ProposalStatus, ProposalTrigger } from '@mps/db';
import type { EffectiveSettings, SettingSource } from '@mps/db/queries';
import type { Tone } from '@/components/toner';
// Relative, not `@/lib/format`: Vitest has no `@/` alias and this module is unit-tested.
import { formatDate } from '../lib/format';

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
  /** For a site stock top-up: the consumable whose last spare went in, and when (the proposal time). */
  colour?: ReplenishColour;
  createdAt?: Date | string | null;
}

/**
 * Why the proposal exists: `4% · below 10%`, `DRMS alarm: Toner Near Empty(C)`, or for a site
 * stock top-up `Last black spare went in 19 Oct 2026 (Reception C450i)` — `deviceName` is the
 * machine that raised it, left out when not given (the device page is that machine).
 */
export function triggerLabel(p: TriggerFields, deviceName?: string): string {
  if (p.trigger === 'site_stock') {
    const what = p.colour ? `Last ${colourLabel(p.colour).toLowerCase()} spare` : 'Last spare';
    const where = deviceName ? ` (${deviceName})` : '';
    return `${what} went in ${formatDate(p.createdAt)}${where}`;
  }
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

export interface CompactProposalText {
  /** Beside the colour name: the level now (or when proposed), `—` for none; null for a top-up. */
  level: string | null;
  /** A short tag after the level: `below threshold`, `DRMS alarm`; null for a top-up. */
  tag: string | null;
  /** The muted second line: `Threshold 15% · default setting · proposed at 2%`, the alarm text, or the top-up reason. */
  detail: string;
}

/**
 * The narrow (device page) proposal line split into short pieces, so a ~300px card can show the
 * colour and level on one line and the reason on the next instead of wrapping one long sentence a
 * word at a time. The wide `/orders` row keeps `triggerLabel` as one line.
 */
export function compactProposalText(
  p: TriggerFields & { currentLevel?: number | null; thresholdSource?: SettingSource | null },
  deviceName?: string,
): CompactProposalText {
  if (p.trigger === 'site_stock') {
    // A top-up restocks the shelf: this machine's own level says nothing about it.
    return { level: null, tag: null, detail: triggerLabel(p, deviceName) };
  }
  const now = p.currentLevel ?? p.level ?? null;
  const level = now == null ? '—' : `${Math.round(now)}%`;
  if (p.trigger === 'alarm') {
    const description = p.alarmDescription?.trim();
    return { level, tag: 'DRMS alarm', detail: description || 'Raised by a DRMS consumable alarm' };
  }
  const parts: string[] = [];
  if (p.threshold != null) parts.push(`Threshold ${p.threshold}%`);
  if (p.thresholdSource) parts.push(sourceLabel(p.thresholdSource));
  // The level when proposed only adds something once a newer reading has moved it.
  if (p.level != null && p.currentLevel != null && Math.round(p.level) !== Math.round(p.currentLevel)) {
    parts.push(`proposed at ${Math.round(p.level)}%`);
  }
  return { level, tag: p.threshold == null ? null : 'below threshold', detail: parts.join(' · ') };
}

/**
 * Where an effective setting on the device page came from, with who set it and when: `default`,
 * `customer setting · by jo, 3 Aug 2026`, `set on this device by admin, 21 Aug 2026`. The who/when
 * is the settings row's, so it is when that row last changed, not necessarily this one field.
 */
export function settingOrigin(
  source: SettingSource,
  rows: Pick<EffectiveSettings, 'deviceRow' | 'customerRow'>,
): string {
  if (source === 'default') return 'default';
  const row = source === 'device' ? rows.deviceRow : rows.customerRow;
  if (source === 'device') {
    const who = row?.updatedBy ? ` by ${row.updatedBy}` : '';
    const when = row ? `, ${formatDate(row.updatedAt)}` : '';
    return `set on this device${who}${when}`;
  }
  if (!row) return 'customer setting';
  const by = [row.updatedBy ? `by ${row.updatedBy}` : null, formatDate(row.updatedAt)].filter(Boolean).join(', ');
  return `customer setting · ${by}`;
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

/** `?error=` codes from the queue's actions (`ReplenishmentErrorCode`), as sentences. */
const DECISION_ERRORS: Record<string, string> = {
  not_pending: 'Someone else has already decided one of those proposals — the list has been refreshed.',
  unlinked: 'That device is no longer linked to Vantage equipment, so it cannot be ordered for.',
  bad_quantity: 'Quantities are whole numbers from 1 to 20.',
  mixed_devices: 'Those proposals belong to different devices. Approve one device at a time.',
  empty: 'Nothing was selected. Tick at least one cartridge first.',
  not_found: 'That order or proposal no longer exists — the list has been refreshed.',
  bad_state:
    'That order has moved on since the page loaded, or is missing something it needs (an order that exists in Vantage needs its reference).',
};

/** The sentence for an `?error=` code from the toner-order actions, on `/orders` or a device page. */
export function replenishmentErrorMessage(code: string): string {
  return DECISION_ERRORS[code] ?? 'That did not work. Refresh the page and try again.';
}

/**
 * Where an approve/reject action sends a refused decision (`?error=` is appended): the form's
 * hidden `back` says which page it sat on — the queue's review tab, its In progress tab, or the
 * device page's Replenishment card.
 */
export function decisionBackPath(back: unknown, drmsId: unknown): string {
  if (back === 'in-progress') return '/orders?tab=in-progress';
  if (back === 'device' && typeof drmsId === 'string' && drmsId !== '') return `/devices/${encodeURIComponent(drmsId)}`;
  return '/orders';
}

/** The Rejected tab's line for a superseded proposal: the engine's note says why. */
export function supersededText(note: string | null): string {
  return note ? `Superseded: ${note}` : 'Superseded';
}

const PROPOSAL_STATUS: Record<ProposalStatus, { text: string; href: string }> = {
  pending: { text: 'Awaiting review', href: '/orders' },
  approved: { text: 'Approved', href: '/orders?tab=in-progress' },
  failed: { text: 'Failed', href: '/orders?tab=in-progress' },
  ordered: { text: 'Ordered', href: '/orders?tab=ordered' },
  rejected: { text: 'Rejected', href: '/orders?tab=rejected' },
  superseded: { text: 'Superseded', href: '/orders?tab=rejected' },
};

/**
 * A proposal's status on the device page's Replenishment card, and the `/orders` tab that lists
 * it. A superseded one says why, as the Rejected tab does ("Superseded: ordered in Vantage (SO…)").
 */
export function proposalStatusLink(p: { status: ProposalStatus; note: string | null }): { text: string; href: string } {
  const entry = PROPOSAL_STATUS[p.status];
  return p.status === 'superseded' ? { ...entry, text: supersededText(p.note) } : entry;
}
