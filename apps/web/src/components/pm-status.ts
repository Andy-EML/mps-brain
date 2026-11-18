import type { DismissReason, PmAction, PmResult, PmStatus, PmVisit, Visit, VisitVerdict } from '@mps/db/queries';
import { formatDate, formatNumber, formatPercent } from '../lib/format';
import type { Tone } from './toner';

/**
 * Display text for the read-only "PM due" list (`@mps/db` `pm-due.ts`). Pure, so it is unit-tested.
 * Unknown figures are said in words ("Not enough meter history"), never shown as 0 or blank.
 */

const LABEL: Record<PmStatus, string> = {
  overdue: 'Overdue',
  due_soon: 'Due soon',
  ok: 'OK',
  held: 'Held off — frequent calls',
  booked: 'PM booked',
  unknown: 'Unknown',
};

const TONE: Record<PmStatus, Tone> = {
  overdue: 'critical',
  due_soon: 'warn',
  ok: 'ok',
  held: 'warn',
  booked: 'ok',
  unknown: 'muted',
};

export const statusLabel = (status: PmStatus): string => LABEL[status];
export const statusTone = (status: PmStatus): Tone => TONE[status];

/** Pages since the last qualifying visit: `12,345`, `at least 12,345`, or why it is unknown. */
export function pagesText(pagesSince: number | null, isLowerBound: boolean): string {
  if (pagesSince === null) return 'Not enough meter history';
  const n = formatNumber(Math.round(pagesSince));
  return isLowerBound ? `at least ${n}` : n;
}

/** `pctUsed` is a fraction (0.86); shown as a whole percent. */
export const pctText = (pctUsed: number | null): string => (pctUsed === null ? '—' : formatPercent(pctUsed * 100));

/**
 * Why a machine is overdue or unknown, shown under its status badge. `timeCapMonths` is the setting
 * behind `time_cap`; `clockSource` says what that clock started from. `no_visit_12m` (key kept) means no qualifying visit in the visit history we hold (3 years).
 */
export function reasonText(
  reason: string | null,
  timeCapMonths = 12,
  clockSource: PmResult['clockSource'] = 'visit',
): string | null {
  switch (reason) {
    case 'pages':
      return 'Over interval';
    case 'time_cap':
      return `${timeCapMonths} months ${
        clockSource === 'install' ? 'since install' : clockSource === 'manual' ? 'since serviced outside Vantage' : 'since last visit'
      }`;
    case 'no_visit_12m':
      return 'No visit on record';
    case 'meter_reset':
      return 'Meter reset since last visit';
    case 'no_meter':
      return 'Not enough meter history';
    default:
      return null;
  }
}

export type OverdueKind = 'pages' | 'time';

/** Overdue by the page interval, or by time (the time cap, or no qualifying visit on record). */
export function overdueKind(reason: string | null): OverdueKind | null {
  if (reason === 'pages') return 'pages';
  if (reason === 'time_cap' || reason === 'no_visit_12m') return 'time';
  return null;
}

/** The distinct work references of a visit's units, in order. */
export const visitReferences = (visit: Visit): string[] => [
  ...new Set(visit.units.map((u) => u.reference).filter((r): r is string => !!r)),
];

/** The last qualifying visit as `{ date: '2 Oct 2026', detail: '75 min · W123456' }`. */
export function lastVisitText(visit: Visit | null): { date: string; detail: string | null } {
  if (visit === null) return { date: 'None on record', detail: null };
  const refs = visitReferences(visit);
  const parts: string[] = [];
  if (visit.minutes !== null) parts.push(`${formatNumber(Math.round(visit.minutes))} min`);
  if (refs.length > 0) parts.push(refs.join(', '));
  return { date: formatDate(visit.at), detail: parts.length > 0 ? parts.join(' · ') : null };
}

/** `Frequent calls · 4 visits · hold lifts 12 Dec 2026`, or null when the machine is not held. */
export function frequentText(r: PmResult): string | null {
  if (r.status !== 'held' || r.holdUntil === null) return null;
  return `Frequent calls · ${formatNumber(r.frequentVisits)} visits · hold lifts ${formatDate(r.holdUntil)}`;
}

/** How one visit was judged, for the device page's visit list. `qualifyingMinutes` is the setting. */
export function verdictText(verdict: VisitVerdict, qualifyingMinutes = 45, matchedKeywords: string[] = []): string {
  switch (verdict) {
    case 'counted':
      return 'Counted';
    case 'counted_pm':
      return 'Counted (PM visit)';
    case 'counted_parts': {
      const names = matchedKeywords.map((k) => k.charAt(0).toUpperCase() + k.slice(1));
      return names.length > 0 ? `Counted (parts: ${names.join(', ')})` : 'Counted (parts)';
    }
    case 'too_short':
      return `Too short (<${qualifyingMinutes} min)`;
    case 'not_field':
      return 'Not a field visit';
    case 'unknown_length':
      return 'Length unknown';
  }
}

/** A visit's length (all units): `75 min`, `PM visit` for a PM-only day with no length, else an em dash. */
export function visitLengthText(visit: Visit): string {
  if (visit.displayMinutes !== null) return `${formatNumber(Math.round(visit.displayMinutes))} min`;
  return visit.isPm ? 'PM visit' : '—';
}

/** A visit's grand-total meter: `12,345` with `+4,000 since previous` under it, or an em dash. */
export function visitMeterText(v: Pick<PmVisit, 'meter' | 'pagesSincePrev'>): { total: string; since: string | null } {
  if (v.meter === null) return { total: '—', since: null };
  return {
    total: formatNumber(Math.round(v.meter)),
    since: v.pagesSincePrev === null ? null : `+${formatNumber(Math.round(v.pagesSincePrev))} since previous`,
  };
}

/** The distinct work categories of a visit's units, in order. */
export const visitCategories = (visit: Visit): string[] => [
  ...new Set(visit.units.map((u) => u.categoryName).filter((c): c is string => !!c)),
];

/** The engineer's action text for a visit: each unit's distinct, trimmed text joined with ` · `; null if none. */
export function visitActionText(visit: Visit): string | null {
  const texts = [...new Set(visit.units.map((u) => u.actionDetails?.trim()).filter((t): t is string => !!t))];
  return texts.length > 0 ? texts.join(' · ') : null;
}

/** `Fuser Unit ×1, Transfer Belt ×1`: the parts fitted that day, or null when none. */
export function visitPartsText(visit: Visit): string | null {
  const parts = visit.units.flatMap((u) => u.parts).map((p) => `${p.description} ×${p.quantity}`);
  return parts.length > 0 ? [...new Set(parts)].join(', ') : null;
}

const DISMISS_LABEL: Record<DismissReason, string> = {
  not_now: 'Not now',
  declined: 'Customer declined',
  serviced_outside: 'Serviced outside Vantage',
  other: 'Other',
};

/** The dismiss reasons in the order the form lists them. */
export const DISMISS_REASONS = ['not_now', 'declined', 'serviced_outside', 'other'] as const satisfies readonly DismissReason[];

/**
 * The snooze choices on the Dismiss form. A copy of `SNOOZE_DAYS` / `DEFAULT_SNOOZE_DAYS` from
 * `@mps/db` (a test keeps them equal), because client components must not import its values.
 */
export const SNOOZE_OPTIONS = [30, 90, 180] as const;
export const DEFAULT_SNOOZE_OPTION = 90;

export const dismissReasonLabel = (reason: DismissReason): string => DISMISS_LABEL[reason];

/**
 * An open PM action as one line: `Booked for 3 Dec 2026 by Andy (ref W123)`,
 * `Snoozed until 16 Feb 2027 — Customer declined`, `Serviced outside Vantage on 18 Nov 2026`.
 */
export function actionText(a: PmAction): string {
  if (a.kind === 'booked') {
    let text = 'Booked';
    if (a.bookedFor) text += ` for ${formatDate(a.bookedFor)}`;
    if (a.createdByName) text += ` by ${a.createdByName}`;
    if (a.reference) text += ` (ref ${a.reference})`;
    return text;
  }
  if (a.reason === 'serviced_outside') return `Serviced outside Vantage on ${formatDate(a.servicedOn)}`;
  const why = a.reason === null ? null : a.reason === 'other' && a.note ? `Other: ${a.note}` : dismissReasonLabel(a.reason);
  return `Snoozed until ${formatDate(a.snoozeUntil)}${why ? ` — ${why}` : ''}`;
}

/** Who recorded an action and when: `Andy · 18 Nov 2026`. */
export function actionByText(a: PmAction): string {
  return [a.createdByName, formatDate(a.createdAt)].filter(Boolean).join(' · ');
}

/** Where the PM clock started, shown after the clock-start date. */
export function clockSourceText(source: PmResult['clockSource']): string | null {
  switch (source) {
    case 'install':
      return 'since install';
    case 'visit':
      return 'since last visit';
    case 'manual':
      return 'since serviced outside Vantage';
    default:
      return null;
  }
}
