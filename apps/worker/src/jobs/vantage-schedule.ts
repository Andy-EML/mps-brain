import { AuthError, RateLimitError, chunk, errorMessage, getField, getNumber, getString, parseApiDate } from '@mps/core';
import { vantageScheduledUnits, type Db } from '@mps/db';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import type { JobResult } from '../sync-runs';

const CHUNK = 500;
const LONDON = 'Europe/London';

/**
 * Null when the unit has no id or work id, no `ScheduledStartDate`, or its Work is deleted
 * (`WorkUnit` has no deleted flag of its own, so the client lists with includeDeleted and the
 * Work's `DeletedDate` decides). The engineer is `WorkUnit.EngineerId` (checked live, 2026-11-23).
 * A call with no machine is kept (`vantageEquipmentId` null).
 */
export function mapScheduledUnit(raw: VantageRecord, syncedAt: Date): typeof vantageScheduledUnits.$inferInsert | null {
  const work = getField(raw, 'Work');
  const category = getField(raw, 'Category');
  const workUnitId = getNumber(raw, 'Id');
  const workId = getNumber(raw, 'WorkId') ?? getNumber(work, 'Id');
  const scheduledStart = parseApiDate(getField(raw, 'ScheduledStartDate'));
  if (workUnitId === null || workId === null || scheduledStart === null) return null;
  if (parseApiDate(getField(work, 'DeletedDate'))) return null;
  return {
    workUnitId,
    workId,
    workReference: getString(work, 'Reference'),
    engineerId: getNumber(raw, 'EngineerId'),
    customerId: getNumber(work, 'CustomerId'),
    vantageEquipmentId: getNumber(work, 'EquipmentId'),
    scheduledStart,
    categoryId: getNumber(raw, 'CategoryId') ?? getNumber(category, 'Id'),
    categoryName: getString(category, 'Name'),
    categoryType: getString(getField(category, 'Type'), 'Name'),
    workStart: parseApiDate(getField(raw, 'WorkStartDate')),
    completedAt: parseApiDate(getField(work, 'CompletedDate')),
    raw,
    syncedAt,
  };
}

const londonParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function londonFields(at: number): { y: number; m: number; d: number; offsetMs: number } {
  const p = Object.fromEntries(londonParts.formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)])) as Record<string, number>;
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return { y: p.year!, m: p.month!, d: p.day!, offsetMs: asUtc - Math.floor(at / 1000) * 1000 };
}

/** The UTC instant of 00:00 London time on calendar day y-m-d (d may overflow the month). */
function londonMidnight(y: number, m: number, d: number): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = londonFields(guess).offsetMs;
  let t = guess - first;
  const second = londonFields(t).offsetMs;
  if (second !== first) t = guess - second;
  return new Date(t);
}

/**
 * Today and tomorrow in London: from London midnight today up to (not including) London midnight
 * the day after tomorrow, as UTC instants. In BST London midnight is 23:00Z the day before.
 */
export function scheduleWindow(now: Date): { from: Date; to: Date } {
  const { y, m, d } = londonFields(now.getTime());
  return { from: londonMidnight(y, m, d), to: londonMidnight(y, m, d + 2) };
}

export interface VantageScheduleDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listScheduledWorkUnits'>;
  now?: () => Date;
}

/**
 * Read-only intraday refresh of the units scheduled for today and tomorrow (London days). The table
 * only ever holds that window, so every run replaces all of it in one transaction. An empty answer
 * is valid (a weekend) and clears the table; a failed fetch leaves the previous copy untouched.
 */
export async function runVantageSchedule(deps: VantageScheduleDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();

  let fetched: VantageRecord[];
  try {
    fetched = await vantage.listScheduledWorkUnits(scheduleWindow(startedAt));
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AuthError) {
      return { status: 'partial', stats: { units: 0 }, errorSample: `stopped: ${errorMessage(err)}` };
    }
    throw err;
  }

  const byId = new Map<number, typeof vantageScheduledUnits.$inferInsert>();
  let skipped = 0;
  for (const raw of fetched) {
    const row = mapScheduledUnit(raw, startedAt);
    if (row) byId.set(row.workUnitId, row);
    else skipped++;
  }
  const rows = [...byId.values()];

  await db.transaction(async (tx) => {
    await tx.delete(vantageScheduledUnits);
    for (const batch of chunk(rows, CHUNK)) await tx.insert(vantageScheduledUnits).values(batch);
  });
  return { status: 'success', stats: { units: rows.length, skipped } };
}
