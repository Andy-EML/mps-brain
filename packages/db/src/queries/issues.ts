import { and, asc, count, desc, eq, ilike, isNull, notInArray, or } from 'drizzle-orm';
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
  /**
   * The Vantage record the DRMS device is linked to *right now*, or null when it has no active
   * link. Not the same as `vantageId`, which is whatever the issue was raised about — the queue's
   * Unlink action needs to know there is something to unlink.
   */
  linkedVantageId: number | null;
  details: unknown;
  firstSeen: Date;
  lastSeen: Date;
}

export interface ListIssuesOptions {
  type?: string;
  /** Types to leave out — the queue's default view hides the ~1,000 expected `no_match_vantage`. */
  excludeTypes?: string[];
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listIssues(
  db: Db,
  o: ListIssuesOptions = {},
): Promise<{ rows: IssueRow[]; total: number; countsByType: Record<string, number> }> {
  const limit = o.limit ?? 50;
  const offset = o.offset ?? 0;

  // Only the status filter applies to countsByType, so switching the type tab doesn't change the
  // counts shown on the other tabs. `status` is `string` in the public signature (per the task
  // brief) rather than the narrower DB enum, so it's cast here; an unrecognised value just matches
  // no rows rather than throwing.
  const statusCond = o.status ? eq(linkIssues.status, o.status as 'open' | 'resolved' | 'ignored') : undefined;
  const excluded = o.excludeTypes?.length ? notInArray(linkIssues.type, o.excludeTypes) : undefined;
  const rowsCond = and(statusCond, excluded, o.type ? eq(linkIssues.type, o.type) : undefined);

  // The device's live link, for the Unlink action. Joined on the DRMS id rather than the issue's
  // own vantageId so a `customer_mismatch` row still reports the link even after a relink.
  const activeLink = and(eq(deviceLinks.drmsEquipmentId, linkIssues.drmsEquipmentId), isNull(deviceLinks.unlinkedAt));

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
      linkedVantageId: deviceLinks.vantageEquipmentId,
      details: linkIssues.details,
      firstSeen: linkIssues.firstSeen,
      lastSeen: linkIssues.lastSeen,
    })
    .from(linkIssues)
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, linkIssues.drmsEquipmentId))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, linkIssues.vantageEquipmentId))
    .leftJoin(deviceLinks, activeLink)
    .where(rowsCond)
    .orderBy(desc(linkIssues.lastSeen))
    .limit(limit)
    .offset(offset);

  const countQuery = db.select({ n: count() }).from(linkIssues).where(rowsCond);

  // `excludeTypes` deliberately doesn't apply here: the hidden type still needs a count, or its
  // own tab couldn't say how many rows it holds.
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

export interface VantageMatch {
  vantageId: number;
  serial: string | null;
  assetNumber: string | null;
  customerName: string | null;
  /** The DRMS device currently holding this record, so the picker can warn before taking it over. */
  linkedToDrmsId: string | null;
}

export async function searchVantageEquipment(db: Db, q: string, limit = 20): Promise<VantageMatch[]> {
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
