import { AuthError, ParseError, RateLimitError, errorMessage, getBool, getNumber, getString } from '@mps/core';
import { vantageEngineers, type Db } from '@mps/db';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import type { JobResult } from '../sync-runs';

/** Null when the record has no id. `IsActive` defaults to true when Vantage leaves it out. */
export function mapEngineer(raw: VantageRecord, syncedAt: Date): typeof vantageEngineers.$inferInsert | null {
  const vantageId = getNumber(raw, 'Id');
  if (vantageId === null) return null;
  return { vantageId, name: getString(raw, 'Name'), isActive: getBool(raw, 'IsActive') ?? true, raw, syncedAt };
}

export interface VantageEngineersDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listEngineers'>;
  now?: () => Date;
}

/**
 * Read-only nightly refresh of Vantage engineers (id, name, active flag) for the PM planner. The
 * table is tiny, so every run replaces it in one transaction. An empty answer is a bad response (a
 * dealer always has engineers), so it fails and the previous copy stays.
 */
export async function runVantageEngineers(deps: VantageEngineersDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();

  let fetched: VantageRecord[];
  try {
    fetched = await vantage.listEngineers();
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AuthError) {
      return { status: 'partial', stats: { engineers: 0 }, errorSample: `stopped: ${errorMessage(err)}` };
    }
    throw err;
  }
  if (fetched.length === 0) throw new ParseError('Vantage Engineer: no records', 200);

  const rows: (typeof vantageEngineers.$inferInsert)[] = [];
  let skipped = 0;
  for (const raw of fetched) {
    const row = mapEngineer(raw, startedAt);
    if (row) rows.push(row);
    else skipped++;
  }
  // Ids are unique in Vantage, but a repeated one must not abort the replace.
  const unique = [...new Map(rows.map((r) => [r.vantageId, r])).values()];

  await db.transaction(async (tx) => {
    await tx.delete(vantageEngineers);
    if (unique.length > 0) await tx.insert(vantageEngineers).values(unique);
  });
  return { status: 'success', stats: { engineers: unique.length, skipped } };
}
