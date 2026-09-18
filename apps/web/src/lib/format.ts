/**
 * Display formatting. Everything is stored in UTC; the UI always shows Europe/London.
 */
const TIME_ZONE = 'Europe/London';

const dateTimeParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const numbers = new Intl.NumberFormat('en-GB');

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** `d MMM yyyy HH:mm`, e.g. `8 Sep 2026 14:03`. */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (value == null) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const p = dateTimeParts.formatToParts(date);
  return `${part(p, 'day')} ${part(p, 'month')} ${part(p, 'year')} ${part(p, 'hour')}:${part(p, 'minute')}`;
}

/** `d MMM yyyy`, e.g. `8 Sep 2026`. */
export function formatDate(value: Date | string | null | undefined): string {
  if (value == null) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const p = dateParts.formatToParts(date);
  return `${part(p, 'day')} ${part(p, 'month')} ${part(p, 'year')}`;
}

/** Coarse "how long ago", for sync freshness lines: `4 minutes ago`, `2 days ago`. */
export function formatRelative(value: Date | string | null | undefined, now: Date = new Date()): string {
  if (value == null) return 'never';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'never';

  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['week', 604800],
    ['month', 2629800],
    ['year', 31557600],
  ];
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0]!;
  for (const unit of units) {
    if (seconds >= unit[1]) chosen = unit;
  }
  const rtf = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  return rtf.format(-Math.floor(seconds / chosen[1]), chosen[0]);
}

/**
 * How long a gap is, in the coarsest unit that is still honest: `31 hours`, `6 days`.
 *
 * Alerts open at 24 hours and the interesting question is "one missed collection, or three weeks?",
 * so hours stay readable up to two days and everything past that rounds to days.
 */
export function formatGap(from: Date | string | null | undefined, to: Date = new Date()): string {
  if (from == null) return '—';
  const date = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(date.getTime())) return '—';

  const hours = Math.floor((to.getTime() - date.getTime()) / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours} ${pluralise(hours, 'hour')}`;
  const days = Math.floor(hours / 24);
  return `${days} ${pluralise(days, 'day')}`;
}

/** Thousands-separated integer, e.g. `12,480`. `—` for null. */
export function formatNumber(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return numbers.format(n);
}

/** `1 device` / `9 devices`. */
export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** `61%`. `—` for null. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

/* The toner banding that used to live here is now `tonerState` in `@/components/toner`, next to
 * `deviceStatusLabel` and its tests — one source of truth for the 5%/20% thresholds. */
