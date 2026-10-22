import { REPLENISH_COLOURS, countUse, siteStockUse, topUpLines, type LevelPoint, type ReplenishColour, type ShelfConsumableCounts, type TonerColour } from '@mps/core';
import {
  cartridgeFamilies,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  replenishmentProposals,
  siteStockEvents,
  siteStockShelves,
  type Db,
} from '@mps/db';
import { TONER_NAMES, shelfDevicesSubquery } from '@mps/db/queries';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';

export interface SiteStockStats {
  shelves: number;
  considered: number;
  counted: number;
  topUps: number;
}

const cap = (c: ReplenishColour) => (c.charAt(0).toUpperCase() + c.slice(1)) as Capitalize<ReplenishColour>;

const USED_COLUMN = {
  black: siteStockShelves.usedBlack,
  cyan: siteStockShelves.usedCyan,
  magenta: siteStockShelves.usedMagenta,
  yellow: siteStockShelves.usedYellow,
  waste: siteStockShelves.usedWaste,
} as const;
const USED_KEY = {
  black: 'usedBlack',
  cyan: 'usedCyan',
  magenta: 'usedMagenta',
  yellow: 'usedYellow',
  waste: 'usedWaste',
} as const;

function countsOf(prefix: 'holding' | 'used', row: object): ShelfConsumableCounts {
  const out = {} as ShelfConsumableCounts;
  for (const c of REPLENISH_COLOURS) out[c] = (row as Record<string, number>)[`${prefix}${cap(c)}`] ?? 0;
  return out;
}

/**
 * Counts new cartridge uses from DRMS "empty" alarms against each shelf, raises a top-up proposal
 * for any shelf that has used up a consumable, and reports which colours each device's shelf now
 * covers (so the per-device engine stops proposing them). Idempotent: an alarm is evaluated once
 * per shelf (`site_stock_events` is unique on shelf + alarm).
 */
export async function evaluateSiteStock(
  db: Db,
  now: Date,
): Promise<{ covered: Map<string, Set<ReplenishColour>>; stats: SiteStockStats }> {
  const stats: SiteStockStats = { shelves: 0, considered: 0, counted: 0, topUps: 0 };
  const covered = new Map<string, Set<ReplenishColour>>();

  const shelves = await db.select().from(siteStockShelves);
  stats.shelves = shelves.length;
  if (shelves.length === 0) return { covered, stats };
  const shelfById = new Map(shelves.map((s) => [s.id, s]));

  const sd = shelfDevicesSubquery(db);
  const members = await db
    .select({ shelfId: sd.shelfId, drmsId: sd.drmsId, vantageEquipmentId: sd.vantageEquipmentId, isColour: cartridgeFamilies.isColour })
    .from(sd)
    .innerJoin(cartridgeFamilies, eq(cartridgeFamilies.id, sd.familyId))
    .orderBy(asc(sd.drmsId));

  // Colours a shelf tracks: held (> 0), and CMY only for a colour family.
  const shelfOf = new Map<string, { shelfId: number; tracked: Set<ReplenishColour> }>();
  for (const m of members) {
    const holding = countsOf('holding', shelfById.get(m.shelfId)!);
    const tracked = new Set(REPLENISH_COLOURS.filter((c) => holding[c] > 0 && (m.isColour || c === 'black' || c === 'waste')));
    shelfOf.set(m.drmsId, { shelfId: m.shelfId, tracked });
    covered.set(m.drmsId, tracked);
  }

  if (shelfOf.size > 0) {
    const minFrom = shelves.reduce((a, s) => (s.countingFrom < a ? s.countingFrom : a), shelves[0]!.countingFrom);
    // Oldest first, so an earlier count feeds the decision on a later alarm in the same run.
    const alarms = await db
      .select({
        alarmId: deviceAlarms.alarmId,
        drmsId: deviceAlarms.drmsEquipmentId,
        receivedAt: deviceAlarms.receivedTime,
        description: deviceAlarms.description,
      })
      .from(deviceAlarms)
      .where(and(inArray(deviceAlarms.drmsEquipmentId, [...shelfOf.keys()]), sql`${deviceAlarms.receivedTime} >= ${minFrom}`))
      .orderBy(asc(deviceAlarms.receivedTime), asc(deviceAlarms.alarmId));

    const seen = await db
      .select({ shelfId: siteStockEvents.shelfId, alarmId: siteStockEvents.alarmId })
      .from(siteStockEvents)
      .where(inArray(siteStockEvents.shelfId, [...new Set([...shelfOf.values()].map((s) => s.shelfId))]));
    const seenKeys = new Set(seen.map((s) => `${s.shelfId}:${s.alarmId}`));

    for (const a of alarms) {
      const member = shelfOf.get(a.drmsId)!;
      const shelf = shelfById.get(member.shelfId)!;
      if (a.receivedAt < shelf.countingFrom || seenKeys.has(`${shelf.id}:${a.alarmId}`)) continue;
      const colour = siteStockUse(a.description);
      if (colour === null || !member.tracked.has(colour)) continue;
      stats.considered++;

      await db.transaction(async (tx) => {
        const [previous] = await tx
          .select({ receivedAt: siteStockEvents.receivedAt })
          .from(siteStockEvents)
          .where(
            and(
              eq(siteStockEvents.shelfId, shelf.id),
              eq(siteStockEvents.drmsEquipmentId, a.drmsId),
              eq(siteStockEvents.colour, colour),
              eq(siteStockEvents.counted, true),
            ),
          )
          .orderBy(desc(siteStockEvents.receivedAt), desc(siteStockEvents.id))
          .limit(1);

        // Waste has no level; with no previous use nothing is compared.
        let levels: LevelPoint[] = [];
        if (previous && colour !== 'waste') {
          const rows = await tx
            .select({ at: counterSnapshots.receivedTime, value: counterValues.value })
            .from(counterValues)
            .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
            .where(
              and(
                eq(counterSnapshots.drmsEquipmentId, a.drmsId),
                eq(counterValues.name, TONER_NAMES[colour as TonerColour]),
                gt(counterSnapshots.receivedTime, previous.receivedAt),
                lte(counterSnapshots.receivedTime, a.receivedAt),
                isNotNull(counterValues.value),
              ),
            );
          levels = rows.map((r) => ({ at: r.at!, value: r.value! }));
        }

        const { counted, reason } = countUse({
          colour,
          receivedAt: a.receivedAt,
          countingFrom: shelf.countingFrom,
          previous: previous ?? null,
          levelsSincePrevious: levels,
        });
        const inserted = await tx
          .insert(siteStockEvents)
          .values({ shelfId: shelf.id, alarmId: a.alarmId, drmsEquipmentId: a.drmsId, colour, receivedAt: a.receivedAt, counted, reason })
          .onConflictDoNothing()
          .returning({ id: siteStockEvents.id });
        if (inserted.length > 0 && counted) {
          await tx
            .update(siteStockShelves)
            .set({ [USED_KEY[colour]]: sql`${USED_COLUMN[colour]} + 1` })
            .where(eq(siteStockShelves.id, shelf.id));
          stats.counted++;
        }
      });
      seenKeys.add(`${shelf.id}:${a.alarmId}`);
    }
  }

  // Top-ups: one batch per shelf, never while that shelf already has one pending or approved.
  const fresh = await db.select().from(siteStockShelves);
  const live = await db
    .selectDistinct({ shelfId: replenishmentProposals.shelfId })
    .from(replenishmentProposals)
    .where(and(inArray(replenishmentProposals.status, ['pending', 'approved']), isNotNull(replenishmentProposals.shelfId)));
  const liveShelves = new Set(live.map((l) => l.shelfId));
  const memberByDevice = new Map(members.map((m) => [m.drmsId, m]));

  for (const shelf of fresh) {
    if (liveShelves.has(shelf.id)) continue;
    const holding = countsOf('holding', shelf);
    const used = countsOf('used', shelf);
    const lines = topUpLines(holding, used);
    if (lines.length === 0) continue;

    const triggered = REPLENISH_COLOURS.filter((c) => holding[c] > 0 && used[c] >= holding[c]);
    const [trigger] = await db
      .select({
        drmsId: siteStockEvents.drmsEquipmentId,
        alarmId: siteStockEvents.alarmId,
        description: deviceAlarms.description,
      })
      .from(siteStockEvents)
      .leftJoin(deviceAlarms, eq(deviceAlarms.alarmId, siteStockEvents.alarmId))
      .where(and(eq(siteStockEvents.shelfId, shelf.id), eq(siteStockEvents.counted, true), inArray(siteStockEvents.colour, triggered)))
      .orderBy(desc(siteStockEvents.receivedAt), desc(siteStockEvents.id))
      .limit(1);
    // Counts set by hand (CSV import) have no event behind them: fall back to a member device.
    const drmsId = trigger?.drmsId ?? members.find((m) => m.shelfId === shelf.id)?.drmsId;
    if (!drmsId) continue;

    const inserted = await db
      .insert(replenishmentProposals)
      .values(
        lines.map((l) => ({
          drmsEquipmentId: drmsId,
          vantageEquipmentId: memberByDevice.get(drmsId)?.vantageEquipmentId ?? null,
          colour: l.colour,
          trigger: 'site_stock' as const,
          quantity: l.quantity,
          alarmId: trigger?.alarmId ?? null,
          alarmDescription: trigger?.description ?? null,
          shelfId: shelf.id,
          status: 'pending' as const,
          createdAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: replenishmentProposals.id });
    stats.topUps += inserted.length;
  }

  return { covered, stats };
}
