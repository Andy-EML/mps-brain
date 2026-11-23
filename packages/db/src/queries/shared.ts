import { eq, max, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { counterSnapshots, counterValues, deviceAlarms, drmsEquipment, hiddenDevices } from '../schema';
import type { effectiveSettingsSubquery } from './settings';

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
 * DRMS's own equipment `Name` ("Hazell & Jefferies Downstairs C450i"), kept only in `raw`. Not the
 * `product_name` column, which is the model with a firmware suffix ("bizhub C300i_Ver22"). Feeds
 * `deviceDisplayName` (@mps/core).
 */
export function drmsEquipmentName() {
  return sql<string | null>`${drmsEquipment.raw}->>'Name'`;
}

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

/**
 * True when any cartridge the device has is strictly below its effective threshold for that
 * colour — THE "needs toner" test, shared by the fleet summary and the devices-list `needs-toner`
 * / `manual` filters (paired with `eff.autoReplenish`). Null-safe on both sides: a colour pivot column
 * that's null (no cartridge — see `colourPivot` above — or simply no reading yet) never matches,
 * and neither does an `effectiveSettingsSubquery` row that failed to join (every DRMS device has
 * one in practice, but a left join is what the caller uses, so this stays correct even if that
 * ever isn't true).
 */
export function belowThreshold(
  pivot: ReturnType<typeof counterPivotSubquery>,
  eff: ReturnType<typeof effectiveSettingsSubquery>,
): SQL {
  return sql`(${pivot.black} < ${eff.thresholdBlack} or ${pivot.cyan} < ${eff.thresholdCyan} or ${pivot.magenta} < ${eff.thresholdMagenta} or ${pivot.yellow} < ${eff.thresholdYellow})`;
}

/**
 * True for a device that is not hidden. `drmsId` is whatever column (or expression) carries the
 * DRMS id in the caller's query — `drms_equipment.drms_id`, `link_issues.drms_equipment_id`, a
 * subquery's alias — so the test can sit in any WHERE without a join that could multiply rows.
 * A null id (a link issue about Vantage equipment alone) is never hidden.
 *
 * Lives here rather than in `hidden-devices.ts` so the list and count modules can import it
 * without a cycle; that module re-exports it.
 */
export function notHiddenDevice(drmsId: AnyColumn | SQL): SQL {
  return sql`not exists (select 1 from ${hiddenDevices} where ${hiddenDevices.drmsEquipmentId} = ${drmsId})`;
}

export function toNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Default threshold (hours) for treating a device that has reported before as "offline". */
export const DEFAULT_OFFLINE_HOURS = 24;

export function offlineCutoff(hours: number = DEFAULT_OFFLINE_HOURS): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

export type SortDir = 'asc' | 'desc';

/** A requested sort: one of a list's `*_SORT_KEYS` and a direction. */
export interface SortSpec<K extends string> {
  key: K;
  dir: SortDir;
}

/**
 * The ORDER BY for a sortable list: the chosen key's expression in the chosen direction with nulls
 * last either way, then `tiebreak` (the row id) so a page break never falls between ties. No sort
 * (or a key the map does not know, which a hostile query string could send) gives `fallback()`,
 * the list's own default order, untouched.
 */
export function sortOrder<K extends string>(
  map: Record<K, SQL>,
  sort: SortSpec<K> | undefined,
  fallback: () => SQL[],
  tiebreak: SQL,
): SQL[] {
  if (!sort || !Object.hasOwn(map, sort.key)) return fallback();
  const dir = sort.dir === 'desc' ? sql.raw('desc') : sql.raw('asc');
  return [sql`${map[sort.key]} ${dir} nulls last`, tiebreak];
}

/** What a sortable column of an in-memory list can yield; null/undefined (and NaN) sort last. */
export type SortValue = string | number | boolean | Date | null | undefined;

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { sensitivity: 'base' });
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return Number(a) - Number(b);
}

const isBlank = (v: SortValue): boolean => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

/**
 * The comparator for a sortable list that is sorted in memory (the SQL lists use `sortOrder`):
 * the chosen key's value in the chosen direction with blanks last either way, then the row `id`
 * ascending so a page break never falls between ties. No sort, or a key the map does not know
 * (a hostile query string), gives `fallback` — the list's own default order, untouched.
 */
export function compareBy<T, K extends string>(
  getters: Record<K, (row: T) => SortValue>,
  sort: SortSpec<K> | undefined,
  id: (row: T) => string | number,
  fallback: (a: T, b: T) => number = () => 0,
): (a: T, b: T) => number {
  if (!sort || !Object.hasOwn(getters, sort.key)) return fallback;
  const get = getters[sort.key];
  const sign = sort.dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    const blankX = isBlank(x);
    const blankY = isBlank(y);
    if (blankX !== blankY) return blankX ? 1 : -1;
    const c = blankX ? 0 : sign * compareValues(x, y);
    if (c !== 0) return c;
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };
}
