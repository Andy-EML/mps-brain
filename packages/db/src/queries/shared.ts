import { eq, max, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { counterSnapshots, counterValues, deviceAlarms, drmsEquipment } from '../schema';

/** Counter names this project cares about (see CLAUDE.md / global-constraints for the real values). */
export const TONER_NAMES = {
  black: 'BlackTonerLevel',
  cyan: 'CyanTonerLevel',
  magenta: 'MagentaTonerLevel',
  yellow: 'YellowTonerLevel',
} as const;

export const METER_NAMES = {
  black: 'Black:Total',
  colour: 'Full Color:Total',
  scan: 'Scanner/FAX:Scan',
} as const;

/**
 * Subquery: the latest `counter_snapshots.id` per device. `max(id)` is correct because ids
 * increase with insertion and a device's newest collection is always inserted last.
 */
export function latestSnapshotSubquery(db: Db) {
  return db
    .select({
      drmsId: counterSnapshots.drmsEquipmentId,
      // Aliased distinctly from counter_values.snapshot_id (a real column name) — reusing that
      // name here confuses Postgres about which "snapshot_id" the join condition means.
      snapshotId: sql<number>`max(${counterSnapshots.id})`.as('latest_snapshot_id'),
    })
    .from(counterSnapshots)
    .groupBy(counterSnapshots.drmsEquipmentId)
    .as('latest_snapshot');
}

function pivot(name: string) {
  return sql<number | null>`max(case when ${counterValues.name} = ${name} then ${counterValues.value} end)`;
}

/**
 * A colour toner pivot that only reports on a device that has that cartridge.
 *
 * Half the fleet is mono, and DRMS still sends the odd Cyan/Magenta/Yellow level for one of them —
 * the engines share counter definitions, so a `bizhub 301i` can report a colour level of 0 it has
 * no cartridge for. Read literally that is an empty cartridge, which put mono devices in "Needs
 * toner", drew three empty bars on their row and inflated the fleet cartridge count.
 *
 * Nulling them here rather than in each caller means every consumer of this subquery — the fleet
 * summary's needsToner/criticalToner, `getTonerHealth`, the devices list and its `needs-toner`
 * filter and urgency ordering — is correct without knowing the rule, because "no reading" is a
 * case they all already handle.
 */
function colourPivot(name: string) {
  return sql<number | null>`case when ${drmsEquipment.isColour} then ${pivot(name)} end`;
}

/**
 * Subquery: one row per device with its latest toner + meter readings pivoted into columns.
 * `leftJoin` this on `drmsId` so devices without any snapshot still appear (all columns null).
 *
 * Joins `drms_equipment` only for `is_colour`; the join is on the snapshot's device, which is a
 * foreign key into that table, so it can neither drop nor multiply rows.
 */
export function counterPivotSubquery(db: Db) {
  const latest = latestSnapshotSubquery(db);
  return db
    .select({
      drmsId: latest.drmsId,
      black: pivot(TONER_NAMES.black).as('black'),
      cyan: colourPivot(TONER_NAMES.cyan).as('cyan'),
      magenta: colourPivot(TONER_NAMES.magenta).as('magenta'),
      yellow: colourPivot(TONER_NAMES.yellow).as('yellow'),
      // The meters are left alone: `Full Color:Total` is a page count, not a cartridge, and a mono
      // device simply never reports one. Hiding the column is the device page's job (it drops the
      // Colour tile and history column for a mono device) rather than the query's.
      meterBlack: pivot(METER_NAMES.black).as('meter_black'),
      meterColour: pivot(METER_NAMES.colour).as('meter_colour'),
      meterScan: pivot(METER_NAMES.scan).as('meter_scan'),
    })
    .from(latest)
    .innerJoin(drmsEquipment, eq(drmsEquipment.drmsId, latest.drmsId))
    .leftJoin(counterValues, eq(counterValues.snapshotId, latest.snapshotId))
    // `is_colour` is grouped, not aggregated: it is one value per device, and the colour pivots
    // above read it outside their own `max(...)`.
    .groupBy(latest.drmsId, drmsEquipment.isColour)
    .as('counter_pivot');
}

/**
 * Subquery: one row per device with the time of its newest alarm.
 *
 * DRMS refreshes the alarm feed roughly every 27 minutes, against meter counters' once a day, so a
 * recent alarm is a *second signal of life*: it proves the device is reaching CSRC even when no
 * meter reading has arrived. Grouped once and left-joined on `drmsId`, like the counter pivot —
 * never one query per row.
 */
export function lastAlarmSubquery(db: Db) {
  return db
    .select({
      drmsId: deviceAlarms.drmsEquipmentId,
      // drizzle's `max()` (not a raw `sql` fragment) so the alias keeps the column's timestamp
      // mapper and the field comes back as a Date rather than a Postgres timestamp string.
      lastAlarmAt: max(deviceAlarms.receivedTime).as('last_alarm_at'),
    })
    .from(deviceAlarms)
    .groupBy(deviceAlarms.drmsEquipmentId)
    .as('last_alarm');
}

export function toNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Default threshold (hours) for treating a device that has reported before as "offline". */
export const DEFAULT_OFFLINE_HOURS = 24;

export function offlineCutoff(hours: number = DEFAULT_OFFLINE_HOURS): Date {
  return new Date(Date.now() - hours * 3_600_000);
}
