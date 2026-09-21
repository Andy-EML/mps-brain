import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { drmsEquipment, drmsRegistrations, users, type RegistrationStatus } from '../schema';

/**
 * The DRMS registration queue (`/registrations`): its tabs, counts, the sidebar badge and the CSV
 * log. Read-only; the decisions live in `./registration-actions`.
 */

export type { RegistrationStatus };

export type RegistrationTab = 'awaiting' | 'waiting' | 'registered' | 'failed' | 'rejected';
export const REGISTRATION_TABS: readonly RegistrationTab[] = ['awaiting', 'waiting', 'registered', 'failed', 'rejected'];

export type CustomerMatchFlag = 'match' | 'mismatch' | 'no_shared_words';

export interface RegistrationRow {
  id: number;
  drmsId: string;
  serial: string | null;
  deviceName: string | null;
  model: string | null;
  drmsCustomerName: string | null;
  vantageEquipmentId: number | null;
  vantageCustomerName: string | null;
  status: RegistrationStatus;
  reason: string | null;
  customerMatch: CustomerMatchFlag | null;
  requestId: string | null;
  drmsStatusAfter: string | null;
  error: string | null;
  createdAt: Date;
  checkedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  note: string | null;
  submittedAt: Date | null;
  finishedAt: Date | null;
  retryRequestedAt: Date | null;
  retryRequestedBy: string | null;
  /** This attempt is a retry of an earlier failed one. */
  isRetry: boolean;
}

const r = drmsRegistrations;
const decider = alias(users, 'decider');
const retrier = alias(users, 'retrier');

/**
 * The device has no later attempt: a failure someone has since retried is history, not work.
 * Inside the subquery the table is only visible as `newer`, so the bare name is the outer row.
 */
const isLatest = sql`not exists (select 1 from ${drmsRegistrations} as newer where newer.drms_equipment_id = ${r.drmsEquipmentId} and newer.id > ${r.id})`;

const TAB_WHERE: Record<RegistrationTab, SQL> = {
  awaiting: inArray(r.status, ['awaiting_approval', 'approved']),
  waiting: eq(r.status, 'waiting'),
  registered: eq(r.status, 'registered'),
  failed: and(eq(r.status, 'failed'), isLatest)!,
  rejected: eq(r.status, 'rejected'),
};

const TAB_ORDER: Record<RegistrationTab, SQL[]> = {
  // Approved rows are on their way to DRMS: show them above the ones still waiting for a decision.
  awaiting: [sql`(${r.status} = 'approved') desc`, asc(r.createdAt), asc(r.id)],
  waiting: [asc(r.createdAt), asc(r.id)],
  registered: [sql`${r.finishedAt} desc nulls last`, desc(r.id)],
  failed: [sql`${r.finishedAt} desc nulls last`, desc(r.id)],
  rejected: [sql`${r.decidedAt} desc nulls last`, desc(r.id)],
};

const rowColumns = {
  id: r.id,
  drmsId: r.drmsEquipmentId,
  serial: r.serial,
  deviceName: r.deviceName,
  model: drmsEquipment.modelName,
  drmsCustomerName: r.drmsCustomerName,
  vantageEquipmentId: r.vantageEquipmentId,
  vantageCustomerName: r.vantageCustomerName,
  status: r.status,
  reason: r.reason,
  customerMatch: r.customerMatch,
  requestId: r.requestId,
  drmsStatusAfter: r.drmsStatusAfter,
  error: r.error,
  createdAt: r.createdAt,
  checkedAt: r.checkedAt,
  decidedAt: r.decidedAt,
  decidedBy: decider.username,
  note: r.note,
  submittedAt: r.submittedAt,
  finishedAt: r.finishedAt,
  retryRequestedAt: r.retryRequestedAt,
  retryRequestedBy: retrier.username,
};

function searchWhere(search: string | undefined): SQL | undefined {
  if (!search) return undefined;
  const q = `%${search}%`;
  return sql`(${r.serial} ilike ${q} or ${r.deviceName} ilike ${q} or ${r.drmsCustomerName} ilike ${q} or ${r.vantageCustomerName} ilike ${q})`;
}

export async function listRegistrations(
  db: Db,
  o: { tab: RegistrationTab; search?: string; limit?: number; offset?: number },
): Promise<{ rows: RegistrationRow[]; total: number }> {
  const where = and(TAB_WHERE[o.tab], searchWhere(o.search));
  let q = db
    .select(rowColumns)
    .from(r)
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, r.drmsEquipmentId))
    .leftJoin(decider, eq(decider.id, r.decidedBy))
    .leftJoin(retrier, eq(retrier.id, r.retryRequestedBy))
    .where(where)
    .orderBy(...TAB_ORDER[o.tab])
    .$dynamic();
  if (o.limit !== undefined) q = q.limit(o.limit);
  if (o.offset) q = q.offset(o.offset);
  const [rows, [total]] = await Promise.all([q, db.select({ n: count() }).from(r).where(where)]);
  return {
    rows: rows.map((row) => ({ ...row, isRetry: row.retryRequestedAt !== null })),
    total: Number(total?.n ?? 0),
  };
}

export interface RegistrationCounts {
  awaitingApproval: number;
  /** Approved, not yet registered: on their way to DRMS. */
  approved: number;
  waiting: number;
  registered: number;
  /** Failed and not retried since. */
  failed: number;
  rejected: number;
}

/** Every tab's count in one query. */
export async function getRegistrationCounts(db: Db): Promise<RegistrationCounts> {
  const n = (cond: SQL) => sql<number>`count(*) filter (where ${cond})`;
  const [row] = await db
    .select({
      awaitingApproval: n(eq(r.status, 'awaiting_approval')),
      approved: n(eq(r.status, 'approved')),
      waiting: n(eq(r.status, 'waiting')),
      registered: n(eq(r.status, 'registered')),
      failed: n(TAB_WHERE.failed),
      rejected: n(eq(r.status, 'rejected')),
    })
    .from(r);
  return {
    awaitingApproval: Number(row?.awaitingApproval ?? 0),
    approved: Number(row?.approved ?? 0),
    waiting: Number(row?.waiting ?? 0),
    registered: Number(row?.registered ?? 0),
    failed: Number(row?.failed ?? 0),
    rejected: Number(row?.rejected ?? 0),
  };
}

/** Rows awaiting a decision — the sidebar badge. One indexed count. */
export async function countAwaitingApproval(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(r).where(eq(r.status, 'awaiting_approval'));
  return Number(row?.n ?? 0);
}

export interface RegistrationLogRow extends RegistrationRow {
  customerErpId: string | null;
  request: unknown;
  response: unknown;
}

/** Every attempt, oldest first, with the exact request sent and DRMS's answer: the CSV log. */
export async function listRegistrationLog(db: Db): Promise<RegistrationLogRow[]> {
  const rows = await db
    .select({ ...rowColumns, customerErpId: drmsEquipment.customerErpId, request: r.request, response: r.response })
    .from(r)
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, r.drmsEquipmentId))
    .leftJoin(decider, eq(decider.id, r.decidedBy))
    .leftJoin(retrier, eq(retrier.id, r.retryRequestedBy))
    .orderBy(asc(r.id));
  return rows.map((row) => ({ ...row, isRetry: row.retryRequestedAt !== null }));
}
