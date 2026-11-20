import { REPLENISH_COLOURS, decideHold, type HoldDecision } from '@mps/core';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { counterSnapshots, counterValues, vantageSalesOrderLines, vantageSalesOrders } from '../schema';
import { londonDayAsUtc } from './order-watch';
import { TONER_NAMES } from './shared';
import { computeColourYield, isStale, loadYieldInputs, meterPointsFor, type DeliveryEvent } from './toner-yield';

/**
 * Which pending toner proposals to hold because the last cartridge sent for the colour was probably
 * never fitted. Read-only: loads the rows and feeds `decideHold` (@mps/core), which holds the rules.
 */

export interface HoldCandidate {
  id: number;
  drmsEquipmentId: string;
  colour: 'black' | 'cyan' | 'magenta' | 'yellow';
}

type TonerColour = HoldCandidate['colour'];

const colourOfLevel = (name: string): TonerColour | null => (Object.keys(TONER_NAMES) as TonerColour[]).find((c) => TONER_NAMES[c] === name) ?? null;

interface OrderLine extends DeliveryEvent {
  reference: string | null;
}

/** Every candidate id is a key; null = no hold (or not enough known to hold). */
export async function computeHolds(db: Db, candidates: HoldCandidate[], now: Date): Promise<Map<number, HoldDecision | null>> {
  const out = new Map<number, HoldDecision | null>();
  for (const c of candidates) out.set(c.id, null);
  if (candidates.length === 0) return out;

  const drmsIds = [...new Set(candidates.map((c) => c.drmsEquipmentId))];
  // Only the candidate colours' counters are read (not the narrower "newest reading at or before the anchor" window: that needs per-device bounds and is not worth the query).
  const levelNames = [...new Set(candidates.map((c) => TONER_NAMES[c.colour]))];
  const devices = await loadYieldInputs(db, drmsIds);

  // Last-order lines per linked equipment and colour (same filters as the yield loader's deliveries).
  const equipmentIds = [...new Set([...devices.values()].map((d) => d.vantageEquipmentId).filter((v): v is number => v !== null))];
  const lines = new Map<string, OrderLine[]>();
  if (equipmentIds.length > 0) {
    const equipmentOf = sql<number>`coalesce(${vantageSalesOrderLines.vantageEquipmentId}, ${vantageSalesOrders.vantageEquipmentId})`;
    const rows = await db
      .select({
        equipmentId: equipmentOf,
        colour: vantageSalesOrderLines.colour,
        lineId: vantageSalesOrderLines.vantageId,
        salesOrderId: vantageSalesOrderLines.salesOrderId,
        quantity: vantageSalesOrderLines.quantity,
        reference: vantageSalesOrders.reference,
        orderDate: vantageSalesOrders.orderDate,
      })
      .from(vantageSalesOrderLines)
      .innerJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, vantageSalesOrderLines.salesOrderId))
      .where(
        and(
          isNull(vantageSalesOrders.deletedDate),
          isNull(vantageSalesOrderLines.returnedDate),
          isNotNull(vantageSalesOrders.orderDate),
          inArray(vantageSalesOrderLines.colour, [...REPLENISH_COLOURS]),
          inArray(equipmentOf, equipmentIds),
        ),
      )
      .orderBy(asc(vantageSalesOrders.orderDate), asc(vantageSalesOrderLines.vantageId));
    for (const r of rows) {
      if (!r.colour || !r.orderDate) continue;
      const q = r.quantity === null ? null : Number(r.quantity);
      const key = `${Number(r.equipmentId)}|${r.colour}`;
      const list = lines.get(key) ?? [];
      list.push({
        orderDate: r.orderDate,
        salesOrderId: r.salesOrderId,
        lineId: r.lineId,
        quantity: q !== null && Number.isFinite(q) ? q : null,
        reference: r.reference,
      });
      lines.set(key, list);
    }
  }

  // DRMS toner level readings, per device and colour, oldest first.
  const levelRows = await db
    .select({ drmsEquipmentId: counterSnapshots.drmsEquipmentId, name: counterValues.name, at: counterSnapshots.receivedTime, value: counterValues.value })
    .from(counterValues)
    .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
    .where(and(inArray(counterValues.name, levelNames), isNotNull(counterSnapshots.receivedTime), inArray(counterSnapshots.drmsEquipmentId, drmsIds)))
    .orderBy(asc(counterSnapshots.receivedTime), asc(counterSnapshots.id));
  const levels = new Map<string, { at: Date; value: number }[]>();
  for (const r of levelRows) {
    const colour = colourOfLevel(r.name);
    if (!colour || !r.at || r.value === null) continue;
    const key = `${r.drmsEquipmentId}|${colour}`;
    const list = levels.get(key) ?? [];
    list.push({ at: r.at, value: r.value });
    levels.set(key, list);
  }

  for (const c of candidates) {
    const dev = devices.get(c.drmsEquipmentId);
    if (!dev || dev.vantageEquipmentId === null) continue;

    // Last order = every line on the newest order day (London calendar day). The anchor is that order date, never completed_date:
    // Vantage completes toner orders a median of 9 days (p90 19) after ordering, so a cartridge fitted on delivery would predate a completion anchor.
    const all = lines.get(`${dev.vantageEquipmentId}|${c.colour}`) ?? [];
    const dayOf = (l: OrderLine) => londonDayAsUtc(l.orderDate).getTime();
    const newestDay = all.reduce((m, l) => Math.max(m, dayOf(l)), -Infinity);
    const group = all.filter((l) => dayOf(l) === newestDay);
    const first = group[0];
    if (!first) continue;
    const orderDate = group.reduce((m, l) => (l.orderDate < m ? l.orderDate : m), first.orderDate);

    // Reuse the yield arithmetic: the group as one delivery (same date), so quantity sums and pages-since matches the yield screens.
    const points = meterPointsFor(c.colour, dev.isColour, dev.snapshots);
    const ratedYield = dev.rated[c.colour];
    const yieldInfo = computeColourYield({
      colour: c.colour,
      ratedYield,
      events: group.map((l) => ({ ...l, orderDate })),
      points,
      stale: false,
    });
    const quantity = yieldInfo.cartridges[0]?.quantity ?? 1;

    out.set(
      c.id,
      decideHold({
        colour: c.colour,
        lastOrder: { anchor: orderDate, orderDate, reference: first.reference, quantity },
        levels: levels.get(`${c.drmsEquipmentId}|${c.colour}`) ?? [],
        pagesSince: yieldInfo.pagesSinceLastOrder,
        pagesSinceEstimated: yieldInfo.pagesSinceEstimated,
        ratedYield,
        metersStale: isStale(points[points.length - 1]?.at ?? null, now),
      }),
    );
  }
  return out;
}
