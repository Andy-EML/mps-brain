import { and, asc, count, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, linkIssues, vantageEquipment } from '../schema';

export interface IssueRow {
  id: number;
  type: string;
  status: string;
  drmsId: string | null;
  drmsName: string | null;
  drmsSerial: string | null;
  vantageId: number | null;
  vantageSerial: string | null;
  vantageCustomerName: string | null;
  details: unknown;
  firstSeen: Date;
  lastSeen: Date;
}

export async function listIssues(
  db: Db,
  o: { type?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: IssueRow[]; total: number; countsByType: Record<string, number> }> {
  const limit = o.limit ?? 50;
  const offset = o.offset ?? 0;

  // Only the status filter applies to countsByType, so switching the type tab doesn't change the
  // counts shown on the other tabs. `status` is `string` in the public signature (per the task
  // brief) rather than the narrower DB enum, so it's cast here; an unrecognised value just matches
  // no rows rather than throwing.
  const statusCond = o.status ? eq(linkIssues.status, o.status as 'open' | 'resolved' | 'ignored') : undefined;
  const rowsCond = o.type ? and(statusCond, eq(linkIssues.type, o.type)) : statusCond;

  const rowsQuery = db
    .select({
      id: linkIssues.id,
      type: linkIssues.type,
      status: linkIssues.status,
      drmsId: linkIssues.drmsEquipmentId,
      drmsName: drmsEquipment.productName,
      drmsSerial: drmsEquipment.serial,
      vantageId: linkIssues.vantageEquipmentId,
      vantageSerial: vantageEquipment.serial,
      vantageCustomerName: vantageEquipment.customerName,
      details: linkIssues.details,
      firstSeen: linkIssues.firstSeen,
      lastSeen: linkIssues.lastSeen,
    })
    .from(linkIssues)
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, linkIssues.drmsEquipmentId))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, linkIssues.vantageEquipmentId))
    .where(rowsCond)
    .orderBy(desc(linkIssues.lastSeen))
    .limit(limit)
    .offset(offset);

  const countQuery = db.select({ n: count() }).from(linkIssues).where(rowsCond);

  const typeCountsQuery = db
    .select({ type: linkIssues.type, n: count() })
    .from(linkIssues)
    .where(statusCond)
    .groupBy(linkIssues.type);

  const [rows, [totalRow], typeCounts] = await Promise.all([rowsQuery, countQuery, typeCountsQuery]);

  const countsByType: Record<string, number> = {};
  for (const t of typeCounts) countsByType[t.type] = t.n;

  return { rows, total: totalRow?.n ?? 0, countsByType };
}

export async function searchVantageEquipment(
  db: Db,
  q: string,
  limit = 20,
): Promise<{ vantageId: number; serial: string | null; assetNumber: string | null; customerName: string | null; linkedToDrmsId: string | null }[]> {
  const pattern = `%${q}%`;
  return db
    .select({
      vantageId: vantageEquipment.vantageId,
      serial: vantageEquipment.serial,
      assetNumber: vantageEquipment.assetNumber,
      customerName: vantageEquipment.customerName,
      linkedToDrmsId: deviceLinks.drmsEquipmentId,
    })
    .from(vantageEquipment)
    .leftJoin(deviceLinks, and(eq(deviceLinks.vantageEquipmentId, vantageEquipment.vantageId), isNull(deviceLinks.unlinkedAt)))
    .where(
      and(
        isNull(vantageEquipment.deletedDate),
        or(
          ilike(vantageEquipment.serial, pattern),
          ilike(vantageEquipment.assetNumber, pattern),
          ilike(vantageEquipment.customerName, pattern),
        ),
      ),
    )
    .orderBy(asc(vantageEquipment.vantageId))
    .limit(limit);
}
