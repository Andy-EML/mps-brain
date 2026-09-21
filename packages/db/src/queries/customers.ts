import { and, asc, countDistinct, eq, ilike, isNull, or } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, vantageCustomers, vantageEquipment } from '../schema';

export interface VantageCustomerMatch {
  vantageId: number;
  name: string | null;
  reference: string | null;
  /** Linked DRMS devices — the machines a customer override would reach. */
  deviceCount: number;
}

/** `%` and `_` are wildcards to `ilike`; an operator typing them means the characters. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The customer picker on `/settings/replenishment`: Vantage customers by name or reference, only
 * those with at least one linked DRMS device (an override on any other customer would reach no
 * machine). Device counts follow `listCustomerSettings` — active links only.
 */
export async function searchVantageCustomers(db: Db, q: string, limit = 20): Promise<VantageCustomerMatch[]> {
  const pattern = containsPattern(q);
  const rows = await db
    .select({
      vantageId: vantageCustomers.vantageId,
      name: vantageCustomers.name,
      reference: vantageCustomers.reference,
      deviceCount: countDistinct(deviceLinks.drmsEquipmentId),
    })
    .from(vantageCustomers)
    .innerJoin(vantageEquipment, eq(vantageEquipment.vantageCustomerId, vantageCustomers.vantageId))
    .innerJoin(deviceLinks, and(eq(deviceLinks.vantageEquipmentId, vantageEquipment.vantageId), isNull(deviceLinks.unlinkedAt)))
    .where(
      and(
        isNull(vantageCustomers.deletedDate),
        or(ilike(vantageCustomers.name, pattern), ilike(vantageCustomers.reference, pattern)),
      ),
    )
    .groupBy(vantageCustomers.vantageId)
    .orderBy(asc(vantageCustomers.name), asc(vantageCustomers.vantageId))
    .limit(limit);
  return rows.map((r) => ({ ...r, deviceCount: Number(r.deviceCount) }));
}
