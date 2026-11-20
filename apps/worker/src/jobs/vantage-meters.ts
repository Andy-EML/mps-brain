import { AuthError, ParseError, RateLimitError, chunk, errorMessage, getField, getNumber, getString, parseApiDate } from '@mps/core';
import { excluded, vantageMeterReadings, type Db } from '@mps/db';
import { QUEUES } from '@mps/queue';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import { lt } from 'drizzle-orm';
import { lastSuccessfulRun, type JobResult } from '../sync-runs';

/** User rule (2026-11-19): meter readings are kept for the last 24 months. */
export const METER_WINDOW_MONTHS = 24;
/** Covers a reading edited while the previous run was in flight. */
const OVERLAP_MS = 2 * 60 * 60_000;
/** Readings dated after this far past now are typos (one real example sits in December of next year). */
const FUTURE_SLACK_MS = 24 * 60 * 60_000;
const CHUNK = 500;

export function meterWindowStart(now: Date): Date {
  const out = new Date(now.getTime());
  out.setUTCMonth(out.getUTCMonth() - METER_WINDOW_MONTHS);
  return out;
}

/** Full when there is no previous success, or that run covered a smaller window than today's (the window grew, so older months are missing). */
export function needsFullRun(lastStart: Date | null, lastWindowMonths: number | null): boolean {
  return lastStart === null || lastWindowMonths === null || lastWindowMonths < METER_WINDOW_MONTHS;
}

export interface MeterTypeInfo {
  name: string | null;
  cls: string | null;
}

export function meterTypeMap(types: VantageRecord[]): Map<number, MeterTypeInfo> {
  const out = new Map<number, MeterTypeInfo>();
  for (const t of types) {
    const id = getNumber(t, 'Id');
    if (id !== null) out.set(id, { name: getString(t, 'Name'), cls: getString(getField(t, 'Class'), 'Name') });
  }
  return out;
}

/** Null when the record has no id, equipment, date or value (nothing usable to store). */
export function mapMeterReading(
  raw: VantageRecord,
  types: Map<number, MeterTypeInfo>,
  syncedAt: Date,
): typeof vantageMeterReadings.$inferInsert | null {
  const vantageId = getNumber(raw, 'Id');
  const equipmentId = getNumber(raw, 'EquipmentId');
  const typeId = getNumber(raw, 'MeterTypeId');
  const readingAt = parseApiDate(getField(raw, 'ReadingDateTime')) ?? parseApiDate(getField(raw, 'ReadingDate'));
  const reading = getNumber(raw, 'Reading');
  if (vantageId === null || equipmentId === null || typeId === null || !readingAt || reading === null) return null;
  const type = types.get(typeId);
  return {
    vantageId,
    vantageEquipmentId: equipmentId,
    meterTypeId: typeId,
    meterTypeName: type?.name ?? null,
    meterClass: type?.cls ?? null,
    readingTypeId: getNumber(raw, 'ReadingTypeId'),
    readingAt,
    reading: Math.round(reading),
    raw,
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
    syncedAt,
  };
}

export interface VantageMetersDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listMeterReadings' | 'listMeterTypes'>;
  now?: () => Date;
}

/**
 * Pulls Vantage meter readings for the last {@link METER_WINDOW_MONTHS} months, read-only. The first
 * run backfills the whole window, and so does any later run whose predecessor covered a smaller
 * window (the window grew); other runs ask only for readings created or modified since the last
 * success. Anything older than the window is pruned on every run.
 */
export async function runVantageMeters(deps: VantageMetersDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();
  const last = await lastSuccessfulRun(db, QUEUES.vantageMeters);
  const lastStart = last?.startedAt ?? null;
  const lastWindow = last?.stats.windowMonths;
  const full = needsFullRun(lastStart, typeof lastWindow === 'number' ? lastWindow : null);
  const windowStart = meterWindowStart(startedAt);

  let fetched: VantageRecord[];
  let types: Map<number, MeterTypeInfo>;
  try {
    types = meterTypeMap(await vantage.listMeterTypes());
    fetched = await vantage.listMeterReadings({
      readingFrom: windowStart,
      readingTo: new Date(startedAt.getTime() + FUTURE_SLACK_MS),
      since: full || lastStart === null ? undefined : new Date(lastStart.getTime() - OVERLAP_MS),
    });
  } catch (err) {
    // Neither is worth retrying: a 429 only extends the block, and a bad token will not heal.
    if (err instanceof RateLimitError || err instanceof AuthError) {
      return { status: 'partial', stats: { readings: 0, full: full ? 1 : 0 }, errorSample: `stopped: ${errorMessage(err)}` };
    }
    throw err;
  }

  const rows: (typeof vantageMeterReadings.$inferInsert)[] = [];
  let skipped = 0;
  for (const raw of fetched) {
    const row = mapMeterReading(raw, types, startedAt);
    if (row) rows.push(row);
    else skipped++;
  }
  if (rows.length === 0 && fetched.length > 0) throw new ParseError('Vantage MeterReading: no usable records', 200);

  for (const batch of chunk(rows, CHUNK)) {
    await db
      .insert(vantageMeterReadings)
      .values(batch)
      .onConflictDoUpdate({ target: vantageMeterReadings.vantageId, set: excluded(vantageMeterReadings, ['vantageId']) });
  }
  const pruned = await db
    .delete(vantageMeterReadings)
    .where(lt(vantageMeterReadings.readingAt, windowStart))
    .returning({ id: vantageMeterReadings.vantageId });

  return { status: 'success', stats: { readings: rows.length, skipped, pruned: pruned.length, full: full ? 1 : 0, windowMonths: METER_WINDOW_MONTHS } };
}
