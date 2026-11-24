// Types only from @mps/db: its values would pull the database client into the browser bundle.
import type { CustomerWarnings, MachineStatusRow } from '@mps/db/queries';
import { overdueKind, statusLabel, statusTone } from './pm-status';
import type { Tone } from './toner';

/**
 * The pure helpers behind the `/customers` accordion: the red ! tooltip and link, the machine
 * line's inline warnings, and the server actions' argument check. Unit-tested.
 */

/**
 * A copy of `NO_READING_DAYS` from `@mps/db` (a test keeps them equal), because client components
 * must not import its values.
 */
export const NO_READING_DAYS_TEXT = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** `2 machines no reading 7+ days · 1 PM overdue · 3 pending orders`, zero counts left out; `''` when none. */
export function warningTooltip(w: CustomerWarnings): string {
  const parts: string[] = [];
  if (w.noReading > 0)
    parts.push(
      `${plural(w.noReading, 'machine', 'machines')} no reading ${NO_READING_DAYS_TEXT}+ days`,
    );
  if (w.pmOverdue > 0) parts.push(`${w.pmOverdue} PM overdue`);
  if (w.pending > 0) parts.push(plural(w.pending, 'pending order', 'pending orders'));
  return parts.join(' · ');
}

/**
 * `/pm` filtered to this customer (the PM list's customer filter matches on the name). Null for a
 * head office — its PM warnings are its sites', which are listed under their own names — or a
 * customer with no name.
 */
export function pmWarningHref(customerName: string | null, isHeadOffice: boolean): string | null {
  const name = customerName?.trim();
  if (isHeadOffice || !name) return null;
  return `/pm?customer=${encodeURIComponent(name)}`;
}

export function machinesEmptyText(): string {
  return 'No machines';
}

/**
 * A server action's customer id argument: a string of 1-9 digits, else null. Anything else
 * (numbers, arrays, objects, signs, spaces) is refused, so only a plain id reaches the query.
 */
export function parseCustomerIdArg(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{1,9}$/.test(v)) return null;
  return Number(v);
}

/** The machine line's inline warnings: `['No reading 9 days', 'PM overdue', '2 pending']`; empty when clean. */
export function machineLineWarnings(m: MachineStatusRow, now: Date = new Date()): string[] {
  const out: string[] = [];
  if (m.warnings.noReading) {
    if (m.lastReadingAt === null) out.push('No reading on record');
    else {
      const days = Math.floor((now.getTime() - new Date(m.lastReadingAt).getTime()) / DAY_MS);
      out.push(`No reading ${plural(days, 'day', 'days')}`);
    }
  }
  if (m.warnings.pmOverdue) out.push('PM overdue');
  if (m.warnings.pending) out.push(`${m.pending} pending`);
  return out;
}

/**
 * The machine line's PM chip tone: the status tone on the PM page's Due view, muted when the
 * machine is booked or dismissed there, or its site is serviced by another dealer, so a red chip
 * always goes with a PM warning.
 */
export function pmChipTone(pm: NonNullable<MachineStatusRow['pm']>): Tone {
  return pm.view === 'due' && pm.otherDealer === null ? statusTone(pm.status) : 'muted';
}

/**
 * The machine line's PM chip text: `Other dealer: MJ Flood` at an other-dealer site (they do its
 * PM), else `Overdue by pages|time` when that is why it is overdue, else the status label.
 */
export function pmChipText(pm: NonNullable<MachineStatusRow['pm']>): string {
  if (pm.otherDealer !== null) return `Other dealer: ${pm.otherDealer}`;
  const kind = pm.status === 'overdue' ? overdueKind(pm.overdueReason) : null;
  return kind ? `Overdue by ${kind}` : statusLabel(pm.status);
}
