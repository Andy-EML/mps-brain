import { SettingsError, type BoardCard, type BoardColumn, type LeftDueReason } from '@mps/db/queries';

/**
 * The `/pm/planner` board's forms (Move to…, Remove) and display helpers. Pure. A refusal throws
 * `SettingsError('invalid_pm_action')`, the code the `/pm` forms use, so the planner actions share
 * `pmErrorKey` / `pmErrorMessage`. Moving to Booked is not a move: it goes through the Mark-booked
 * form (`parseBookedForm`) because Booked is derived from the PM action it writes.
 */

export type MovableColumn = 'to_plan' | 'asked' | 'done';

const MOVABLE: readonly string[] = ['to_plan', 'asked', 'done'] satisfies MovableColumn[];
const NOTE_MAX = 500;
const PLANNER = '/pm/planner';

function text(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : null;
}

function bad(): never {
  throw new SettingsError('That PM action is not valid — check the form and try again.', 'invalid_pm_action');
}

function id(raw: string | null): number {
  if (raw === null || !/^\d{1,10}$/.test(raw) || Number(raw) < 1) bad();
  return Number(raw);
}

/** Move to… : `vantageEquipmentId`, `to` (`to_plan` / `asked` / `done`), `note` (optional, blank -> null, at most 500). */
export function parseMoveForm(fd: FormData): { vantageEquipmentId: number; to: MovableColumn; note: string | null } {
  const vantageEquipmentId = id(text(fd, 'vantageEquipmentId'));
  const to = text(fd, 'to');
  if (to === null || !MOVABLE.includes(to)) bad();
  const note = text(fd, 'note') || null;
  if (note !== null && note.length > NOTE_MAX) bad();
  return { vantageEquipmentId, to: to as MovableColumn, note };
}

export function parseRemoveForm(fd: FormData): { vantageEquipmentId: number } {
  return { vantageEquipmentId: id(text(fd, 'vantageEquipmentId')) };
}

/** A throwaway origin to resolve the posted path against; never shown or followed. */
const BASE = 'http://planner.invalid';

/**
 * Where a planner form goes back to: the posted `/pm/planner` URL with its query (the hash dropped).
 * Anything else — another page, another host, `//host`, a path that only resolves to the planner
 * via `..` — gives the bare `/pm/planner`.
 */
export function plannerReturnHref(raw: FormDataEntryValue | string | null): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return PLANNER;
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.length > 1000) return PLANNER;
  // The path as written (before any `..` is resolved) must be the planner itself.
  const path = raw.split(/[?#]/, 1)[0];
  if (path !== PLANNER) return PLANNER;
  try {
    const url = new URL(raw, BASE);
    if (url.origin !== BASE || url.pathname !== PLANNER) return PLANNER;
    return `${PLANNER}${url.search}`;
  } catch {
    return PLANNER;
  }
}

/**
 * The redirect after a planner action: back to the posted planner URL, scrolled to the card
 * (`#card-<id>`). A refusal adds `card=<id>&plannerError=<key>` so the card shows the sentence;
 * earlier ones are dropped either way.
 */
export function plannerRedirectHref(raw: FormDataEntryValue | string | null, card: number | null, errorKey?: string): string {
  const url = new URL(plannerReturnHref(raw), BASE);
  const params = url.searchParams;
  params.delete('card');
  params.delete('plannerError');
  if (errorKey) {
    if (card !== null) params.set('card', String(card));
    params.set('plannerError', errorKey);
  }
  const query = params.toString();
  return `${PLANNER}${query ? `?${query}` : ''}${card !== null ? `#card-${card}` : ''}`;
}

const LEFT_DUE: Record<LeftDueReason, string> = {
  other_dealer: 'Other dealer — no longer ours',
  dismissed: 'Dismissed',
  left_contract: 'No longer on an active contract',
  not_due: 'No longer due',
};

/**
 * The card's one reason badge: why it left the due set (it stays on the board until removed), else
 * how long ago a stale Asked card was asked, else the card's own reason ("Booked visit not seen").
 */
export function reasonBadgeText(card: Pick<BoardCard, 'leftDue' | 'reason' | 'askedDays' | 'askedStale'>): string | null {
  if (card.leftDue !== null) return LEFT_DUE[card.leftDue];
  if (card.askedStale && card.askedDays !== null) return `Asked ${card.askedDays} ${card.askedDays === 1 ? 'day' : 'days'} ago`;
  return card.reason;
}

/**
 * A group header: `GU14 · 5 due · 2 overdue · 1 priority`. Done cards are not due: they are counted
 * as `n done` and left out of overdue and priority. Zero counts are left off (a group always has a
 * card, so there is at least one count).
 */
export function groupSummary(label: string, cards: (Pick<BoardCard, 'overdueMonths' | 'priority'> & { column: BoardColumn })[]): string {
  const open = cards.filter((c) => c.column !== 'done');
  const parts = [
    [open.length, 'due'],
    [open.filter((c) => c.overdueMonths !== null).length, 'overdue'],
    [open.filter((c) => c.priority).length, 'priority'],
    [cards.length - open.length, 'done'],
  ] as const;
  return [label, ...parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`)].join(' · ');
}
