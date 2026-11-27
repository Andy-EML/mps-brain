import { DELIVERY_LEVEL, effectiveTonerLevel, type TonerColour } from '@mps/core';
import { eq, max, sql, type AnyColumn, type SQL, type SQLWrapper } from 'drizzle-orm';
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
 * WHERE predicate for any Toner Delivery or Waste Toner Bottle Delivery alarm. The literal is inlined (not a
 * bound parameter) and is exactly the predicate of the partial index `device_alarms_delivery_idx`
 * (migration 0026), so the planner can use that index. Change the two together.
 */
export function deliveryAlarmSql() {
  return sql`${deviceAlarms.description} ~* ${sql.raw("'toner (bottle )?delivery'")}`;
}

/**
 * Subquery: one row per device with the time of its newest Toner Delivery alarm per colour (any DRMS
 * status). A Delivery is a new cartridge fitted; `counterPivotSubquery` carries these so the level it
 * reports can be made effective (see `effectiveToner` / `effectiveLevelSql`).
 */
export function latestDeliverySubquery(db: Db) {
  const at = (re: string) => sql<Date | null>`max(${deviceAlarms.receivedTime}) filter (where ${deviceAlarms.description} ~* ${re})`.mapWith(deviceAlarms.receivedTime);
  return db
    .select({
      drmsId: deviceAlarms.drmsEquipmentId,
      // `[(]` and `[)]`, not escaped brackets, so the pattern survives string escaping.
      black: at('Toner Delivery[(](BK|K)[)]').as('delivery_black'),
      cyan: at('Toner Delivery[(]C[)]').as('delivery_cyan'),
      magenta: at('Toner Delivery[(]M[)]').as('delivery_magenta'),
      yellow: at('Toner Delivery[(]Y[)]').as('delivery_yellow'),
      waste: at('Waste Toner Bottle Delivery').as('delivery_waste'),
    })
    .from(deviceAlarms)
    .where(deliveryAlarmSql())
    .groupBy(deviceAlarms.drmsEquipmentId)
    .as('latest_delivery');
}

/**
 * Subquery: one row per device with its latest toner + meter readings pivoted into columns.
 *
 * The toner columns are the raw DRMS readings. `readAt` (when that snapshot was taken) and the
 * `*DeliveryAt` columns (newest Toner Delivery alarm per colour; colour ones null on a mono device)
 * go with them: a Delivery newer than the reading means a new cartridge, which `effectiveToner`
 * (rows) and `effectiveLevelSql` (WHERE/aggregates) turn into 100%.
 * `leftJoin` this on `drmsId` so devices without any snapshot still appear (all columns null).
 *
 * Joins `drms_equipment` only for `is_colour`; the join is on the snapshot's device, which is a
 * foreign key into that table, so it can neither drop nor multiply rows.
 */
export function counterPivotSubquery(db: Db) {
  const latest = latestSnapshotSubquery(db);
  const del = latestDeliverySubquery(db);
  // A colour Delivery only counts on a device that has that cartridge (same rule as `colourPivot`).
  const colourDelivery = (c: SQLWrapper) => sql<Date | null>`case when ${drmsEquipment.isColour} then max(${c}) end`.mapWith(deviceAlarms.receivedTime);
  return db
    .select({
      drmsId: latest.drmsId,
      // A snapshot with no `received_time` is read at when we fetched it, so it never looks older than a Delivery it followed.
      readAt: sql<Date | null>`max(coalesce(${counterSnapshots.receivedTime}, ${counterSnapshots.fetchedAt}))`.mapWith(counterSnapshots.fetchedAt).as('read_at'),
      blackDeliveryAt: sql<Date | null>`max(${del.black})`.mapWith(deviceAlarms.receivedTime).as('black_delivery_at'),
      cyanDeliveryAt: colourDelivery(del.cyan).as('cyan_delivery_at'),
      magentaDeliveryAt: colourDelivery(del.magenta).as('magenta_delivery_at'),
      yellowDeliveryAt: colourDelivery(del.yellow).as('yellow_delivery_at'),
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
    .leftJoin(counterSnapshots, eq(counterSnapshots.id, latest.snapshotId))
    .leftJoin(del, eq(del.drmsId, latest.drmsId))
    // `is_colour` is grouped, not aggregated: it is one value per device, and the colour pivots
    // above read it outside their own `max(...)`.
    .groupBy(latest.drmsId, drmsEquipment.isColour)
    .as('counter_pivot');
}

/**
 * SQL mirror of `effectiveTonerLevel` (@mps/core), for WHERE clauses, aggregates and ORDER BY that
 * cannot call it: a Delivery newer than the reading (or with no reading) reads as 100%. Parity with the
 * core helper is tested (`effective-level.test.ts`); change both together.
 */
export function effectiveLevelSql(level: SQLWrapper, readAt: SQLWrapper, deliveryAt: SQLWrapper): SQL<number | null> {
  return sql<number | null>`(case when ${deliveryAt} is not null and (${readAt} is null or ${deliveryAt} > ${readAt}) then ${sql.raw(String(DELIVERY_LEVEL))} else ${level} end)`;
}

/** The four effective toner levels of a pivot row, as SQL. */
export function effectivePivotLevels(pivot: ReturnType<typeof counterPivotSubquery>) {
  return {
    black: effectiveLevelSql(pivot.black, pivot.readAt, pivot.blackDeliveryAt),
    cyan: effectiveLevelSql(pivot.cyan, pivot.readAt, pivot.cyanDeliveryAt),
    magenta: effectiveLevelSql(pivot.magenta, pivot.readAt, pivot.magentaDeliveryAt),
    yellow: effectiveLevelSql(pivot.yellow, pivot.readAt, pivot.yellowDeliveryAt),
  };
}

/** The pivot columns `effectiveToner` reads. */
export interface PivotTonerRow {
  black: unknown;
  cyan: unknown;
  magenta: unknown;
  yellow: unknown;
  readAt: Date | null;
  blackDeliveryAt: Date | null;
  cyanDeliveryAt: Date | null;
  magentaDeliveryAt: Date | null;
  yellowDeliveryAt: Date | null;
}

/**
 * A pivot row's toner as shown and used: the effective levels (a newer Delivery reads 100%) and, for
 * each colour a Delivery overrode, the date of the new cartridge.
 */
export function effectiveToner(row: PivotTonerRow): {
  toner: Record<TonerColour, number | null>;
  tonerNew: Partial<Record<TonerColour, Date>>;
} {
  const toner = {} as Record<TonerColour, number | null>;
  const tonerNew: Partial<Record<TonerColour, Date>> = {};
  for (const c of ['black', 'cyan', 'magenta', 'yellow'] as const) {
    const e = effectiveTonerLevel({ level: toNumberOrNull(row[c]), readAt: row.readAt ?? null, deliveryAt: row[`${c}DeliveryAt`] ?? null });
    toner[c] = e.level;
    if (e.newCartridgeAt) tonerNew[c] = e.newCartridgeAt;
  }
  return { toner, tonerNew };
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
  const l = effectivePivotLevels(pivot);
  return sql`(${l.black} < ${eff.thresholdBlack} or ${l.cyan} < ${eff.thresholdCyan} or ${l.magenta} < ${eff.thresholdMagenta} or ${l.yellow} < ${eff.thresholdYellow})`;
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
