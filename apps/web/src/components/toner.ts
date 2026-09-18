import type { DeviceRow } from '@mps/db/queries';

/**
 * Pure display helpers shared by the fleet overview and the devices list. Kept free of JSX and of
 * anything React so they can be unit-tested without a DOM.
 */

export type TonerState = 'ok' | 'low' | 'critical' | 'unknown';

/** Global Constraints: critical under 5%, low under 20%. A missing reading is `unknown`. */
export function tonerState(pct: number | null): TonerState {
  if (pct == null || !Number.isFinite(pct)) return 'unknown';
  if (pct < 5) return 'critical';
  if (pct < 20) return 'low';
  return 'ok';
}

export type Tone = 'ok' | 'warn' | 'critical' | 'muted';

/** The four channels DRMS reports, in the order the mockup lays them out. */
export const TONER_CHANNELS = [
  { key: 'cyan', label: 'Cyan', className: 'bg-toner-cyan' },
  { key: 'magenta', label: 'Magenta', className: 'bg-toner-magenta' },
  { key: 'yellow', label: 'Yellow', className: 'bg-toner-yellow' },
  { key: 'black', label: 'Black', className: 'bg-toner-black' },
] as const satisfies readonly { key: keyof DeviceRow['toner']; label: string; className: string }[];

export function tonerLevels(row: DeviceRow): (number | null)[] {
  return TONER_CHANNELS.map((c) => row.toner[c.key]);
}

/** `6h` for the first two days, then whole days — "Offline · 4128h" helps nobody. */
function offlineAge(lastCounterAt: Date | null, now: Date): string | null {
  if (lastCounterAt == null) return null;
  const hours = Math.floor((now.getTime() - lastCounterAt.getTime()) / 3_600_000);
  if (!Number.isFinite(hours) || hours < 0) return null;
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The status line under the model in the device table. The order matters: the worst problem a
 * human can act on wins, and "not linked" comes first because an unlinked device's toner and
 * counters can't be billed or ordered against anything yet.
 */
export function deviceStatusLabel(row: DeviceRow, now: Date = new Date()): { text: string; tone: Tone } {
  if (row.vantageEquipmentId == null) return { text: 'Not linked', tone: 'muted' };

  if (row.offline) {
    const age = offlineAge(row.lastCounterAt, now);
    return { text: age ? `Offline · ${age}` : 'Offline', tone: 'critical' };
  }

  const levels = tonerLevels(row);
  const states = levels.map(tonerState);
  if (states.includes('critical')) return { text: 'Toner critical', tone: 'critical' };
  if (states.includes('low')) return { text: 'Toner low', tone: 'warn' };
  if (states.every((s) => s === 'unknown')) return { text: 'No counters', tone: 'muted' };

  return { text: 'Online', tone: 'ok' };
}

/** Tally every cartridge in the fleet by state, for the "Fleet toner health" bar. */
export function tonerHealth(rows: DeviceRow[]): { ok: number; low: number; critical: number; total: number } {
  const tally = { ok: 0, low: 0, critical: 0, total: 0 };
  for (const row of rows) {
    for (const level of tonerLevels(row)) {
      const state = tonerState(level);
      if (state === 'unknown') continue;
      tally[state] += 1;
      tally.total += 1;
    }
  }
  return tally;
}

/**
 * Rank for the overview's "needs attention first" ordering; lower sorts higher up the table.
 * Deliberately not the same order as `deviceStatusLabel`: that answers "what is wrong with this
 * device", while the overview table is a toner table, so a cartridge about to run out outranks a
 * device that has merely gone quiet — the offline count has a stat card of its own.
 */
export function attentionRank(row: DeviceRow): number {
  const states = tonerLevels(row).map(tonerState);
  if (states.includes('critical')) return 0;
  if (states.includes('low')) return 1;
  if (row.offline) return 2;
  if (row.vantageEquipmentId == null) return 3;
  return states.every((s) => s === 'unknown') ? 5 : 4;
}

const ISSUE_TYPE_LABELS: Record<string, string> = {
  no_match_drms: 'no Vantage match',
  no_match_vantage: 'no DRMS match',
  serial_ambiguous: 'ambiguous serial',
  erp_serial_disagree: 'ERP/serial disagreement',
  customer_mismatch: 'customer mismatch',
  link_broken: 'broken link',
  duplicate_target: 'duplicate target',
};

export function issueTypeLabel(type: string): string {
  return ISSUE_TYPE_LABELS[type] ?? type.replace(/_/g, ' ');
}

/** The biggest open-issue type, for the stat card's sub-line. */
export function topIssueType(countsByType: Record<string, number>): { type: string; count: number } | null {
  const entries = Object.entries(countsByType).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [type, count] = entries[0]!;
  return { type, count };
}
