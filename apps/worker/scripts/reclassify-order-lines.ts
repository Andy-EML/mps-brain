/**
 * Backfills `classifyOrderLine`'s mono-device fallback (@mps/core, packages/core/src/orders.ts)
 * over sales-order lines that were ingested before that fallback existed: a colourless toner
 * description on a mono device — e.g. "Konica Minolta 300i Toner - TN330A" — was left `unknown`
 * rather than `black`, so it never suppressed or superseded a black replenishment proposal
 * (`getOrderStates`, @mps/db `queries/order-state.ts`).
 *
 * Idempotent: only ever looks at rows whose stored `colour` is still `unknown`, so a line this
 * script has already turned `black` drops out of scope and a second run finds nothing left to do.
 * Never touches a line that already carries a real colour or `waste`.
 *
 * Usage (repo root):
 *   npx tsx --env-file=.env apps/worker/scripts/reclassify-order-lines.ts            # dry run (default)
 *   npx tsx --env-file=.env apps/worker/scripts/reclassify-order-lines.ts --apply    # writes
 *
 * Dry run prints counts by (old colour -> new colour) and a few sample descriptions per transition;
 * nothing is written unless --apply is passed.
 */
import { classifyOrderLine, type OrderLineContext } from '@mps/core';
import { createDb, vantageSalesOrderLines, vantageSalesOrders, type Db } from '@mps/db';
import { getDeviceIsColourByVantageEquipmentIds } from '@mps/db/queries';
import { eq } from 'drizzle-orm';

const SAMPLE_LIMIT = 5;

export interface ReclassifyResult {
  /** Rows examined: every `vantage_sales_order_lines` row whose `colour` is currently `unknown`. */
  scanned: number;
  /** How many of those the recomputed classification actually changes. */
  changed: number;
  /** Count per `oldColour->newColour` transition. */
  byTransition: Map<string, number>;
  /** Up to `SAMPLE_LIMIT` sample line descriptions per transition, for the dry-run printout. */
  samples: Map<string, string[]>;
}

function lineText(details: string | null, itemDescription: string | null): string {
  return details || itemDescription || '(no text)';
}

/**
 * Re-runs classification over every `unknown` line and, when `apply` is true, writes the rows whose
 * colour or source actually changes. Always returns the full before/after summary, dry run or not.
 */
export async function reclassifyOrderLines(db: Db, opts: { apply: boolean }): Promise<ReclassifyResult> {
  const rows = await db
    .select({
      vantageId: vantageSalesOrderLines.vantageId,
      details: vantageSalesOrderLines.details,
      itemDescription: vantageSalesOrderLines.itemDescription,
      itemPartNumber: vantageSalesOrderLines.itemPartNumber,
      lineEquipmentId: vantageSalesOrderLines.vantageEquipmentId,
      headerEquipmentId: vantageSalesOrders.vantageEquipmentId,
      colour: vantageSalesOrderLines.colour,
      colourSource: vantageSalesOrderLines.colourSource,
    })
    .from(vantageSalesOrderLines)
    .innerJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, vantageSalesOrderLines.salesOrderId))
    .where(eq(vantageSalesOrderLines.colour, 'unknown'));

  const equipmentIds = new Set<number>();
  for (const r of rows) {
    const eqId = r.lineEquipmentId ?? r.headerEquipmentId;
    if (eqId !== null) equipmentIds.add(eqId);
  }
  const deviceIsColour = await getDeviceIsColourByVantageEquipmentIds(db, [...equipmentIds]);

  const byTransition = new Map<string, number>();
  const samples = new Map<string, string[]>();
  const toUpdate: { vantageId: number; colour: string; colourSource: string }[] = [];

  for (const r of rows) {
    const eqId = r.lineEquipmentId ?? r.headerEquipmentId;
    const context: OrderLineContext = { deviceIsColour: eqId === null ? null : (deviceIsColour.get(eqId) ?? null) };
    const { colour, source } = classifyOrderLine(
      { details: r.details, itemDescription: r.itemDescription, partNumber: r.itemPartNumber },
      context,
    );
    if (colour === r.colour && source === r.colourSource) continue;

    const transition = `${r.colour}->${colour}`;
    byTransition.set(transition, (byTransition.get(transition) ?? 0) + 1);
    const sampleList = samples.get(transition) ?? [];
    if (sampleList.length < SAMPLE_LIMIT) {
      sampleList.push(lineText(r.details, r.itemDescription));
      samples.set(transition, sampleList);
    }
    toUpdate.push({ vantageId: r.vantageId, colour, colourSource: source });
  }

  if (opts.apply) {
    for (const u of toUpdate) {
      await db
        .update(vantageSalesOrderLines)
        .set({ colour: u.colour, colourSource: u.colourSource })
        .where(eq(vantageSalesOrderLines.vantageId, u.vantageId));
    }
  }

  return { scanned: rows.length, changed: toUpdate.length, byTransition, samples };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const result = await reclassifyOrderLines(db, { apply });
    console.log(
      `scanned ${result.scanned} unknown line(s), ${result.changed} would change` +
        (apply ? ' (applied)' : ' (dry run — pass --apply to write)'),
    );
    for (const [transition, count] of result.byTransition) {
      console.log(`  ${transition}: ${count}`);
      for (const sample of result.samples.get(transition) ?? []) {
        console.log(`    - ${sample}`);
      }
    }
  } finally {
    await pool.end();
  }
}

// Only run as a CLI, not when imported by the test above.
if (process.argv[1]?.endsWith('reclassify-order-lines.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
