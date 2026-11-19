/**
 * Cartridge changes of a black toner supply, inferred from level readings and "Toner Empty"
 * alarms. A swap shows as the level dropping low then jumping up, or as an Empty alarm.
 * Pure — no I/O.
 */

/** (agreed) A toner level at or below this counts as the cartridge being nearly used up. */
export const LOW_LEVEL = 15;
/** (agreed) A toner level at or above this after a low reading means a fresh cartridge went in. */
export const RISE_LEVEL = 50;

export interface LevelReading {
  at: Date;
  value: number;
  snapshotId: number;
}

export interface EmptyEvent {
  at: Date;
  alarmId: string;
}

export type ChangeSource = 'empty_alarm' | 'level';

export interface DetectedChange {
  at: Date;
  source: ChangeSource;
  alarmId: string | null;
  lowSnapshotId: number | null;
  highSnapshotId: number | null;
  lowLevel: number | null;
  highLevel: number | null;
}

type Event = { at: number; kind: 0; reading: LevelReading } | { at: number; kind: 1; empty: EmptyEvent };

/**
 * Readings and empties strictly after `since`; `afterEmpty` = the last recorded change was an
 * Empty (its swap is still to come). Chronological output; a reading sorts before an Empty at the
 * same instant.
 */
export function detectChanges(args: {
  since: Date;
  afterEmpty: boolean;
  readings: LevelReading[];
  empties: EmptyEvent[];
}): DetectedChange[] {
  const since = args.since.getTime();
  const events: Event[] = [
    ...args.readings.filter((x) => x.at.getTime() > since).map((reading): Event => ({ at: reading.at.getTime(), kind: 0, reading })),
    ...args.empties.filter((x) => x.at.getTime() > since).map((empty): Event => ({ at: empty.at.getTime(), kind: 1, empty })),
  ].sort((a, b) => a.at - b.at || a.kind - b.kind);

  const out: DetectedChange[] = [];
  let low: LevelReading | null = null;
  let pendingEmpty = args.afterEmpty;

  for (const ev of events) {
    if (ev.kind === 1) {
      if (pendingEmpty) continue;
      out.push({
        at: ev.empty.at,
        source: 'empty_alarm',
        alarmId: ev.empty.alarmId,
        lowSnapshotId: null,
        highSnapshotId: null,
        lowLevel: null,
        highLevel: null,
      });
      pendingEmpty = true;
      low = null;
      continue;
    }
    const { reading } = ev;
    if (reading.value <= LOW_LEVEL) {
      low ??= reading;
    } else if (reading.value < RISE_LEVEL) {
      // A mid reading after a counted Empty means a partly used spare went in: the Empty is absorbed.
      if (pendingEmpty) {
        pendingEmpty = false;
        low = null;
      }
    } else if (reading.value >= RISE_LEVEL) {
      if (pendingEmpty) {
        pendingEmpty = false;
        low = null;
      } else if (low) {
        out.push({
          at: reading.at,
          source: 'level',
          alarmId: null,
          lowSnapshotId: low.snapshotId,
          highSnapshotId: reading.snapshotId,
          lowLevel: low.value,
          highLevel: reading.value,
        });
        low = null;
      }
    }
  }
  return out;
}
