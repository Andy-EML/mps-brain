import { AuthError, ParseError, RateLimitError, chunk, contractsOf, errorMessage, getNumber, getString, isActiveContract } from '@mps/core';
import { vantageEquipmentContracts, type Db } from '@mps/db';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import type { JobResult } from '../sync-runs';

const CHUNK = 500;

/** One row per distinct contract reachable from the equipment (a contract can appear via several charges). */
export function mapEquipmentContracts(raw: VantageRecord, syncedAt: Date): (typeof vantageEquipmentContracts.$inferInsert)[] {
  const equipmentId = getNumber(raw, 'Id');
  if (equipmentId === null) return [];
  const out = new Map<number, typeof vantageEquipmentContracts.$inferInsert>();
  for (const c of contractsOf(raw)) {
    const contractId = getNumber(c, 'Id');
    if (contractId === null || out.has(contractId)) continue;
    out.set(contractId, {
      vantageEquipmentId: equipmentId,
      contractId,
      contractReference: getString(c, 'Reference'),
      isActive: isActiveContract(c),
      syncedAt,
    });
  }
  return [...out.values()];
}

export interface VantageContractsDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listEquipmentContracts'>;
  now?: () => Date;
}

/**
 * Read-only full refresh of which contracts each Vantage machine is on (PM due only counts
 * machines under an active contract). Every run replaces all rows in one transaction, so a failed
 * fetch leaves the previous copy untouched.
 */
export async function runVantageContracts(deps: VantageContractsDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();

  let fetched: VantageRecord[];
  try {
    fetched = await vantage.listEquipmentContracts();
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AuthError) {
      return { status: 'partial', stats: { equipment: 0, contracts: 0 }, errorSample: `stopped: ${errorMessage(err)}` };
    }
    throw err;
  }

  // An empty answer is a bad response, not "no contracts anywhere": keep the previous copy.
  if (fetched.length === 0) throw new ParseError('Vantage Equipment contracts: no records', 200);

  const rows = fetched.flatMap((raw) => mapEquipmentContracts(raw, startedAt));
  await db.transaction(async (tx) => {
    await tx.delete(vantageEquipmentContracts);
    for (const batch of chunk(rows, CHUNK)) await tx.insert(vantageEquipmentContracts).values(batch);
  });

  return {
    status: 'success',
    stats: { equipment: fetched.length, contracts: rows.length, active: rows.filter((r) => r.isActive).length },
  };
}
