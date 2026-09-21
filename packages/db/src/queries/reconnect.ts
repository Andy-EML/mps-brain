import { and, count, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import { lastAlarmSubquery } from './shared';

/** Days without contact before a device that reports meter readings counts as silent. */
export const RECONNECT_DAYS = 14;

/** Silent for up to this many whole days is "newly silent"; longer is "long silent". */
export const NEWLY_SILENT_MAX_DAYS = 30;

/**
 * `all` = every silent device (`new` + `long`). `unmonitored` is the separate "Not monitored yet"
 * list: devices that have never sent a meter reading, which DRMS gives us no way to call offline.
 */
export type ReconnectFilter = 'all' | 'new' | 'long' | 'unmonitored';

export interface ReconnectRow {
  drmsId: string;
  serial: string | null;
  name: string | null;
  model: string | null;
  drmsStatus: string | null;
  /** The Vantage customer, falling back to DRMS's customer name. */
  customerName: string | null;
  customerReference: string | null;
  location: string | null;
  assetNumber: string | null;
  vantageEquipmentId: number;
  /** Newest of the meter reading and any alarm (DRMS's `LastAlarmReceivedTime` or our own feed). */
  lastContactAt: Date | null;
  /** Whole days since `lastContactAt`. Null for a device with no meter reading: it is not "silent". */
  daysSilent: number | null;
  /** Newest alarm, from DRMS's `LastAlarmReceivedTime` or our own `device_alarms`. */
  lastAlarmAt: Date | null;
  firstConnectedAt: Date | null;
  /** Has DRMS ever collected a meter reading? Only then is silence evidence of anything. */
  hasMeterReadings: boolean;
  /** Registered (or PreRegistered) in DRMS — the "waiting for first reading" group of the unmonitored list. */
  registeredInDrms: boolean;
}

export interface ReconnectOptions {
  filter?: ReconnectFilter;
  search?: string;
  /** Omit for every row (the CSV export). */
  limit?: number;
  offset?: number;
  now?: Date;
  days?: number;
}

export interface ReconnectCounts {
  silent: number;
  newlySilent: number;
  longSilent: number;
  unmonitored: number;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD HH:mm:ss` (or a `T` separator) with every field in range, years 1000–9999. */
const DRMS_DATE_SHAPE =
  '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])[ T]([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]';

/**
 * A DRMS date out of `drms_equipment.raw`. DRMS sends UTC as `YYYY-MM-DD HH:mm:ss`, sometimes an
 * empty string. The cast can never throw — one odd value must not fail the page (or, through the
 * sidebar badge, every page): the regex rejects out-of-range fields (`0000-00-00 00:00:00`,
 * `2026-13-40 25:00:00`), and a day past the end of its month (`2026-02-31`) is checked against
 * that month's length, worked out from the already-valid year and month. The CASEs are nested
 * because Postgres does not promise to evaluate the two halves of an AND in order.
 */
function rawUtc(key: string): SQL<Date | null> {
  const value = sql`(${drmsEquipment.raw} ->> ${key})`;
  const monthLength = sql`extract(day from ((substr(${value}, 1, 7) || '-01')::date + interval '1 month' - interval '1 day'))`;
  return sql<Date | null>`case when ${value} ~ ${sql.raw(`'${DRMS_DATE_SHAPE}'`)} then case when substr(${value}, 9, 2)::int <= ${monthLength} then substr(${value}, 1, 19)::timestamp at time zone 'UTC' end end`;
}

function at(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`;
}

/**
 * The shared pieces of `listReconnect` and `getReconnectCounts`: the last-contact expression and
 * the conditions for each list, so the page, its tab counts, the tile and the badge cannot disagree.
 *
 * DRMS has no heartbeat for a device that has never sent a meter reading (a Discovered machine can
 * check in on CSRC daily without DRMS ever hearing of it), so only a device with a meter reading is
 * judged on its silence. Everything else in scope goes to the "not monitored" list.
 */
function reconnectParts(db: Db, o: { now?: Date; days?: number }) {
  const now = o.now ?? new Date();
  const days = o.days ?? RECONNECT_DAYS;
  const alarms = lastAlarmSubquery(db);

  // `greatest` ignores nulls, so either signal alone is enough.
  const lastAlarmAt = sql<Date | null>`greatest(${rawUtc('LastAlarmReceivedTime')}, ${alarms.lastAlarmAt})`;
  const lastContactAt = sql<Date | null>`greatest(${drmsEquipment.lastCounterReceivedTime}, ${lastAlarmAt})`;

  const silentCutoff = new Date(now.getTime() - days * DAY_MS);
  // "30 days" whole: 30.9 days is still newly silent, 31 is over 30.
  const longCutoff = new Date(now.getTime() - (NEWLY_SILENT_MAX_DAYS + 1) * DAY_MS);

  const hasReadings = sql`${drmsEquipment.lastCounterReceivedTime} is not null`;
  const silent = sql`(${hasReadings} and ${lastContactAt} < ${at(silentCutoff)})`;
  const conditions: Record<ReconnectFilter, SQL> = {
    all: silent,
    new: sql`(${silent} and ${lastContactAt} > ${at(longCutoff)})`,
    long: sql`(${silent} and ${lastContactAt} <= ${at(longCutoff)})`,
    unmonitored: sql`${drmsEquipment.lastCounterReceivedTime} is null`,
  };

  // On a Vantage contract (active link, equipment not deleted) and still expected in DRMS.
  const scope = and(
    isNull(vantageEquipment.deletedDate),
    isNull(drmsEquipment.missingSince),
    sql`coalesce(upper(${drmsEquipment.status}), '') <> 'DELETED'`,
  );

  const registeredInDrms = sql<boolean>`coalesce(upper(${drmsEquipment.status}), '') in ('REGISTERED', 'PREREGISTERED')`;

  return { now, alarms, lastAlarmAt, lastContactAt, conditions, scope, registeredInDrms };
}

type Parts = ReturnType<typeof reconnectParts>;

/**
 * The joins every query here needs, on a `select(...).from(drmsEquipment).$dynamic()`: the active
 * link and its Vantage equipment (inner — a device off contract is out of scope), and our newest
 * alarm per device (one row per device, so it cannot multiply rows or a count). Returned as `T`,
 * like `joinDeviceList`: callers select explicit fields.
 */
function joinScope<T extends PgSelect>(qb: T, p: Parts): T {
  return qb
    .innerJoin(
      deviceLinks,
      and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)),
    )
    .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(p.alarms, eq(p.alarms.drmsId, drmsEquipment.drmsId)) as unknown as T;
}

const customerName = sql<
  string | null
>`coalesce(${vantageEquipment.customerName}, ${drmsEquipment.customerName})`;

export async function listReconnect(
  db: Db,
  o: ReconnectOptions = {},
): Promise<{ rows: ReconnectRow[]; total: number }> {
  const p = reconnectParts(db, o);
  const filter = o.filter ?? 'all';

  const conds = [p.scope, p.conditions[filter]];
  if (o.search) {
    const q = `%${o.search}%`;
    conds.push(
      sql`(${vantageEquipment.customerName} ilike ${q} or ${drmsEquipment.customerName} ilike ${q} or ${vantageEquipment.customerReference} ilike ${q} or ${drmsEquipment.serial} ilike ${q})`,
    );
  }
  const where = and(...conds);

  // Silent lists: most recently silent first, so a machine that has just dropped off is on top.
  // The unmonitored list has no contact date to sort by: registered devices first, then by customer.
  const order =
    filter === 'unmonitored'
      ? [
          sql`${p.registeredInDrms} desc`,
          sql`${customerName} asc nulls last`,
          sql`${drmsEquipment.serial} asc nulls last`,
        ]
      : [
          sql`${p.lastContactAt} desc nulls last`,
          sql`${customerName} asc nulls last`,
          sql`${drmsEquipment.serial} asc nulls last`,
        ];

  let rowsQuery = joinScope(
    db
      .select({
        drmsId: drmsEquipment.drmsId,
        serial: drmsEquipment.serial,
        name: drmsEquipment.productName,
        model: drmsEquipment.modelName,
        drmsStatus: drmsEquipment.status,
        customerName,
        customerReference: vantageEquipment.customerReference,
        location: vantageEquipment.location,
        assetNumber: vantageEquipment.assetNumber,
        vantageEquipmentId: vantageEquipment.vantageId,
        // Mapped through a timestamp column so the value comes back as a Date whatever the driver.
        lastContactAt: p.lastContactAt.mapWith(drmsEquipment.lastCounterReceivedTime),
        lastAlarmAt: p.lastAlarmAt.mapWith(drmsEquipment.lastCounterReceivedTime),
        firstConnectedAt: drmsEquipment.initialConnectionTime,
        lastCounterAt: drmsEquipment.lastCounterReceivedTime,
        registeredInDrms: p.registeredInDrms.mapWith(Boolean),
      })
      .from(drmsEquipment)
      .$dynamic(),
    p,
  )
    .where(where)
    .orderBy(...order);
  if (o.limit !== undefined) rowsQuery = rowsQuery.limit(o.limit);
  if (o.offset) rowsQuery = rowsQuery.offset(o.offset);

  const countQuery = joinScope(db.select({ n: count() }).from(drmsEquipment).$dynamic(), p).where(
    where,
  );

  const [rows, [totalRow]] = await Promise.all([rowsQuery, countQuery]);
  return {
    rows: rows.map((r) => {
      const hasMeterReadings = r.lastCounterAt !== null;
      const lastContactAt = r.lastContactAt ?? null;
      return {
        drmsId: r.drmsId,
        serial: r.serial,
        name: r.name,
        model: r.model,
        drmsStatus: r.drmsStatus,
        customerName: r.customerName,
        customerReference: r.customerReference,
        location: r.location,
        assetNumber: r.assetNumber,
        vantageEquipmentId: r.vantageEquipmentId,
        lastContactAt,
        daysSilent:
          hasMeterReadings && lastContactAt
            ? Math.floor((p.now.getTime() - lastContactAt.getTime()) / DAY_MS)
            : null,
        lastAlarmAt: r.lastAlarmAt ?? null,
        firstConnectedAt: r.firstConnectedAt,
        hasMeterReadings,
        registeredInDrms: r.registeredInDrms,
      };
    }),
    total: Number(totalRow?.n ?? 0),
  };
}

/**
 * The tab counts, the Fleet overview tile and the sidebar badge, in one query. Tile and badge use
 * the silent counts only — a device with no meter reading is never counted as needing reconnection.
 */
export async function getReconnectCounts(
  db: Db,
  o: { now?: Date; days?: number } = {},
): Promise<ReconnectCounts> {
  const p = reconnectParts(db, o);
  const [row] = await joinScope(
    db
      .select({
        silent: sql<number>`count(*) filter (where ${p.conditions.all})`,
        newlySilent: sql<number>`count(*) filter (where ${p.conditions.new})`,
        longSilent: sql<number>`count(*) filter (where ${p.conditions.long})`,
        unmonitored: sql<number>`count(*) filter (where ${p.conditions.unmonitored})`,
      })
      .from(drmsEquipment)
      .$dynamic(),
    p,
  ).where(p.scope);
  return {
    silent: Number(row?.silent ?? 0),
    newlySilent: Number(row?.newlySilent ?? 0),
    longSilent: Number(row?.longSilent ?? 0),
    unmonitored: Number(row?.unmonitored ?? 0),
  };
}
