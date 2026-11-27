import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { counterSnapshots, counterValues, deviceLinks, vantageMeterReadings } from '../schema';
import {
  mergeSnapshots,
  VANTAGE_BLACK_A3_TYPE,
  vantageSnapshots,
  type MeterSnapshot,
  type VantageMeterPoint,
  type YieldMeterPoint,
} from './toner-yield';

const BLACK_METER = 'Black:Total';
const COLOUR_METER = 'Full Color:Total';
/** DRMS snapshots older than this are not loaded (Vantage readings go back 24 months; DRMS history is short so this is not the limiting window). */
const DRMS_HISTORY_MONTHS = 13;

/** Combined page meter of one snapshot: black + colour where a colour meter exists, else black. */
export function combinedValue(s: Pick<MeterSnapshot, 'black' | 'colour'>): number | null {
  if (s.black === null) return null;
  return s.colour !== null ? s.black + s.colour : s.black;
}

/**
 * Combined (mono + colour) page meter history per Vantage equipment id, oldest first. Vantage readings
 * are merged with the DRMS counter snapshots of the machine's linked device when there is one. A
 * machine with a `Black A3` meter has no series (its scale is unverified), and one with no readings
 * at all is absent from the map.
 */
export async function loadCombinedMeters(
  db: Db,
  vantageEquipmentIds: number[],
  now: Date = new Date(),
): Promise<Map<number, YieldMeterPoint[]>> {
  return seriesOf(await loadMergedSnapshots(db, vantageEquipmentIds, now), combinedValue);
}

/**
 * The colour (`Full Color:Total`) page meter history per Vantage equipment id, oldest first, from the
 * same merged sources as {@link loadCombinedMeters}. A machine with no colour meter is absent.
 */
export async function loadColourMeters(
  db: Db,
  vantageEquipmentIds: number[],
  now: Date = new Date(),
): Promise<Map<number, YieldMeterPoint[]>> {
  return seriesOf(await loadMergedSnapshots(db, vantageEquipmentIds, now), (s) => s.colour);
}

/** Combined and colour meter series from one load of the merged snapshots (see the two loaders above). */
export async function loadMeterSeries(
  db: Db,
  vantageEquipmentIds: number[],
  now: Date = new Date(),
): Promise<{ combined: Map<number, YieldMeterPoint[]>; colour: Map<number, YieldMeterPoint[]> }> {
  const snaps = await loadMergedSnapshots(db, vantageEquipmentIds, now);
  return { combined: seriesOf(snaps, combinedValue), colour: seriesOf(snaps, (s) => s.colour) };
}

function seriesOf(
  snaps: Map<number, MeterSnapshot[]>,
  pick: (s: Pick<MeterSnapshot, 'black' | 'colour'>) => number | null,
): Map<number, YieldMeterPoint[]> {
  const out = new Map<number, YieldMeterPoint[]>();
  for (const [id, list] of snaps) {
    const series: YieldMeterPoint[] = [];
    for (const s of list) {
      const value = pick(s);
      if (value !== null) series.push({ at: s.at, value });
    }
    if (series.length > 0) out.set(id, series.sort((a, b) => a.at.getTime() - b.at.getTime()));
  }
  return out;
}

async function loadMergedSnapshots(
  db: Db,
  vantageEquipmentIds: number[],
  now: Date,
): Promise<Map<number, MeterSnapshot[]>> {
  const since = new Date(now.getTime());
  since.setUTCMonth(since.getUTCMonth() - DRMS_HISTORY_MONTHS);
  const out = new Map<number, MeterSnapshot[]>();
  const ids = [...new Set(vantageEquipmentIds)];
  if (ids.length === 0) return out;

  const readings = await db
    .select({
      equipmentId: vantageMeterReadings.vantageEquipmentId,
      at: vantageMeterReadings.readingAt,
      typeId: vantageMeterReadings.meterTypeId,
      value: vantageMeterReadings.reading,
    })
    .from(vantageMeterReadings)
    .where(inArray(vantageMeterReadings.vantageEquipmentId, ids))
    .orderBy(asc(vantageMeterReadings.readingAt));
  const points = new Map<number, VantageMeterPoint[]>();
  for (const r of readings) {
    const list = points.get(r.equipmentId) ?? [];
    list.push(r);
    points.set(r.equipmentId, list);
  }

  const links = await db
    .select({ drmsId: deviceLinks.drmsEquipmentId, vantageId: deviceLinks.vantageEquipmentId })
    .from(deviceLinks)
    .where(and(isNull(deviceLinks.unlinkedAt), inArray(deviceLinks.vantageEquipmentId, ids)));
  const vantageOfDrms = new Map<string, number>();
  for (const l of links) vantageOfDrms.set(l.drmsId, l.vantageId);

  const drmsSnaps = new Map<number, MeterSnapshot[]>();
  if (vantageOfDrms.size > 0) {
    const rows = await db
      .select({
        drmsId: counterSnapshots.drmsEquipmentId,
        snapshotId: counterSnapshots.id,
        at: counterSnapshots.receivedTime,
        name: counterValues.name,
        value: counterValues.value,
      })
      .from(counterValues)
      .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
      .where(
        and(
          inArray(counterValues.name, [BLACK_METER, COLOUR_METER]),
          gte(counterSnapshots.receivedTime, since),
          inArray(counterSnapshots.drmsEquipmentId, [...vantageOfDrms.keys()]),
        ),
      )
      .orderBy(asc(counterSnapshots.receivedTime), asc(counterSnapshots.id));
    const bySnap = new Map<number, MeterSnapshot & { drmsId: string }>();
    for (const r of rows) {
      if (!r.at) continue;
      let s = bySnap.get(r.snapshotId);
      if (!s) {
        s = { drmsId: r.drmsId, at: r.at, black: null, colour: null };
        bySnap.set(r.snapshotId, s);
      }
      if (r.name === BLACK_METER) s.black = r.value;
      else s.colour = r.value;
    }
    for (const s of bySnap.values()) {
      const vid = vantageOfDrms.get(s.drmsId);
      if (vid === undefined) continue;
      const list = drmsSnaps.get(vid) ?? [];
      list.push({ at: s.at, black: s.black, colour: s.colour });
      drmsSnaps.set(vid, list);
    }
  }

  for (const id of ids) {
    const vp = points.get(id) ?? [];
    if (vp.some((p) => p.typeId === VANTAGE_BLACK_A3_TYPE)) continue;
    const merged = mergeSnapshots(drmsSnaps.get(id) ?? [], vantageSnapshots(vp));
    const series: MeterSnapshot[] = [];
    // On a machine that has a colour meter, a snapshot missing it must not read as black only (a false
    // drop would look like a meter reset): carry the last known colour forward, or skip the point.
    const hasColour = merged.some((s) => s.colour !== null);
    let lastColour: number | null = null;
    for (const s of merged) {
      let snap = s;
      if (s.colour !== null) lastColour = s.colour;
      else if (hasColour) {
        if (lastColour === null) continue;
        snap = { ...s, colour: lastColour };
      }
      series.push(snap);
    }
    if (series.length > 0) out.set(id, series);
  }
  return out;
}
