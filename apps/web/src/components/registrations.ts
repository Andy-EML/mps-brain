import type { CustomerMatchFlag, RegistrationStatus, RegistrationTab } from '@mps/db/queries';
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
