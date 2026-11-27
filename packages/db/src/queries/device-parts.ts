import {
  PART_COLOURS,
  classifyPart,
  isColourModel,
  isColourPart,
  parsePartsAlarm,
  partLifeKey,
  type PartAlarmLevel,
  type PartColour,
  type PartKind,
  type PartLives,
} from '@mps/core';
import { and, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../client';
import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  vantageEquipment,
} from '../schema';
import { loadMeterSeries } from './meter-history';
import { DEFAULT_PM_SETTINGS, groupVisits, londonDay, type Visit } from './pm-due';
import { loadVisits } from './pm-queries';
import { METER_NAMES, TONER_NAMES } from './shared';
import { INTERPOLATE_MAX_DAYS, meterAt, type YieldMeterPoint } from './toner-yield';

const DAY_MS = 86_400_000;

/** `ok` = no alarm; `cleared` = there was an alarm but the part has been fitted since. */
export type PartState = PartAlarmLevel | 'cleared' | 'ok';

export interface PartStatusRow {
  part: PartKind;
  /** The colour for a drum or developer; null for the one-per-machine parts. */
  colour: PartColour | null;
  state: PartState;
  /** The alarm behind `state`: the part's latest alarm (cleared when a fit came on or after its day); null when none. */
  alarm: { level: PartAlarmLevel; receivedAt: Date } | null;
  /** The latest visit where this part (and colour) was fitted; null when not seen in the visit history. */
  lastFitted: { day: string; at: Date } | null;
  /** Pages printed since the fit (colour parts C/M/Y count colour pages; the rest count all pages); null when unknown. */
  pagesSince: number | null;
  /** The meter at the fit was interpolated between two readings. */
  pagesSinceEstimated: boolean;
  ratedLife: number | null;
  /** Estimated life left as a fraction (0.12 = 12%); null when no rated life or pages since is unknown. */
  pctLeft: number | null;
}

export interface DeviceTonerLevels {
  black: number | null;
  cyan: number | null;
  magenta: number | null;
  yellow: number | null;
  /** When the latest DRMS counters were received; null when the device has none. */
  readAt: Date | null;
}

export interface DeviceParts {
  drmsEquipmentId: string | null;
  vantageEquipmentId: number | null;
  model: string | null;
  isColour: boolean;
  familyId: number | null;
  familyName: string | null;
  toner: DeviceTonerLevels;
  /** Combined (black + colour) page meter now; null when no meter is known. */
  pagesNow: number | null;
  /** The latest attended field visit (any length) and the pages printed since it. */
  lastVisit: { day: string; at: Date; pagesSince: number | null } | null;
  parts: PartStatusRow[];
  /** The machine's own `PM Warning(PM Count)` alarm, unless a field visit on or after its day has happened since. */
  pmCountWarning: { receivedAt: Date } | null;
}

const SEVERITY: Record<PartAlarmLevel, number> = { end: 3, near_end: 2, predicted: 1 };

interface Alarm {
  level: PartAlarmLevel;
  at: Date;
}

/**
 * The latest alarm: the current life cycle's state (a 1st call or prediction after an end means the
 * part was replaced since), the most severe among alarms at the same instant.
 */
function latest(alarms: Alarm[]): Alarm | null {
  let best: Alarm | null = null;
  for (const a of alarms) {
    if (!best || a.at > best.at || (a.at.getTime() === best.at.getTime() && SEVERITY[a.level] > SEVERITY[best.level])) best = a;
  }
  return best;
}

/**
 * Meter at a fit date, or null when no reading is within the interpolation limit. When the reading
 * before the fit is too old but one after it is within the limit, that later reading is used and
 * flagged `estimated` (it is not the meter at the fit, so pages since is approximate).
 */
function meterAtFit(series: YieldMeterPoint[], at: Date): { value: number; estimated: boolean } | null {
  const m = meterAt(series, at);
  if (!m) return null;
  if (m.estimated) return { value: m.value, estimated: true };
  const limit = INTERPOLATE_MAX_DAYS * DAY_MS;
  const ref = m.before ?? m.after;
  if (ref && Math.abs(ref.at.getTime() - at.getTime()) <= limit) return { value: m.value, estimated: false };
  if (m.before) {
    const later = series.find((p) => p.at.getTime() > at.getTime());
    if (later && later.at.getTime() - at.getTime() <= limit) return { value: later.value, estimated: true };
  }
  return null;
}

const lastOf = <T>(xs: T[]): T | null => (xs.length > 0 ? (xs[xs.length - 1] as T) : null);

/**
 * Wear-part status and toner levels for one machine, by DRMS id and/or Vantage equipment id (the
 * other is found through the active device link). Fits come from Vantage visits (parts used), alarms
 * from DRMS, rated lives from the machine's cartridge family. See the 2026-11-26 parts-status plan.
 */
export async function getDeviceParts(
  db: Db,
  ids: { drmsEquipmentId?: string | null; vantageEquipmentId?: number | null },
  now: Date = new Date(),
): Promise<DeviceParts> {
  let drmsId = ids.drmsEquipmentId ?? null;
  let vantageId = ids.vantageEquipmentId ?? null;
  if (drmsId !== null && vantageId === null) {
    const [l] = await db
      .select({ v: deviceLinks.vantageEquipmentId })
      .from(deviceLinks)
      .where(and(eq(deviceLinks.drmsEquipmentId, drmsId), isNull(deviceLinks.unlinkedAt)))
      .limit(1);
    vantageId = l?.v ?? null;
  } else if (vantageId !== null && drmsId === null) {
    const [l] = await db
      .select({ d: deviceLinks.drmsEquipmentId })
      .from(deviceLinks)
      .where(and(eq(deviceLinks.vantageEquipmentId, vantageId), isNull(deviceLinks.unlinkedAt)))
      .limit(1);
    drmsId = l?.d ?? null;
  }

  let model: string | null = null;
  if (drmsId !== null) {
    const [e] = await db.select({ m: drmsEquipment.modelName }).from(drmsEquipment).where(eq(drmsEquipment.drmsId, drmsId));
    model = e?.m ?? null;
  }
  if (model === null && vantageId !== null) {
    const [e] = await db
      .select({ m: vantageEquipment.description })
      .from(vantageEquipment)
      .where(eq(vantageEquipment.vantageId, vantageId));
    model = e?.m ?? null;
  }
  const isColour = isColourModel(model);

  let family: { id: number; name: string; lives: PartLives } | null = null;
  if (model !== null) {
    const [f] = await db
      .select({ f: cartridgeFamilies })
      .from(cartridgeFamilyModels)
      .innerJoin(cartridgeFamilies, eq(cartridgeFamilies.id, cartridgeFamilyModels.familyId))
      .where(eq(cartridgeFamilyModels.model, model));
    if (f) {
      family = {
        id: f.f.id,
        name: f.f.name,
        lives: {
          drumK: f.f.lifeDrumK,
          drumCmy: f.f.lifeDrumCmy,
          developerK: f.f.lifeDeveloperK,
          developerCmy: f.f.lifeDeveloperCmy,
          transferBelt: f.f.lifeTransferBelt,
          transferRoller: f.f.lifeTransferRoller,
          fuser: f.f.lifeFuser,
        },
      };
    }
  }

  // Latest DRMS counters: toner levels, and the meters as a fallback for pages now.
  const toner: DeviceTonerLevels = { black: null, cyan: null, magenta: null, yellow: null, readAt: null };
  let drmsPagesNow: number | null = null;
  if (drmsId !== null) {
    const [snap] = await db
      .select({ id: counterSnapshots.id, at: counterSnapshots.receivedTime })
      .from(counterSnapshots)
      .where(eq(counterSnapshots.drmsEquipmentId, drmsId))
      .orderBy(desc(counterSnapshots.id))
      .limit(1);
    if (snap) {
      toner.readAt = snap.at;
      const rows = await db
        .select({ name: counterValues.name, value: counterValues.value })
        .from(counterValues)
        .where(
          and(
            eq(counterValues.snapshotId, snap.id),
            inArray(counterValues.name, [...Object.values(TONER_NAMES), METER_NAMES.black, METER_NAMES.colour]),
          ),
        );
      const by = new Map(rows.map((r) => [r.name, r.value]));
      toner.black = by.get(TONER_NAMES.black) ?? null;
      if (isColour) {
        toner.cyan = by.get(TONER_NAMES.cyan) ?? null;
        toner.magenta = by.get(TONER_NAMES.magenta) ?? null;
        toner.yellow = by.get(TONER_NAMES.yellow) ?? null;
      }
      const black = by.get(METER_NAMES.black) ?? null;
      if (black !== null) drmsPagesNow = black + (by.get(METER_NAMES.colour) ?? 0);
    }
  }

  const alarmRows =
    drmsId === null
      ? []
      : await db
          .select({ description: deviceAlarms.description, at: deviceAlarms.receivedTime })
          .from(deviceAlarms)
          .where(
            and(
              eq(deviceAlarms.drmsEquipmentId, drmsId),
              or(eq(deviceAlarms.category, 'parts'), ilike(deviceAlarms.description, '%PM Warning%')),
            ),
          );

  const vid = vantageId;
  const [visitMap, series] =
    vid === null
      ? [new Map<number, never[]>(), { combined: new Map<number, YieldMeterPoint[]>(), colour: new Map<number, YieldMeterPoint[]>() }]
      : await Promise.all([loadVisits(db, [vid]), loadMeterSeries(db, [vid], now)]);
  const visits: Visit[] = vid === null ? [] : groupVisits(visitMap.get(vid) ?? [], DEFAULT_PM_SETTINGS, now);
  const combined: YieldMeterPoint[] = vid === null ? [] : (series.combined.get(vid) ?? []);
  const colourSeries: YieldMeterPoint[] = vid === null ? [] : (series.colour.get(vid) ?? []);
  const pagesNow = lastOf(combined)?.value ?? drmsPagesNow;
  const colourPagesNow = lastOf(colourSeries)?.value ?? null;

  // Newest fit per part + colour (visits are newest first).
  const fits = new Map<string, Visit>();
  for (const v of visits) {
    for (const u of v.units) {
      for (const p of u.parts) {
        const c = classifyPart(p.description, isColour);
        if (!c) continue;
        const colours: (PartColour | null)[] = isColourPart(c.part) ? c.colours : [null];
        for (const colour of colours) {
          const key = `${c.part}:${colour ?? ''}`;
          if (!fits.has(key)) fits.set(key, v);
        }
      }
    }
  }

  // Alarms per part + colour.
  const alarms = new Map<string, Alarm[]>();
  let pmCountAt: Date | null = null;
  for (const a of alarmRows) {
    if (!a.at) continue;
    if (a.description && /PM Warning/i.test(a.description)) {
      if (pmCountAt === null || a.at > pmCountAt) pmCountAt = a.at;
    }
    const parsed = parsePartsAlarm(a.description);
    if (!parsed) continue;
    const key = `${parsed.part}:${parsed.colour ?? ''}`;
    const list = alarms.get(key) ?? [];
    list.push({ level: parsed.level, at: a.at });
    alarms.set(key, list);
  }

  const wanted: { part: PartKind; colour: PartColour | null }[] = [];
  const colours: PartColour[] = isColour ? [...PART_COLOURS] : ['K'];
  const lives = family?.lives ?? null;
  const evidence = (part: PartKind) =>
    fits.has(`${part}:`) || alarms.has(`${part}:`) || (lives !== null && lives[partLifeKey(part, null)] !== null);
  // Developer rows only with evidence on a colour machine (many imaging-unit models have it inside the IU).
  const developerEvidence = () =>
    PART_COLOURS.some(
      (c) =>
        fits.has(`developer:${c}`) ||
        alarms.has(`developer:${c}`) ||
        (lives !== null && lives[partLifeKey('developer', c)] !== null),
    );
  for (const colour of colours) wanted.push({ part: 'drum', colour });
  if (!isColour || developerEvidence()) for (const colour of colours) wanted.push({ part: 'developer', colour });
  if (isColour || evidence('transfer_belt')) wanted.push({ part: 'transfer_belt', colour: null });
  if (evidence('transfer_roller')) wanted.push({ part: 'transfer_roller', colour: null });
  wanted.push({ part: 'fuser', colour: null });

  const parts: PartStatusRow[] = wanted.map(({ part, colour }) => {
    const key = `${part}:${colour ?? ''}`;
    const fit = fits.get(key) ?? null;
    const all = alarms.get(key) ?? [];
    const fitDay = fit ? fit.day : null;
    // An alarm is cleared when the part was fitted on or after the alarm's day.
    // The latest alarm is the part's current state; a fit on or after its day clears it.
    const alarm = latest(all);
    const cleared = alarm !== null && fitDay !== null && londonDay(alarm.at) <= fitDay;
    const state: PartState = alarm ? (cleared ? 'cleared' : alarm.level) : 'ok';

    const useColour = colour === 'C' || colour === 'M' || colour === 'Y';
    const series = useColour ? colourSeries : combined;
    const nowPages = useColour ? colourPagesNow : pagesNow;
    let pagesSince: number | null = null;
    let estimated = false;
    if (fit && nowPages !== null) {
      const m = meterAtFit(series, fit.at);
      if (m && nowPages >= m.value) {
        pagesSince = nowPages - m.value;
        estimated = m.estimated;
      }
    }
    const ratedLife = lives ? lives[partLifeKey(part, colour)] : null;
    const pctLeft = ratedLife !== null && pagesSince !== null ? Math.max(0, 1 - pagesSince / ratedLife) : null;
    return {
      part,
      colour,
      state,
      alarm: alarm ? { level: alarm.level, receivedAt: alarm.at } : null,
      lastFitted: fit ? { day: fit.day, at: fit.at } : null,
      pagesSince,
      pagesSinceEstimated: estimated,
      ratedLife,
      pctLeft,
    };
  });

  const lastField = visits.find((v) => v.isField) ?? null;
  let lastVisit: DeviceParts['lastVisit'] = null;
  if (lastField) {
    const m = meterAtFit(combined, lastField.at);
    lastVisit = {
      day: lastField.day,
      at: lastField.at,
      pagesSince: m && pagesNow !== null && pagesNow >= m.value ? pagesNow - m.value : null,
    };
  }
  const pmDay = pmCountAt === null ? null : londonDay(pmCountAt);
  const pmCleared = pmDay !== null && visits.some((v) => v.isField && v.day >= pmDay);

  return {
    drmsEquipmentId: drmsId,
    vantageEquipmentId: vantageId,
    model,
    isColour,
    familyId: family?.id ?? null,
    familyName: family?.name ?? null,
    toner,
    pagesNow,
    lastVisit,
    parts,
    pmCountWarning: pmCountAt !== null && !pmCleared ? { receivedAt: pmCountAt } : null,
  };
}
