import {
  ParseError,
  chunk,
  getBool,
  getField,
  getNumber,
  getString,
  normaliseSerial,
  parseApiDate,
} from '@mps/core';
import { excluded, vantageCustomers, vantageEquipment, type Db } from '@mps/db';
import { QUEUES } from '@mps/queue';
import type { VantageClient, VantageRecord } from '@mps/vantage';
import { and, count, isNull, lt } from 'drizzle-orm';
import { lastSuccessfulStart, type JobResult } from '../sync-runs';

const OVERLAP_MS = 2 * 60 * 60_000;
const CHUNK = 500;
/** A full pull must return at least this share of currently active rows before vanished rows are marked deleted. */
const MIN_FULL_PULL_RATIO = 0.8;

function tooFewRows(fetched: number, active: number): boolean {
  return active > 0 && (fetched === 0 || fetched < active * MIN_FULL_PULL_RATIO);
}

async function countActive(db: Db, table: typeof vantageCustomers | typeof vantageEquipment): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(isNull(table.deletedDate));
  return row?.n ?? 0;
}

function requireId(raw: VantageRecord, what: string): number {
  const id = getNumber(raw, 'Id');
  if (id === null) throw new ParseError(`Vantage ${what} without Id`, null);
  return id;
}

export function mapVantageCustomer(raw: VantageRecord, syncedAt: Date): typeof vantageCustomers.$inferInsert {
  return {
    vantageId: requireId(raw, 'customer'),
    reference: getString(raw, 'Reference'),
    name: getString(raw, 'Name'),
    isActive: getBool(raw, 'IsActive'),
    isOnStop: getBool(raw, 'IsOnStop'),
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
    deletedDate: parseApiDate(getField(raw, 'DeletedDate')),
    raw,
    syncedAt,
  };
}

export function mapVantageEquipment(raw: VantageRecord, syncedAt: Date): typeof vantageEquipment.$inferInsert {
  const customer = getField(raw, 'Customer');
  const item = getField(raw, 'Item');
  const serial = getString(raw, 'SerialNumber');
  return {
    vantageId: requireId(raw, 'equipment'),
    serial,
    serialNorm: normaliseSerial(serial),
    assetNumber: getString(raw, 'AssetNumber'),
    description: getString(raw, 'Description'),
    itemPartNumber: getString(item, 'PartNumber'),
    vantageCustomerId: getNumber(customer, 'Id') ?? getNumber(raw, 'CustomerId'),
    customerReference: getString(customer, 'Reference'),
    customerName: getString(customer, 'Name'),
    location: getString(raw, 'Location'),
    installDate: parseApiDate(getField(raw, 'InstallDate')),
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
    deletedDate: parseApiDate(getField(raw, 'DeletedDate')),
    raw,
    syncedAt,
  };
}

export interface VantagePullDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listCustomers' | 'listEquipment'>;
  now?: () => Date;
}

export async function runVantagePull(deps: VantagePullDeps, opts: { full: boolean }): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();
  const lastStart = opts.full ? null : await lastSuccessfulStart(db, QUEUES.vantagePull);
  const full = lastStart === null;
  const listOpts = full
    ? { includeDeleted: false }
    : { since: new Date(lastStart.getTime() - OVERLAP_MS), includeDeleted: true };

  const customers = (await vantage.listCustomers(listOpts)).map((r) => mapVantageCustomer(r, startedAt));
  const equipment = (await vantage.listEquipment(listOpts)).map((r) => mapVantageEquipment(r, startedAt));

  // Active row counts before this pull's upserts, for the full-pull deletion guard.
  const activeCustomers = full ? await countActive(db, vantageCustomers) : 0;
  const activeEquipment = full ? await countActive(db, vantageEquipment) : 0;

  for (const rows of chunk(customers, CHUNK)) {
    await db
      .insert(vantageCustomers)
      .values(rows)
      .onConflictDoUpdate({ target: vantageCustomers.vantageId, set: excluded(vantageCustomers, ['vantageId']) });
  }
  for (const rows of chunk(equipment, CHUNK)) {
    await db
      .insert(vantageEquipment)
      .values(rows)
      .onConflictDoUpdate({ target: vantageEquipment.vantageId, set: excluded(vantageEquipment, ['vantageId']) });
  }

  let customersMarkedDeleted = 0;
  let equipmentMarkedDeleted = 0;
  const skipped: string[] = [];
  if (full) {
    if (tooFewRows(customers.length, activeCustomers)) {
      skipped.push(`customers: fetched ${customers.length} of ${activeCustomers} active`);
    } else {
      customersMarkedDeleted = (
        await db
          .update(vantageCustomers)
          .set({ deletedDate: startedAt })
          .where(and(isNull(vantageCustomers.deletedDate), lt(vantageCustomers.syncedAt, startedAt)))
          .returning({ id: vantageCustomers.vantageId })
      ).length;
    }
    if (tooFewRows(equipment.length, activeEquipment)) {
      skipped.push(`equipment: fetched ${equipment.length} of ${activeEquipment} active`);
    } else {
      equipmentMarkedDeleted = (
        await db
          .update(vantageEquipment)
          .set({ deletedDate: startedAt })
          .where(and(isNull(vantageEquipment.deletedDate), lt(vantageEquipment.syncedAt, startedAt)))
          .returning({ id: vantageEquipment.vantageId })
      ).length;
    }
  }

  return {
    status: skipped.length > 0 ? 'partial' : 'success',
    ...(skipped.length > 0 && { errorSample: `full pull deletions skipped (too few rows): ${skipped.join('; ')}` }),
    stats: {
      customers: customers.length,
      equipment: equipment.length,
      customersMarkedDeleted,
      equipmentMarkedDeleted,
      full: full ? 1 : 0,
    },
  };
}
