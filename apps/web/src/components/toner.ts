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

export type TonerChannel = (typeof TONER_CHANNELS)[number];

/**
 * The cartridges this particular device has: all four for a colour device, black alone for a mono
 * one. Roughly half the fleet is mono, and a `bizhub 301i` drawn with three empty CMY bars reads as
 * three cartridges that have run out rather than three that do not exist.
 *
 * The query layer already nulls the colour levels of a mono device, so this is not about hiding a
 * number — it is about the difference between "no reading yet" and "no cartridge", which a null on
 * its own cannot express. Everything derived from the levels (`deviceStatusLabel`, `tonerHealth`,
 * `attentionRank`) goes through `tonerLevels` and so inherits it.
 */
export function tonerChannels(row: DeviceRow): readonly TonerChannel[] {
  return row.isColour ? TONER_CHANNELS : TONER_CHANNELS.filter((c) => c.key === 'black');
}

export function tonerLevels(row: DeviceRow): (number | null)[] {
  return tonerChannels(row).map((c) => row.toner[c.key]);
}

/**
 * Split on anything that isn't a letter or a digit, lower-case, and drop a trailing firmware
 * version from each token (`_Ver42` → its own token and then empty; `458Ver2` → `458`). DRMS
 * product names and model names differ mostly in punctuation and that suffix, so this turns
 * "ineo+458_Ver42" and "ineo+458" into the same token list.
 */
function modelTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/ver\d+$/, ''))
    .filter((t) => t !== '');
}

/**
 * Whether the DRMS product name is worth showing next to the Model column.
 *
 * Many devices are named after their own model — "ineo+458_Ver42" beside a Model column reading
 * "ineo+458" — which prints the same thing twice in one row. Others carry the site, which is the
 * most useful thing on the row: "Little Heath School (Maths) C3351i", "A-Plan (Southampton)
 * MF3303".
 *
 * The test is therefore "does anything survive once the model's own words are taken out", not
 * plain substring containment. Containment would also hide "A-Plan (Southampton) MF3303" whenever
 * the model is literally `MF3303`, and that name is exactly the kind we want to keep. A name that
 * is only a shortened model ("C3351i" under "bizhub C3351i") still leaves nothing behind, so it is
 * dropped as intended.
 */
export function deviceNameAddsInfo(name: string | null | undefined, model: string | null | undefined): boolean {
  const nameTokens = name ? modelTokens(name) : [];
  if (nameTokens.length === 0) return false;

  const fromModel = new Set(model ? modelTokens(model) : []);
  if (fromModel.size === 0) return true;

  return nameTokens.some((t) => !fromModel.has(t));
}

/** `6h` for the first two days, then whole days — "No meter reading · 4128h" helps nobody. */
function readingAge(lastCounterAt: Date | null, now: Date): string | null {
  if (lastCounterAt == null) return null;
  const hours = Math.floor((now.getTime() - lastCounterAt.getTime()) / 3_600_000);
  if (!Number.isFinite(hours) || hours < 0) return null;
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How fresh an alarm has to be to count as proof that the device is reaching CSRC. */
export const RECENT_ALARM_HOURS = 24;

/**
 * Whether DRMS has had an alarm from this device recently. The alarm feed refreshes every ~27 min
 * against the meter collection's roughly once a day, so an alarm inside the window is an
 * independent signal of life: the device is talking to CSRC even though no counter set arrived. A
 * timestamp in the future is bad data, not good news, so it does not count.
 */
export function hasRecentAlarm(row: DeviceRow, now: Date = new Date()): boolean {
  if (row.lastAlarmAt == null) return false;
  const ms = now.getTime() - row.lastAlarmAt.getTime();
  return Number.isFinite(ms) && ms >= 0 && ms < RECENT_ALARM_HOURS * 3_600_000;
}

/**
 * The status line under the model in the device table. The order matters: the worst problem a
 * human can act on wins, and "not linked" comes first because an unlinked device's toner and
 * counters can't be billed or ordered against anything yet.
 *
 * Deliberately not "Offline": all `row.offline` knows is that DRMS collected no counter set, which
 * says nothing about reachability. A recent alarm settles that question the other way, so it drops
 * the line to amber and says so instead of claiming the device is down.
 */
export function deviceStatusLabel(row: DeviceRow, now: Date = new Date()): { text: string; tone: Tone } {
  if (row.vantageEquipmentId == null) return { text: 'Not linked', tone: 'muted' };

  if (row.offline) {
    if (hasRecentAlarm(row, now)) return { text: 'No meter reading · reaching CSRC', tone: 'warn' };
    const age = readingAge(row.lastCounterAt, now);
    return { text: age ? `No meter reading · ${age}` : 'No meter reading', tone: 'critical' };
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
 * device whose meter reading is merely missing — that has a stat card of its own.
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
