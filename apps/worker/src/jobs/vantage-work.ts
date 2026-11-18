import { AuthError, ParseError, RateLimitError, chunk, errorMessage, getBool, getField, getNumber, getString, parseApiDate } from '@mps/core';
import { vantageWorkVisits, type Db } from '@mps/db';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import type { JobResult } from '../sync-runs';

const CHUNK = 500;
/** How far back visits are fetched: the PM clock can start long before the 12 months of meter readings held. */
export const VISIT_WINDOW_MONTHS = 36;

export function visitWindowStart(now: Date): Date {
  const out = new Date(now.getTime());
  out.setUTCMonth(out.getUTCMonth() - VISIT_WINDOW_MONTHS);
  return out;
}

/**
 * Null when the unit has no id or equipment, or its Work is deleted (`WorkUnit` has no deleted flag
 * of its own, so the client lists with includeDeleted and the Work's `DeletedDate` decides).
 */
export function mapWorkUnit(raw: VantageRecord, syncedAt: Date): typeof vantageWorkVisits.$inferInsert | null {
  const work = getField(raw, 'Work');
  const category = getField(raw, 'Category');
  const workUnitId = getNumber(raw, 'Id');
  const workId = getNumber(raw, 'WorkId') ?? getNumber(work, 'Id');
  const equipmentId = getNumber(work, 'EquipmentId');
  if (workUnitId === null || workId === null || equipmentId === null) return null;
  if (parseApiDate(getField(work, 'DeletedDate'))) return null;
  return {
    workUnitId,
    workId,
    workReference: getString(work, 'Reference'),
    vantageEquipmentId: equipmentId,
    customerId: getNumber(work, 'CustomerId'),
    categoryId: getNumber(raw, 'CategoryId') ?? getNumber(category, 'Id'),
    categoryName: getString(category, 'Name'),
    categoryType: getString(getField(category, 'Type'), 'Name'),
    loggedAt: parseApiDate(getField(raw, 'LoggedDate')),
    workStart: parseApiDate(getField(raw, 'WorkStartDate')),
    workEnd: parseApiDate(getField(raw, 'WorkEndDate')),
    workHours: getNumber(raw, 'WorkHours'),
    scheduledStart: parseApiDate(getField(raw, 'ScheduledStartDate')),
    completedAt: parseApiDate(getField(work, 'CompletedDate')),
    maintenancePerformed: getBool(raw, 'MaintenanceWasPerformed'),
    actionDetails: getString(raw, 'ActionDetails'),
    raw,
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
    syncedAt,
  };
}

export interface VantageWorkDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listWorkUnits'>;
  now?: () => Date;
}

/**
 * Read-only full refresh of Vantage work visits (WorkUnit + Work + Category) for the PM due list.
 * Every run fetches the whole 36-month window and replaces all rows in one transaction: changes on
 * the parent Work (deleted, completed, equipment) do not touch WorkUnit.ModifiedDate, so an
 * incremental pull would miss them. A failed fetch leaves the previous copy untouched.
 */
export async function runVantageWork(deps: VantageWorkDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();

  let fetched: VantageRecord[];
  try {
    fetched = await vantage.listWorkUnits({ from: visitWindowStart(startedAt) });
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AuthError) {
      return { status: 'partial', stats: { visits: 0 }, errorSample: `stopped: ${errorMessage(err)}` };
    }
    throw err;
  }

  // An empty answer is a bad response, not "no visits anywhere": keep the previous copy.
  if (fetched.length === 0) throw new ParseError('Vantage WorkUnit: no records', 200);

  const rows: (typeof vantageWorkVisits.$inferInsert)[] = [];
  let skipped = 0;
  for (const raw of fetched) {
    const row = mapWorkUnit(raw, startedAt);
    if (row) rows.push(row);
    else skipped++;
  }

  await db.transaction(async (tx) => {
    await tx.delete(vantageWorkVisits);
    for (const batch of chunk(rows, CHUNK)) await tx.insert(vantageWorkVisits).values(batch);
  });

  return { status: 'success', stats: { visits: rows.length, skipped } };
}
