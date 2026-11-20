import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import { customerFlags, deviceLinks, replenishmentProposals, siteStockShelves, users, vantageCustomers, vantageEquipment } from '../schema';
import { audit } from './site-stock-actions';

/** Supersede note written on proposals closed because the customer became self-managed. */
export const SELF_MANAGED_NOTE = 'customer self-managed';

/** Where a device's self-managed state comes from: its own customer, or that customer's head office. */
export type SelfManagedSource = 'site' | 'head_office';

/**
 * SQL: the customer's head office Vantage id (`raw->>'HeadOfficeId'`), null when absent, not numeric,
 * or equal to the customer's own id.
 */
export function headOfficeIdSql(customersTable: typeof vantageCustomers = vantageCustomers): SQL<number | null> {
  const raw = sql`${customersTable.raw}->>'HeadOfficeId'`;
  return sql<number | null>`case when ${raw} ~ '^[0-9]{1,9}$' and (${raw})::int <> ${customersTable.vantageId} then (${raw})::int end`;
}

/**
 * SQL: 'site' | 'head_office' | null for a Vantage customer id. The customer's own flag wins over its
 * head office's (one hop only). A flag row with `self_managed = false` is simply "off": it never
 * overrides a flagged head office.
 *
 * Drizzle renders `customerId` unqualified in a single-table select, so the correlated subqueries read
 * their tables through derived tables with uniquely named columns (sm_*): an unqualified outer column
 * can then only ever bind to the outer query.
 */
export function selfManagedSourceSql(customerId: AnyPgColumn | SQL): SQL<SelfManagedSource | null> {
  return sql<SelfManagedSource | null>`case
    when exists (
      select 1 from (select ${customerFlags.vantageCustomerId} as sm_flag_id, ${customerFlags.selfManaged} as sm_flag_on from ${customerFlags}) sm_flag
      where sm_flag.sm_flag_id = ${customerId} and sm_flag.sm_flag_on
    ) then 'site'
    when exists (
      select 1 from (
        select ${vantageCustomers.vantageId} as sm_cust_id, ${headOfficeIdSql()} as sm_ho_id
        from ${vantageCustomers}
      ) sm_own
      join (select ${customerFlags.vantageCustomerId} as sm_hof_id, ${customerFlags.selfManaged} as sm_hof_on from ${customerFlags}) sm_hof
        on sm_hof.sm_hof_id = sm_own.sm_ho_id and sm_hof.sm_hof_on
      where sm_own.sm_cust_id = ${customerId}
    ) then 'head_office'
  end`;
}

export interface SelfManagedInfo {
  selfManaged: boolean;
  source: SelfManagedSource | null;
  note: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  headOffice: { vantageId: number; name: string | null } | null;
}

/** The self-managed state of one customer; note/updated* come from the row that sets it (site row, else head office row). */
export async function getSelfManaged(db: Db, vantageCustomerId: number): Promise<SelfManagedInfo> {
  const [own] = await db
    .select({ source: selfManagedSourceSql(sql`${vantageCustomerId}::int`), ho: headOfficeIdSql() })
    .from(vantageCustomers)
    .where(eq(vantageCustomers.vantageId, vantageCustomerId));
  const source = own?.source ?? null;
  const hoId = own?.ho ?? null;
  const headOffice = hoId === null ? null : await db
    .select({ vantageId: vantageCustomers.vantageId, name: vantageCustomers.name })
    .from(vantageCustomers)
    .where(eq(vantageCustomers.vantageId, hoId))
    .then((r) => r[0] ?? { vantageId: hoId, name: null });
  const rowId = source === 'site' ? vantageCustomerId : source === 'head_office' ? hoId : null;
  if (rowId === null) return { selfManaged: false, source: null, note: null, updatedAt: null, updatedBy: null, headOffice };
  const [row] = await db
    .select({ note: customerFlags.selfManagedNote, updatedAt: customerFlags.updatedAt, updatedBy: customerFlags.updatedBy })
    .from(customerFlags)
    .where(eq(customerFlags.vantageCustomerId, rowId));
  let updatedBy: string | null = null;
  if (row?.updatedBy != null) {
    const [u] = await db.select({ username: users.username }).from(users).where(eq(users.id, row.updatedBy));
    updatedBy = u?.username ?? null;
  }
  return { selfManaged: true, source, note: row?.note ?? null, updatedAt: row?.updatedAt ?? null, updatedBy, headOffice };
}

/** Customer ids the flag on `vantageCustomerId` reaches: itself + sites whose HeadOfficeId = it. */
export async function customerScopeIds(db: Db, vantageCustomerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: vantageCustomers.vantageId })
    .from(vantageCustomers)
    .where(sql`${headOfficeIdSql()} = ${vantageCustomerId}`);
  return [...new Set([vantageCustomerId, ...rows.map((r) => r.id)])];
}

/** Pending proposals with the customer they belong to (device's active-link customer, and the shelf's customer). */
async function pendingWithCustomers(db: Db) {
  return db
    .select({
      id: replenishmentProposals.id,
      drmsId: replenishmentProposals.drmsEquipmentId,
      deviceCustomer: vantageEquipment.vantageCustomerId,
      shelfCustomer: siteStockShelves.vantageCustomerId,
      deviceSm: sql<boolean>`${selfManagedSourceSql(vantageEquipment.vantageCustomerId)} is not null`,
      shelfSm: sql<boolean>`${selfManagedSourceSql(siteStockShelves.vantageCustomerId)} is not null`,
    })
    .from(replenishmentProposals)
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, replenishmentProposals.drmsEquipmentId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .leftJoin(siteStockShelves, eq(siteStockShelves.id, replenishmentProposals.shelfId))
    .where(eq(replenishmentProposals.status, 'pending'));
}

/**
 * Pending proposals the switch would clear, for the confirm dialog. `devices` = distinct devices with
 * an affected proposal; `sites` = customer ids in scope with at least one affected proposal (via the
 * device's customer or the shelf's customer).
 */
export async function previewSelfManaged(db: Db, vantageCustomerId: number): Promise<{ pending: number; devices: number; sites: number }> {
  const scope = new Set(await customerScopeIds(db, vantageCustomerId));
  const devices = new Set<string>();
  const sites = new Set<number>();
  let pending = 0;
  for (const r of await pendingWithCustomers(db)) {
    const dev = r.deviceCustomer !== null && scope.has(r.deviceCustomer);
    const shelf = r.shelfCustomer !== null && scope.has(r.shelfCustomer);
    if (!dev && !shelf) continue;
    pending++;
    devices.add(r.drmsId);
    if (dev) sites.add(r.deviceCustomer!);
    if (shelf) sites.add(r.shelfCustomer!);
  }
  return { pending, devices: devices.size, sites: sites.size };
}

/**
 * Pending proposals on a self-managed device or a self-managed customer's shelf. With `scope`
 * (customer ids), only those whose self-managed device or shelf customer is in it.
 */
async function selfManagedPendingIds(db: Db, scope?: number[]): Promise<number[]> {
  const inScope = scope ? new Set(scope) : null;
  const reaches = (customer: number | null) => inScope === null || (customer !== null && inScope.has(customer));
  return (await pendingWithCustomers(db))
    .filter((r) => (r.deviceSm && reaches(r.deviceCustomer)) || (r.shelfSm && reaches(r.shelfCustomer)))
    .map((r) => r.id);
}

/**
 * Supersedes pending proposals on self-managed devices / shelves. Without `scope` it is the worker's
 * global safety net; `setSelfManaged` passes the flagged customer's scope so its audit row lists only
 * its own proposals. Returns the ids actually changed, ascending.
 */
export async function supersedeSelfManagedProposals(db: Db, now: Date, scope?: number[]): Promise<number[]> {
  const ids = await selfManagedPendingIds(db, scope);
  if (ids.length === 0) return [];
  const changed = await db
    .update(replenishmentProposals)
    .set({ status: 'superseded', decidedAt: now, note: SELF_MANAGED_NOTE })
    .where(and(inArray(replenishmentProposals.id, ids), eq(replenishmentProposals.status, 'pending')))
    .returning({ id: replenishmentProposals.id });
  return changed.map((r) => r.id).sort((a, b) => a - b);
}

/**
 * Whether the switch may be set on this customer: it exists and is not deleted in Vantage, or it is
 * deleted but already has a flag row (so a flag left on a deleted head office can still be turned off).
 */
export async function isFlaggableCustomer(db: Db, vantageCustomerId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: vantageCustomers.vantageId })
    .from(vantageCustomers)
    .leftJoin(customerFlags, eq(customerFlags.vantageCustomerId, vantageCustomers.vantageId))
    .where(
      and(
        eq(vantageCustomers.vantageId, vantageCustomerId),
        or(isNull(vantageCustomers.deletedDate), isNotNull(customerFlags.vantageCustomerId)),
      ),
    );
  return row !== undefined;
}

/** Upserts the flag; when turning it on, supersedes pending proposals in the same transaction. Off supersedes nothing. */
export async function setSelfManaged(
  db: Db,
  args: { vantageCustomerId: number; on: boolean; note?: string | null; userId: number; now?: Date },
): Promise<{ superseded: number }> {
  const now = args.now ?? new Date();
  const note = args.note?.trim() ? args.note.trim() : null;
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t
      .insert(customerFlags)
      .values({ vantageCustomerId: args.vantageCustomerId, selfManaged: args.on, selfManagedNote: note, updatedBy: args.userId, updatedAt: now })
      .onConflictDoUpdate({
        target: customerFlags.vantageCustomerId,
        set: { selfManaged: args.on, selfManagedNote: note, updatedBy: args.userId, updatedAt: now },
      });
    const supersededProposalIds = args.on
      ? await supersedeSelfManagedProposals(t, now, await customerScopeIds(t, args.vantageCustomerId))
      : [];
    await audit(t, {
      userId: args.userId,
      action: args.on ? 'customer.self_managed.on' : 'customer.self_managed.off',
      entity: 'customer',
      ids: [args.vantageCustomerId],
      details: { note, supersededProposalIds },
      now,
    });
    return { superseded: supersededProposalIds.length };
  });
}
