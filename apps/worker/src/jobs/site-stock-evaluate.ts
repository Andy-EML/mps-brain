import { REPLENISH_COLOURS, countUse, siteStockUse, topUpLines, type LevelPoint, type ReplenishColour, type ShelfConsumableCounts, type TonerColour } from '@mps/core';
import {
  cartridgeFamilies,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  replenishmentProposals,
  siteStockEvents,
  siteStockMembers,
  siteStockShelves,
  type Db,
} from '@mps/db';
import { TONER_NAMES, shelfDevicesSubquery } from '@mps/db/queries';
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, sql } from 'drizzle-orm';

type ShelfRow = typeof siteStockShelves.$inferSelect;

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

/** Colours a shelf tracks: held (> 0), and cyan, magenta and yellow only for a colour family. */
function trackedColours(shelf: ShelfRow, isColour: boolean): Set<ReplenishColour> {
  const holding = countsOf('holding', shelf);
  return new Set(REPLENISH_COLOURS.filter((c) => holding[c] > 0 && (isColour || c === 'black' || c === 'waste')));
}

/**
 * Counts new cartridge uses from DRMS "empty" alarms against each shelf, raises a top-up proposal
 * for any shelf that has used up a consumable, and reports which colours each device's shelf now
 * covers (so the per-device engine stops proposing them). Idempotent: an alarm is evaluated once
 * per shelf (`site_stock_events` is unique on shelf + alarm). A device counts against a shelf only
 * from when it joined it (`site_stock_members`), and a pending top-up the shelf no longer covers
 * is superseded before any new one is raised.
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

  // Membership start: a device seen on a shelf for the first time joins it now (a new shelf's
  // devices were already recorded at its counting_from). A recorded pair that is no longer current
  // is kept, so a transient drop does not reset the start on return; it is deleted only when the
  // device is now a current member of a different shelf (a real move: the new shelf starts afresh).
  const memberKey = (shelfId: number, drmsId: string) => `${shelfId}:${drmsId}`;
  const current = new Set(members.map((m) => memberKey(m.shelfId, m.drmsId)));
  const currentShelfOf = new Map(members.map((m) => [m.drmsId, m.shelfId]));
  const recorded = await db.select().from(siteStockMembers);
  const since = new Map<string, Date>();
  for (const r of recorded) {
    const key = memberKey(r.shelfId, r.drmsEquipmentId);
    if (current.has(key)) since.set(key, r.since);
    else if (currentShelfOf.has(r.drmsEquipmentId)) {
      await db.delete(siteStockMembers).where(and(eq(siteStockMembers.shelfId, r.shelfId), eq(siteStockMembers.drmsEquipmentId, r.drmsEquipmentId)));
    }
  }
  const joined = members.filter((m) => !since.has(memberKey(m.shelfId, m.drmsId)));
  if (joined.length > 0) {
    await db
      .insert(siteStockMembers)
      .values(joined.map((m) => ({ shelfId: m.shelfId, drmsEquipmentId: m.drmsId, since: now })))
      .onConflictDoNothing();
    for (const m of joined) since.set(memberKey(m.shelfId, m.drmsId), now);
  }

  // `from`: alarms before the shelf's counting start, or before the device joined it, never count.
  const shelfOf = new Map<string, { shelfId: number; tracked: Set<ReplenishColour>; from: Date }>();
  for (const m of members) {
    const shelf = shelfById.get(m.shelfId)!;
    const tracked = trackedColours(shelf, m.isColour);
    const joinedAt = since.get(memberKey(m.shelfId, m.drmsId))!;
    shelfOf.set(m.drmsId, { shelfId: m.shelfId, tracked, from: joinedAt > shelf.countingFrom ? joinedAt : shelf.countingFrom });
    covered.set(m.drmsId, tracked);
  }

  if (shelfOf.size > 0) {
    const minFrom = [...shelfOf.values()].reduce((a, s) => (s.from < a ? s.from : a), [...shelfOf.values()][0]!.from);
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
      if (a.receivedAt < member.from || seenKeys.has(`${shelf.id}:${a.alarmId}`)) continue;
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
          .values({ shelfId: shelf.id, alarmId: a.alarmId, drmsEquipmentId: a.drmsId, colour, receivedAt: a.receivedAt, counted, reason, createdAt: now })
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
  const freshRows = await db
    .select({ shelf: siteStockShelves, isColour: cartridgeFamilies.isColour })
    .from(siteStockShelves)
    .innerJoin(cartridgeFamilies, eq(cartridgeFamilies.id, siteStockShelves.familyId));
  const trackedByShelf = new Map(freshRows.map((r) => [r.shelf.id, trackedColours(r.shelf, r.isColour)]));
  const memberByDevice = new Map(members.map((m) => [m.drmsId, m]));

  // A pending top-up whose colour the shelf no longer tracks, or whose device has left the shelf,
  // is superseded so the device's own proposals take the colour back (and no order goes to a
  // device off the site). Not a rejection: the same run may raise it again on a current member.
  const pendingTopUps = await db
    .select({ id: replenishmentProposals.id, shelfId: replenishmentProposals.shelfId, drmsId: replenishmentProposals.drmsEquipmentId, colour: replenishmentProposals.colour })
    .from(replenishmentProposals)
    .where(and(eq(replenishmentProposals.status, 'pending'), isNotNull(replenishmentProposals.shelfId)));
  for (const p of pendingTopUps) {
    const tracked = trackedByShelf.get(p.shelfId!);
    if (!tracked) continue;
    const note = !tracked.has(p.colour) ? 'no longer held' : memberByDevice.get(p.drmsId)?.shelfId !== p.shelfId ? 'no longer on shelf' : null;
    if (note === null) continue;
    await db
      .update(replenishmentProposals)
      .set({ status: 'superseded', decidedAt: now, note })
      .where(and(eq(replenishmentProposals.id, p.id), eq(replenishmentProposals.status, 'pending')));
  }

  const live = await db
    .selectDistinct({ shelfId: replenishmentProposals.shelfId })
    .from(replenishmentProposals)
    .where(and(inArray(replenishmentProposals.status, ['pending', 'approved']), isNotNull(replenishmentProposals.shelfId)));
  const liveShelves = new Set(live.map((l) => l.shelfId));

  for (const { shelf } of freshRows) {
    if (liveShelves.has(shelf.id)) continue;
    // Only tracked colours: a mono family's stale cyan, magenta or yellow never triggers or joins.
    const tracked = trackedByShelf.get(shelf.id)!;
    const raw = countsOf('holding', shelf);
    const holding = {} as ShelfConsumableCounts;
    for (const c of REPLENISH_COLOURS) holding[c] = tracked.has(c) ? raw[c] : 0;
    const used = countsOf('used', shelf);
    const lines = topUpLines(holding, used);
    if (lines.length === 0) continue;

    // A rejected top-up leaves the counts as they are; only a use counted after the rejection re-evaluates.
    const [rejected] = await db
      .select({ decidedAt: replenishmentProposals.decidedAt })
      .from(replenishmentProposals)
      .where(and(eq(replenishmentProposals.shelfId, shelf.id), eq(replenishmentProposals.status, 'rejected'), isNotNull(replenishmentProposals.decidedAt)))
      .orderBy(desc(replenishmentProposals.decidedAt))
      .limit(1);
    if (rejected?.decidedAt) {
      const [newer] = await db
        .select({ id: siteStockEvents.id })
        .from(siteStockEvents)
        .where(and(eq(siteStockEvents.shelfId, shelf.id), eq(siteStockEvents.counted, true), gt(siteStockEvents.createdAt, rejected.decidedAt)))
        .limit(1);
      if (!newer) continue;
    }

    const triggered = REPLENISH_COLOURS.filter((c) => holding[c] > 0 && used[c] >= holding[c]);
    const triggers = await db
      .select({
        drmsId: siteStockEvents.drmsEquipmentId,
        alarmId: siteStockEvents.alarmId,
        description: deviceAlarms.description,
      })
      .from(siteStockEvents)
      .leftJoin(deviceAlarms, eq(deviceAlarms.alarmId, siteStockEvents.alarmId))
      .where(and(eq(siteStockEvents.shelfId, shelf.id), eq(siteStockEvents.counted, true), inArray(siteStockEvents.colour, triggered)))
      .orderBy(desc(siteStockEvents.receivedAt), desc(siteStockEvents.id));
    // The triggering device must still be on the shelf (linked); counts set by hand (CSV import)
    // have no event behind them: fall back to a member device.
    const onShelf = (id: string | null) => id !== null && memberByDevice.get(id)?.shelfId === shelf.id;
    const trigger = triggers.find((e) => onShelf(e.drmsId));
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
