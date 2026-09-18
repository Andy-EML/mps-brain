import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { counterSnapshots, counterValues } from '../schema';

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
 * Subquery: one row per device with its latest toner + meter readings pivoted into columns.
 * `leftJoin` this on `drmsId` so devices without any snapshot still appear (all columns null).
 */
export function counterPivotSubquery(db: Db) {
  const latest = latestSnapshotSubquery(db);
  return db
    .select({
      drmsId: latest.drmsId,
      black: pivot(TONER_NAMES.black).as('black'),
      cyan: pivot(TONER_NAMES.cyan).as('cyan'),
      magenta: pivot(TONER_NAMES.magenta).as('magenta'),
      yellow: pivot(TONER_NAMES.yellow).as('yellow'),
      meterBlack: pivot(METER_NAMES.black).as('meter_black'),
      meterColour: pivot(METER_NAMES.colour).as('meter_colour'),
      meterScan: pivot(METER_NAMES.scan).as('meter_scan'),
    })
    .from(latest)
    .leftJoin(counterValues, eq(counterValues.snapshotId, latest.snapshotId))
    .groupBy(latest.drmsId)
    .as('counter_pivot');
}

export function toNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Default threshold (hours) for treating a device that has reported before as "offline". */
export const DEFAULT_OFFLINE_HOURS = 24;

export function offlineCutoff(hours: number = DEFAULT_OFFLINE_HOURS): Date {
  return new Date(Date.now() - hours * 3_600_000);
}
