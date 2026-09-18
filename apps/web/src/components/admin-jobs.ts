import { QUEUES, type QueueName } from '@mps/queue';
import type { Tone } from './toner';
import { formatDate, formatNumber } from '../lib/format';

/**
 * Pure display helpers for `/admin/jobs`. No JSX and nothing React, so the banding rules can be
 * unit-tested — which matters most for the token warning, whose real value (a QA token expiring in
 * 2100) never exercises the interesting branch.
 */

/** The plan's window: warn when the DRMS token expires within a fortnight. */
export const TOKEN_WARNING_DAYS = 14;

export interface TokenExpiryState {
  /** `null` when the worker has never recorded one, or the stored value is not a date. */
  at: Date | null;
  tone: Tone;
  label: string;
  /** Whole days from now until expiry, rounded up. Negative once it has passed. */
  expiresInDays: number | null;
  expired: boolean;
  /** True when the admin should act: expired, or inside the warning window. */
  warn: boolean;
}

/**
 * Bands `app_state.drms_token_expiry` for display. The value is a date only — the token itself is
 * never read by the web app and must never reach a page, a log or a URL.
 */
export function tokenExpiry(value: Date | string | null | undefined, now: Date = new Date()): TokenExpiryState {
  const at = value == null ? null : value instanceof Date ? value : new Date(value);
  if (at == null || Number.isNaN(at.getTime())) {
    return {
      at: null,
      tone: 'muted',
      label: 'Unknown — the worker records it when it starts.',
      expiresInDays: null,
      expired: false,
      warn: false,
    };
  }

  const ms = at.getTime() - now.getTime();
  const expiresInDays = Math.ceil(ms / 86_400_000);

  if (ms <= 0) {
    return {
      at,
      tone: 'critical',
      label: `Expired on ${formatDate(at)} — DRMS calls will be failing.`,
      expiresInDays,
      expired: true,
      warn: true,
    };
  }

  if (expiresInDays <= TOKEN_WARNING_DAYS) {
    return {
      at,
      tone: 'warn',
      label: `Expires in ${expiresInDays} ${expiresInDays === 1 ? 'day' : 'days'}, on ${formatDate(at)} — ask Konica Minolta for a new one.`,
      expiresInDays,
      expired: false,
      warn: true,
    };
  }

  return {
    at,
    tone: 'ok',
    label: `Valid until ${formatDate(at)}.`,
    expiresInDays,
    expired: false,
    warn: false,
  };
}

/** `480ms`, `1.5s`, `11s`, `1m 12s`. `null` while the run is still going. */
export function formatDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** The four statuses `sync_runs.status` can hold, plus a safe default for anything new. */
export function runTone(status: string): Tone {
  switch (status) {
    case 'success':
      return 'ok';
    case 'partial':
      return 'warn';
    case 'failed':
      return 'critical';
    default:
      return 'muted';
  }
}

/** `issuesOpened` → `Issues opened`. The worker writes camelCase keys and never labels them. */
function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export interface StatLine {
  label: string;
  value: string;
}

/** Renders a run's `stats` jsonb as label/value pairs, in the order the worker wrote them. */
export function statLines(stats: unknown): StatLine[] {
  if (stats == null || typeof stats !== 'object' || Array.isArray(stats)) return [];
  return Object.entries(stats as Record<string, unknown>).map(([key, value]) => ({
    label: humanise(key),
    value: typeof value === 'number' ? formatNumber(value) : String(value),
  }));
}

export interface JobCard {
  queue: QueueName;
  title: string;
  /** What the job does, so "Run now" is never a mystery button. */
  description: string;
  /** Its normal schedule, as the worker registers it. */
  schedule: string;
  /** True when the job calls DRMS or Vantage — those runs ask for confirmation first. */
  external: boolean;
}

/**
 * The five queues, in the order a person would think about them: the two pulls that bring data in,
 * the linker that joins them up, then the two DRMS collections.
 */
export const JOB_CARDS: readonly JobCard[] = [
  {
    queue: QUEUES.vantagePull,
    title: 'Vantage pull',
    description: 'Fetches customers and equipment from Vantage Online, then queues a link run.',
    schedule: 'Daily at 02:00 (full sync on Sundays)',
    external: true,
  },
  {
    queue: QUEUES.drmsPull,
    title: 'DRMS pull',
    description: 'Refreshes the DRMS device list and re-evaluates offline alerts, then queues a link run.',
    schedule: 'Daily at 02:15',
    external: true,
  },
  {
    queue: QUEUES.linkRun,
    title: 'Link run',
    description: 'Re-matches DRMS devices to Vantage equipment and opens or resolves link issues. Postgres only.',
    schedule: 'After each pull',
    external: false,
  },
  {
    queue: QUEUES.drmsSnapshot,
    title: 'DRMS counter snapshot',
    description: 'Collects the latest meter and toner counters for every device. The slowest job by far.',
    schedule: 'Daily at 06:00',
    external: true,
  },
  {
    queue: QUEUES.drmsAlarms,
    title: 'DRMS alarms',
    description: 'Pulls consumable and service alarms raised since the last run.',
    schedule: 'Hourly',
    external: true,
  },
];
