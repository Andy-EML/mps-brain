import { METER_NAMES, type CounterPoint, type DeviceAlarmRow } from '@mps/db/queries';

/**
 * Pure display helpers for the device detail page. No JSX and nothing from React, so they can be
 * unit-tested without a DOM — same arrangement as `./toner`.
 */

/**
 * Reads one string field out of a DRMS or Vantage `raw` blob. A few fields the page shows
 * (`CsrcId`, `CsrcComServerId`) have no column of their own in `drms_equipment`, so they can only
 * come from the JSON we stored. Anything that isn't a non-blank string becomes null, which the
 * page renders as an em dash.
 */
export function rawString(raw: unknown, key: string): string | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/* ------------------------------------------------------------------ alarms */

export type AlarmGroupKey = 'waste' | 'parts' | 'toner' | 'other' | 'jam' | 'service';

export interface AlarmGroup {
  key: AlarmGroupKey;
  label: string;
  /** The one-line explanation under the group heading. */
  hint: string;
  rows: DeviceAlarmRow[];
}

/**
 * Display order. Waste and parts come first because they are the ones that put a consumable or an
 * engineer visit on someone's list; toner follows. `jam` and `service` sit at the end and are
 * hidden until "Show all" — the user asked for them to be out of the way, and `getConsumableWarnings`
 * (the fleet-level view) ignores them too.
 */
const GROUPS: { key: AlarmGroupKey; label: string; hint: string; hiddenByDefault: boolean }[] = [
  { key: 'waste', label: 'Waste toner bottle', hint: 'TO / TR — bottle almost full or delivered', hiddenByDefault: false },
  { key: 'parts', label: 'Parts life', hint: 'TP — imaging unit, drum, filter', hiddenByDefault: false },
  { key: 'toner', label: 'Toner', hint: 'TN / TS — near empty and delivery events', hiddenByDefault: false },
  { key: 'other', label: 'Other', hint: 'Codes DRMS reports that we do not classify yet', hiddenByDefault: false },
  { key: 'jam', label: 'Paper jams', hint: 'JF / FW — jam and feed retry counters', hiddenByDefault: true },
  { key: 'service', label: 'Service calls', hint: 'SC / SR / TV — service codes', hiddenByDefault: true },
];

function groupKey(category: string | null): AlarmGroupKey {
  const known = GROUPS.find((g) => g.key === category);
  return known ? known.key : 'other';
}

/**
 * Buckets a device's alarms into the groups above, newest first inside each group.
 * `hiddenCount` is how many alarms the "Show all" toggle would reveal.
 */
export function groupAlarms(rows: DeviceAlarmRow[], showAll: boolean): { groups: AlarmGroup[]; hiddenCount: number } {
  const byKey = new Map<AlarmGroupKey, DeviceAlarmRow[]>();
  for (const row of rows) {
    const key = groupKey(row.category);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  let hiddenCount = 0;
  const groups: AlarmGroup[] = [];
  for (const group of GROUPS) {
    const bucket = byKey.get(group.key);
    if (!bucket || bucket.length === 0) continue;
    if (group.hiddenByDefault && !showAll) {
      hiddenCount += bucket.length;
      continue;
    }
    groups.push({
      key: group.key,
      label: group.label,
      hint: group.hint,
      rows: [...bucket].sort((a, b) => b.receivedTime.getTime() - a.receivedTime.getTime()),
    });
  }

  return { groups, hiddenCount };
}

/** `TN-00 · SC 06`, or whichever half of it exists. */
export function alarmCode(row: DeviceAlarmRow): string {
  const fc = row.fcCode?.trim() || null;
  const sc = row.scCode?.trim() || null;
  if (fc && sc) return `${fc} · SC ${sc}`;
  if (fc) return fc;
  if (sc) return `SC ${sc}`;
  return '—';
}

/** Initialisms DRMS embeds in its PascalCase status values; splitting alone would mangle them. */
const STATUS_WORDS: Record<string, string> = { erp: 'ERP', fc: 'FC', sc: 'SC' };

/**
 * `ReadyForErpDelivery` -> `Ready for ERP delivery`. DRMS statuses are PascalCase and are shown
 * verbatim nowhere else, so this is a straight prettifier rather than a whitelist — a status we
 * have never seen still reads as English.
 */
export function alarmStatusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  const words = status
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STATUS_WORDS[w.toLowerCase()] ?? w.toLowerCase());
  if (words.length === 0) return '—';

  // `FC SC code` reads better as `FC/SC code`.
  const joined = words.join(' ').replace('FC SC', 'FC/SC');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/* --------------------------------------------------------- counter history */

export interface CounterHistoryRow {
  at: Date;
  black: number | null;
  colour: number | null;
  scan: number | null;
  /** Change since the previous snapshot; null when either side is missing. */
  deltas: { black: number | null; colour: number | null; scan: number | null };
}

type Channel = 'black' | 'colour' | 'scan';
const CHANNELS: [Channel, string][] = [
  ['black', METER_NAMES.black],
  ['colour', METER_NAMES.colour],
  ['scan', METER_NAMES.scan],
];

/**
 * Merges the three meter series `getCounterHistory` returns into one row per snapshot timestamp,
 * newest first, with the change since the previous snapshot.
 *
 * Deltas are computed over the whole series before `limit` is applied, so the last visible row
 * still has a real delta if an older snapshot exists behind it.
 */
export function counterHistoryRows(
  history: Record<string, CounterPoint[]>,
  limit = 30,
): CounterHistoryRow[] {
  const byTime = new Map<number, { at: Date; black: number | null; colour: number | null; scan: number | null }>();

  for (const [channel, name] of CHANNELS) {
    for (const point of history[name] ?? []) {
      const key = point.at.getTime();
      let row = byTime.get(key);
      if (!row) {
        row = { at: point.at, black: null, colour: null, scan: null };
        byTime.set(key, row);
      }
      row[channel] = point.value;
    }
  }

  const ascending = [...byTime.values()].sort((a, b) => a.at.getTime() - b.at.getTime());

  const rows: CounterHistoryRow[] = ascending.map((row, i) => {
    const prev = i > 0 ? ascending[i - 1] : undefined;
    const delta = (channel: Channel): number | null => {
      const now = row[channel];
      const before = prev?.[channel];
      return now == null || before == null ? null : now - before;
    };
    return {
      at: row.at,
      black: row.black,
      colour: row.colour,
      scan: row.scan,
      deltas: { black: delta('black'), colour: delta('colour'), scan: delta('scan') },
    };
  });

  return rows.reverse().slice(0, limit);
}
