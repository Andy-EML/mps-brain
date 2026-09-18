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

/** Thousands-separated integer, e.g. `12,480`. `—` for null. */
export function formatNumber(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return numbers.format(n);
}

/** `61%`. `—` for null. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

/** Toner level → status band. Global Constraints: critical < 5%, low < 20%. */
export function tonerLevelStatus(level: number | null | undefined): 'critical' | 'low' | 'ok' | 'unknown' {
  if (level == null || !Number.isFinite(level)) return 'unknown';
  if (level < 5) return 'critical';
  if (level < 20) return 'low';
  return 'ok';
}
