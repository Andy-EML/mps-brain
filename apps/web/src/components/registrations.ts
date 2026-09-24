import type { CustomerMatchFlag, RegistrationStatus, RegistrationTab } from '@mps/db/queries';
// Relative, not `@/lib/format`: Vitest has no `@/` alias and this module is unit-tested.
import { formatNumber } from '../lib/format';
import type { Tone } from './toner';

/**
 * Pure display helpers for `/registrations`. Types only from `@mps/db` — this module is imported
 * by client components, and the db package must never reach the browser bundle.
 */

/** Mirrors `REGISTRATION_TABS` in `@mps/db/queries` (not imported: that module is server-side). */
export const REGISTRATION_TAB_VALUES = ['awaiting', 'waiting', 'registered', 'failed', 'rejected'] as const satisfies readonly RegistrationTab[];

export function parseRegistrationTab(value: string | null | undefined): RegistrationTab {
  return REGISTRATION_TAB_VALUES.includes(value as RegistrationTab) ? (value as RegistrationTab) : 'awaiting';
}

export interface Badge {
  tone: Tone;
  label: string;
}

/** The scan's customer-name check. Mismatches are still registrable — the approver decides. */
export function customerMatchBadge(flag: CustomerMatchFlag | null): Badge | null {
  switch (flag) {
    case 'match':
      return { tone: 'ok', label: 'Customer matches' };
    case 'no_shared_words':
      return { tone: 'warn', label: 'Names differ — check' };
    case 'mismatch':
      return { tone: 'critical', label: 'DRMS shows Elmdale/stock' };
    default:
      return null;
  }
}

const STATUS: Record<RegistrationStatus, Badge> = {
  awaiting_approval: { tone: 'muted', label: 'Awaiting approval' },
  waiting: { tone: 'muted', label: 'Waiting' },
  approved: { tone: 'warn', label: 'Approved · sending to DRMS' },
  registered: { tone: 'ok', label: 'Registered' },
  failed: { tone: 'critical', label: 'Failed' },
  rejected: { tone: 'muted', label: 'Rejected' },
};

export function registrationStatusBadge(status: RegistrationStatus): Badge {
  return STATUS[status];
}

/**
 * The rows a queue form acts on. A row's own Approve/Reject button posts `only=<id>` and acts on
 * that row alone, whatever else is ticked; the bulk buttons act on every ticked `id`.
 */
export function selectedIds(formData: FormData): number[] {
  const valid = (v: FormDataEntryValue) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const only = formData.get('only');
  if (only !== null) {
    const id = valid(only);
    return id === null ? [] : [id];
  }
  return [...new Set(formData.getAll('id').map(valid).filter((n): n is number => n !== null))];
}

/**
 * The Retry confirmation. With no request id DRMS never told us whether it took the first attempt
 * (a timeout, a 5xx, a crash mid-send — or a plain rejection), so the person is sent to look first.
 */
export function retryConfirmText(row: { requestId: string | null; serial: string | null }): string {
  const machine = row.serial ?? 'this machine';
  return row.requestId === null
    ? `DRMS may still be processing the first attempt — check the device in DRMS first. Register ${machine} in DRMS again anyway?`
    : `Register ${machine} in DRMS again? DRMS answered the first attempt with a failure.`;
}

/**
 * The *Awaiting approval* tab lists rows awaiting a decision and approved rows being sent; so does its
 * count. `text` is already formatted (thousands separators), because the tab label prints it as is.
 */
export function awaitingTabCount(c: { awaitingApproval: number; approved: number }): { total: number; text: string } {
  const total = c.awaitingApproval + c.approved;
  const awaiting = formatNumber(c.awaitingApproval);
  return { total, text: c.approved > 0 ? `${awaiting} + ${formatNumber(c.approved)} sending` : awaiting };
}
