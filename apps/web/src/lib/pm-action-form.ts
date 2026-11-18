import { DEFAULT_SNOOZE_DAYS, SNOOZE_DAYS, SettingsError, londonDay, type DismissReason } from '@mps/db/queries';

/**
 * Turns the `/pm` row forms (Mark booked, Dismiss, Undo) into the arguments of `markPmBooked`,
 * `dismissPm` and `undoPmAction`. Pure. Throws `SettingsError('invalid_pm_action')`, the same code
 * as the queries, so an action handles both alike; the queries validate again.
 *
 * Fields: `vantageEquipmentId` on every form; booked — `bookedFor` (`yyyy-mm-dd`, optional),
 * `reference` (optional); dismiss — `reason`, `note` (required for `other`), `snoozeDays`
 * (30 / 90 / 180, default 90, ignored for `serviced_outside`), `servicedOn` (`yyyy-mm-dd`, only for
 * `serviced_outside`, default today in London, never in the future); undo — `actionId`.
 */

const BOOKED_PAST_DAYS = 14;
const PAST_BOOKED = 'The booked date cannot be more than 14 days in the past.';

const REASONS: readonly string[] = ['not_now', 'declined', 'serviced_outside', 'other'] satisfies DismissReason[];

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function bad(message: string): never {
  throw new SettingsError(message, 'invalid_pm_action');
}

function id(raw: string, label: string): number {
  if (!/^\d{1,10}$/.test(raw) || Number(raw) < 1) bad(`${label} is missing.`);
  return Number(raw);
}

/** A `yyyy-mm-dd` date as UTC midnight (the shape a `date` column reads back as); null when blank. */
function day(raw: string): Date | null {
  if (raw === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) bad('Enter the date as a calendar date.');
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) bad('Enter the date as a calendar date.');
  return d;
}

export interface BookedForm {
  vantageEquipmentId: number;
  bookedFor: Date | null;
  reference: string | null;
}

export function parseBookedForm(formData: FormData, now: Date = new Date()): BookedForm {
  const vantageEquipmentId = id(text(formData, 'vantageEquipmentId'), 'The machine');
  const bookedFor = day(text(formData, 'bookedFor'));
  if (bookedFor && bookedFor.getTime() < new Date(`${londonDay(now)}T00:00:00Z`).getTime() - BOOKED_PAST_DAYS * 86_400_000) {
    bad(PAST_BOOKED);
  }
  return {
    vantageEquipmentId,
    bookedFor,
    reference: text(formData, 'reference') || null,
  };
}

export interface DismissForm {
  vantageEquipmentId: number;
  reason: DismissReason;
  note: string | null;
  /** Undefined for `serviced_outside`, which resets the clock instead of snoozing. */
  snoozeDays: number | undefined;
  servicedOn: Date | null;
}

export function parseDismissForm(formData: FormData, now: Date = new Date()): DismissForm {
  const vantageEquipmentId = id(text(formData, 'vantageEquipmentId'), 'The machine');
  const reasonRaw = text(formData, 'reason');
  if (!REASONS.includes(reasonRaw)) bad('Pick a reason for dismissing this machine.');
  const reason = reasonRaw as DismissReason;
  const note = text(formData, 'note') || null;
  if (reason === 'other' && note === null) bad('Add a note when the reason is Other.');

  if (reason === 'serviced_outside') {
    const today = londonDay(now);
    const servicedOn = day(text(formData, 'servicedOn')) ?? new Date(`${today}T00:00:00Z`);
    if (servicedOn.toISOString().slice(0, 10) > today) bad('The service date cannot be in the future.');
    return { vantageEquipmentId, reason, note, snoozeDays: undefined, servicedOn };
  }

  const snoozeRaw = text(formData, 'snoozeDays');
  const snoozeDays = snoozeRaw === '' ? DEFAULT_SNOOZE_DAYS : Number(snoozeRaw);
  if (!(SNOOZE_DAYS as readonly number[]).includes(snoozeDays)) bad('Snooze for 30, 90 or 180 days.');
  return { vantageEquipmentId, reason, note, snoozeDays, servicedOn: null };
}

export function parseUndoForm(formData: FormData): { actionId: number; vantageEquipmentId: number } {
  return {
    actionId: id(text(formData, 'actionId'), 'The action'),
    vantageEquipmentId: id(text(formData, 'vantageEquipmentId'), 'The machine'),
  };
}

/**
 * Where an action sends the browser back to: the `/pm` list URL the form came from (its tab,
 * filters and page), with `open=<machine>` so the row stays open and `pmError=<code>` on failure.
 * Anything that is not a same-site `/pm` URL is dropped, so the field cannot redirect elsewhere.
 */
export function pmReturnHref(raw: FormDataEntryValue | string | null, open: number, error?: string): string {
  const base = 'http://pm.invalid';
  let params = new URLSearchParams();
  if (typeof raw === 'string' && raw.startsWith('/')) {
    try {
      const url = new URL(raw, base);
      if (url.origin === base && url.pathname === '/pm') params = url.searchParams;
    } catch {
      // Unparseable: start from a bare /pm.
    }
  }
  params.delete('open');
  params.delete('pmError');
  params.set('open', String(open));
  if (error) params.set('pmError', error);
  return `/pm?${params.toString()}`;
}

/**
 * Row errors carried as `?pmError=<key>`: a fixed key, never the message itself, so a hand-made URL
 * cannot put arbitrary text in the page. `pmErrorKey` turns a refusal into its key, keyed on the
 * `SettingsError` messages this module and `dismissPm` throw (same wording); `save_failed` is any
 * other error (the database, say).
 */
const PM_ERRORS = {
  invalid_pm_action: 'That PM action is not valid — check the form and try again.',
  bad_date: 'Enter the date as a calendar date.',
  future_date: 'The service date cannot be in the future.',
  past_booked: PAST_BOOKED,
  note_required: 'Add a note when the reason is Other.',
  snooze: 'Snooze for 30, 90 or 180 days.',
  reason: 'Pick a reason for dismissing this machine.',
  save_failed: 'Couldn’t save — try again.',
} as const;

export type PmErrorKey = keyof typeof PM_ERRORS;

export function pmErrorKey(err: unknown): PmErrorKey {
  if (!(err instanceof SettingsError)) return 'save_failed';
  const key = (Object.keys(PM_ERRORS) as PmErrorKey[]).find((k) => k !== 'save_failed' && PM_ERRORS[k] === err.message);
  return key ?? 'invalid_pm_action';
}

/** The sentence for a `?pmError=` key; unknown keys get the generic one. */
export function pmErrorMessage(key: string): string {
  return (PM_ERRORS as Record<string, string>)[key] ?? PM_ERRORS.invalid_pm_action;
}
