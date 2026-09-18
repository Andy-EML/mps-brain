import {
  AuthError,
  ParseError,
  RateLimitError,
  chunk,
  classifyOrderLine,
  errorMessage,
  getBool,
  getField,
  getNumber,
  getString,
  parseApiDate,
} from '@mps/core';
import { excluded, vantageSalesOrderLines, vantageSalesOrders, type Db } from '@mps/db';
import { QUEUES } from '@mps/queue';
import type { SalesOrderListOptions, VantageClient, VantageRecord } from '@mps/vantage';
import { inArray } from 'drizzle-orm';
import { lastSuccessfulStart, type JobResult } from '../sync-runs';

/** Same overlap as `vantage-pull`: covers an order edited while the previous run was in flight. */
const OVERLAP_MS = 2 * 60 * 60_000;
const CHUNK = 500;
/**
 * How far back the very first run reaches. Orders are append-mostly, so there is no weekly full
 * refresh; instead the first run takes a bounded slice of history rather than a decade of it.
 */
const FIRST_RUN_MONTHS = 24;

function monthsBefore(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  out.setUTCMonth(out.getUTCMonth() - months);
  return out;
}

function requireId(raw: VantageRecord, what: string): number {
  const id = getNumber(raw, 'Id');
  if (id === null) throw new ParseError(`Vantage ${what} without Id`, null);
  return id;
}

export function mapSalesOrder(raw: VantageRecord, syncedAt: Date): typeof vantageSalesOrders.$inferInsert {
  const type = getField(raw, 'Type');
  return {
    vantageId: requireId(raw, 'sales order'),
    reference: getString(raw, 'Reference'),
    orderDate: parseApiDate(getField(raw, 'OrderDate')),
    // Null means open. Vantage has no separate status field.
    completedDate: parseApiDate(getField(raw, 'CompletedDate')),
    isOnHold: getBool(raw, 'IsOnHold'),
    isNonStock: getBool(raw, 'IsNonStock'),
    typeId: getNumber(type, 'Id') ?? getNumber(raw, 'TypeId'),
    typeName: getString(type, 'Name'),
    // `createdByMps` is deliberately absent: it belongs to this app, not to Vantage, and the
    // upsert below keeps whatever is already stored.
    vantageEquipmentId: getNumber(raw, 'EquipmentId'),
    contractId: getNumber(raw, 'ContractId'),
    customerSellToId: getNumber(raw, 'CustomerSellToId'),
    customerShipToId: getNumber(raw, 'CustomerShipToId'),
    raw,
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
    deletedDate: parseApiDate(getField(raw, 'DeletedDate')),
    syncedAt,
  };
}

export function mapSalesOrderLine(
  raw: VantageRecord,
  salesOrderId: number,
  syncedAt: Date,
): typeof vantageSalesOrderLines.$inferInsert {
  const item = getField(raw, 'Item');
  const details = getString(raw, 'Details');
  const itemDescription = getString(item, 'Description');
  const partNumber = getString(item, 'PartNumber');
  const quantity = getNumber(raw, 'Quantity');
  const { colour, source } = classifyOrderLine({ details, itemDescription, partNumber });

  return {
    vantageId: requireId(raw, 'sales order line'),
    salesOrderId,
    vantageEquipmentId: getNumber(raw, 'EquipmentId'),
    itemId: getNumber(item, 'Id') ?? getNumber(raw, 'ItemId'),
    itemPartNumber: partNumber,
    itemDescription,
    quantity: quantity === null ? null : String(quantity),
    returnedDate: parseApiDate(getField(raw, 'ReturnedDate')),
    details,
    comment: getString(raw, 'Comment'),
    colour,
    colourSource: source,
    raw,
    syncedAt,
  };
}

export interface VantageOrdersDeps {
  db: Db;
  vantage: Pick<VantageClient, 'listSalesOrders'>;
  now?: () => Date;
}

/**
 * Pulls Vantage sales orders and their lines, read-only, so the device page can show what
 * consumables have already gone out. Nothing here creates or edits anything in Vantage.
 */
export async function runVantageOrders(deps: VantageOrdersDeps): Promise<JobResult> {
  const { db, vantage } = deps;
  const startedAt = (deps.now ?? (() => new Date()))();
  const lastStart = await lastSuccessfulStart(db, QUEUES.vantageOrders);
  const full = lastStart === null;
  const listOpts: SalesOrderListOptions = full
    ? { includeDeleted: false, orderDateFrom: monthsBefore(startedAt, FIRST_RUN_MONTHS) }
    : { since: new Date(lastStart.getTime() - OVERLAP_MS), includeDeleted: true };

  let fetched: VantageRecord[];
  try {
    fetched = await vantage.listSalesOrders(listOpts);
  } catch (err) {
    // Neither is worth retrying: a 429 only extends the block, and a bad token will not heal.
    if (err instanceof RateLimitError || err instanceof AuthError) {
      return {
        status: 'partial',
        stats: { orders: 0, lines: 0, full: full ? 1 : 0 },
        errorSample: `stopped: ${errorMessage(err)}`,
      };
    }
    throw err;
  }

  const orders = fetched.map((raw) => ({
    header: mapSalesOrder(raw, startedAt),
    lines: (Array.isArray(getField(raw, 'Lines')) ? (getField(raw, 'Lines') as VantageRecord[]) : []).map((l) =>
      mapSalesOrderLine(l, getNumber(raw, 'Id') as number, startedAt),
    ),
  }));

  let lineCount = 0;
  for (const batch of chunk(orders, CHUNK)) {
    // One transaction per batch, so an order's header and its replacement lines always land
    // together: a reader never sees an order whose lines have been deleted but not re-inserted.
    await db.transaction(async (tx) => {
      await tx
        .insert(vantageSalesOrders)
        .values(batch.map((o) => o.header))
        .onConflictDoUpdate({
          target: vantageSalesOrders.vantageId,
          // `createdByMps` is ours, not Vantage's — an incoming row must never reset it.
          set: excluded(vantageSalesOrders, ['vantageId', 'createdByMps']),
        });

      const orderIds = batch.map((o) => o.header.vantageId);
      // Lines are replaced wholesale rather than upserted: a line removed in Vantage has to
      // disappear here too, and line ids are not stable enough to diff.
      await tx.delete(vantageSalesOrderLines).where(inArray(vantageSalesOrderLines.salesOrderId, orderIds));

      const lines = batch.flatMap((o) => o.lines);
      for (const lineBatch of chunk(lines, CHUNK)) {
        await tx.insert(vantageSalesOrderLines).values(lineBatch);
      }
      lineCount += lines.length;
    });
  }

  return {
    status: 'success',
    stats: { orders: orders.length, lines: lineCount, full: full ? 1 : 0 },
  };
}
