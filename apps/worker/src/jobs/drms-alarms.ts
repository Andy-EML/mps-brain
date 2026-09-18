import { AuthError, RateLimitError, chunk, classifyAlarm, errorMessage, parseApiDate } from '@mps/core';
import { deviceAlarms, drmsEquipment, type Db } from '@mps/db';
import type { DrmsClient, DrmsFlatAlarm } from '@mps/drms';
import { QUEUES } from '@mps/queue';
import { inArray } from 'drizzle-orm';
import { lastSuccessfulStart, type JobResult } from '../sync-runs';

const CHUNK = 500;
/** Overlap applied to the window start, so a device's alarm right at the boundary isn't missed. */
const OVERLAP_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** DRMS rejects a range over 1 day; the job itself splits a longer catch-up into day-sized calls. */
const MAX_RANGE_MS = DAY_MS;
/** Caps API calls (and run time) per invocation; a longer gap catches up over several runs. */
const MAX_WINDOWS_PER_RUN = 7;

export interface AlarmWindow {
  from: Date;
  to: Date;
}

/** Splits [from, to) into <=`chunkMs` windows, oldest first, capped at `maxChunks`. */
export function splitWindow(from: Date, to: Date, maxChunks = MAX_WINDOWS_PER_RUN, chunkMs = MAX_RANGE_MS): AlarmWindow[] {
  const windows: AlarmWindow[] = [];
  let cursor = from.getTime();
  const end = to.getTime();
  while (cursor < end && windows.length < maxChunks) {
    const chunkEnd = Math.min(cursor + chunkMs, end);
    windows.push({ from: new Date(cursor), to: new Date(chunkEnd) });
    cursor = chunkEnd;
  }
  return windows;
}

function toIntOrNull(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function mapDrmsAlarm(a: DrmsFlatAlarm, fetchedAt: Date): typeof deviceAlarms.$inferInsert {
  return {
    alarmId: a.AlarmId,
    drmsEquipmentId: a.EquipmentId,
    receivedTime: parseApiDate(a.ReceivedTime) ?? fetchedAt,
    fcCode: a.FcCode ?? null,
    scCode: a.ScCode ?? null,
    description: a.Description ?? null,
    status: a.Status ?? null,
    totalCount: toIntOrNull(a.TotalCount),
    totalColorCount: toIntOrNull(a.TotalColorCount),
    raw: a,
    fetchedAt,
    category: classifyAlarm(a.FcCode, a.Description),
  };
}

export interface DrmsAlarmsDeps {
  db: Db;
  drms: Pick<DrmsClient, 'listAlarms'>;
  now?: () => Date;
}

export async function runDrmsAlarms(deps: DrmsAlarmsDeps): Promise<JobResult> {
  const { db, drms } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const lastStart = await lastSuccessfulStart(db, QUEUES.drmsAlarms);
  const windowStart = lastStart ? new Date(lastStart.getTime() - OVERLAP_MS) : new Date(now.getTime() - DAY_MS);

  const windows = splitWindow(windowStart, now);

  const stats: Record<string, number> = {
    fetched: 0,
    inserted: 0,
    skippedUnknownDevice: 0,
    windows: 0,
    catToner: 0,
    catWaste: 0,
    catParts: 0,
    catService: 0,
    catJam: 0,
    catOther: 0,
  };

  for (const w of windows) {
    let alarms: DrmsFlatAlarm[];
    try {
      alarms = await drms.listAlarms({ dateFrom: w.from, dateTo: w.to });
    } catch (err) {
      if (err instanceof RateLimitError || err instanceof AuthError) {
        return { status: 'partial', stats, errorSample: `stopped: ${errorMessage(err)}` };
      }
      throw err;
    }
    stats.windows = (stats.windows ?? 0) + 1;
    stats.fetched = (stats.fetched ?? 0) + alarms.length;
    if (alarms.length === 0) continue;

    const equipmentIds = [...new Set(alarms.map((a) => a.EquipmentId))];
    const known = new Set(
      (
        await db
          .select({ id: drmsEquipment.drmsId })
          .from(drmsEquipment)
          .where(inArray(drmsEquipment.drmsId, equipmentIds))
      ).map((r) => r.id),
    );

    const rows: (typeof deviceAlarms.$inferInsert)[] = [];
    for (const a of alarms) {
      if (!known.has(a.EquipmentId)) {
        stats.skippedUnknownDevice = (stats.skippedUnknownDevice ?? 0) + 1;
        continue;
      }
      const row = mapDrmsAlarm(a, now);
      rows.push(row);
      const key = `cat${capitalize(row.category ?? 'other')}`;
      stats[key] = (stats[key] ?? 0) + 1;
    }

    for (const batch of chunk(rows, CHUNK)) {
      const inserted = await db
        .insert(deviceAlarms)
        .values(batch)
        .onConflictDoNothing({ target: deviceAlarms.alarmId })
        .returning({ id: deviceAlarms.alarmId });
      stats.inserted = (stats.inserted ?? 0) + inserted.length;
    }
  }

  return { status: 'success', stats };
}
