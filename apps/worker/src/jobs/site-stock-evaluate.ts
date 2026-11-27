import { DELIVERY_COUNT_FROM, MEMBER_GRACE_DAYS, REPLENISH_COLOURS, SHELF_SAME_CHANGE_DAYS, countUse, deliveryColour, detectChanges, siteStockUse, topUpLines, type EmptyEvent, type LevelPoint, type LevelReading, type ReplenishColour, type ShelfConsumableCounts, type TonerColour } from '@mps/core';
import {
  cartridgeFamilies,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  replenishmentProposals,
  replenishmentSettings,
  siteStockEvents,
  siteStockMembers,
  siteStockShelves,
  type Db,
} from '@mps/db';
import { SELF_MANAGED_NOTE, TONER_NAMES, selfManagedSourceSql, shelfDevicesSubquery } from '@mps/db/queries';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';

type ShelfRow = typeof siteStockShelves.$inferSelect;

export interface SiteStockStats {
  shelves: number;
  considered: number;
  counted: number;
  topUps: number;
}

const cap = (c: ReplenishColour) => (c.charAt(0).toUpperCase() + c.slice(1)) as Capitalize<ReplenishColour>;

const LEVEL_LABEL = { black: 'BK', cyan: 'C', magenta: 'M', yellow: 'Y', waste: 'W' } as const;

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
 * per shelf (`site_stock_events` is unique on shelf + alarm). A Toner Delivery alarm (a cartridge fitted)
 * is a use too, but only for a colour the shelf holds, and one cartridge change counts once: an Empty,
 * a Delivery and a level rise for the same device and colour within SHELF_SAME_CHANGE_DAYS of each other are
 * one use, with `delivery` as the preferred reason. A device counts against a shelf only
 * from when it joined it (`site_stock_members`), and a pending top-up the shelf no longer covers
 * is superseded before any new one is raised. Deliveries received before `deliveryFrom` (default
 * DELIVERY_COUNT_FROM, the deploy day) are never counted, so the history is not backfilled; a Delivery that
 * follows a counted Empty with nothing fitted since is that Empty's change whatever the gap.
 */
export async function evaluateSiteStock(
  db: Db,
  now: Date,
  opts: { deliveryFrom?: Date } = {},
): Promise<{ covered: Map<string, Set<ReplenishColour>>; stats: SiteStockStats }> {
  const deliveryFrom = opts.deliveryFrom ?? DELIVERY_COUNT_FROM;
  const stats: SiteStockStats = { shelves: 0, considered: 0, counted: 0, topUps: 0 };
  const covered = new Map<string, Set<ReplenishColour>>();

  const shelves = await db.select().from(siteStockShelves);
  stats.shelves = shelves.length;
  if (shelves.length === 0) return { covered, stats };

  const sd = shelfDevicesSubquery(db);
  const members = await db
    .select({ shelfId: sd.shelfId, drmsId: sd.drmsId, vantageEquipmentId: sd.vantageEquipmentId, isColour: cartridgeFamilies.isColour })
    .from(sd)
    .innerJoin(cartridgeFamilies, eq(cartridgeFamilies.id, sd.familyId))
    .orderBy(asc(sd.drmsId));
  const shelfById = new Map(shelves.map((s) => [s.id, s]));

  // Membership start: a device seen on a shelf for the first time joins it now (a new shelf's
  // devices were already recorded at its counting_from). A recorded pair that stops being current
  // is kept with `left_at` set, so a transient drop does not reset the start on return. Back within
  // MEMBER_GRACE_DAYS it keeps `since` (the absence's Empties count); after that it starts afresh
  // at `now`. A departed pair is deleted when the device is a current member of a different shelf
  // (a real move: the new shelf starts afresh) or once its absence outlasts the grace window.
  const memberKey = (shelfId: number, drmsId: string) => `${shelfId}:${drmsId}`;
  const graceMs = MEMBER_GRACE_DAYS * 86_400_000;
  const current = new Set(members.map((m) => memberKey(m.shelfId, m.drmsId)));
  const currentShelfOf = new Map(members.map((m) => [m.drmsId, m.shelfId]));
  const recorded = await db.select().from(siteStockMembers);
  const rowIs = (r: { shelfId: number; drmsEquipmentId: string }) => and(eq(siteStockMembers.shelfId, r.shelfId), eq(siteStockMembers.drmsEquipmentId, r.drmsEquipmentId));
  const since = new Map<string, Date>();
  for (const r of recorded) {
    const key = memberKey(r.shelfId, r.drmsEquipmentId);
    if (current.has(key)) {
      if (r.leftAt === null) since.set(key, r.since);
      else {
        const within = now.getTime() - r.leftAt.getTime() <= graceMs;
        const start = within ? r.since : now;
        await db.update(siteStockMembers).set({ since: start, leftAt: null }).where(rowIs(r));
        since.set(key, start);
      }
    } else if (currentShelfOf.has(r.drmsEquipmentId)) {
      await db.delete(siteStockMembers).where(rowIs(r));
    } else if (r.leftAt === null) {
      await db.update(siteStockMembers).set({ leftAt: now }).where(rowIs(r));
    } else if (now.getTime() - r.leftAt.getTime() > graceMs) {
      await db.delete(siteStockMembers).where(rowIs(r));
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
    const shelf = shelfById.get(m.shelfId);
    if (!shelf) continue; // created after the shelves were read; the next run picks it up
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
      .where(and(eq(siteStockEvents.source, 'empty_alarm'), inArray(siteStockEvents.shelfId, [...new Set([...shelfOf.values()].map((s) => s.shelfId))])));
    const seenKeys = new Set(seen.map((s) => `${s.shelfId}:${s.alarmId}`));

    for (const a of alarms) {
      const member = shelfOf.get(a.drmsId)!;
      const shelf = shelfById.get(member.shelfId)!;
      if (a.receivedAt < member.from || seenKeys.has(`${shelf.id}:${a.alarmId}`)) continue;
      const deliveryOf = deliveryColour(a.description);
      if (deliveryOf !== null && a.receivedAt < deliveryFrom) continue;
      const colour = siteStockUse(a.description) ?? deliveryOf;
      if (colour === null || !member.tracked.has(colour)) continue;
      const isDelivery = deliveryOf !== null;
      stats.considered++;

      await db.transaction(async (tx) => {
        const [previous] = await tx
          .select({ id: siteStockEvents.id, receivedAt: siteStockEvents.receivedAt, source: siteStockEvents.source, reason: siteStockEvents.reason })
          .from(siteStockEvents)
          .where(
            and(
              eq(siteStockEvents.shelfId, shelf.id),
              eq(siteStockEvents.drmsEquipmentId, a.drmsId),
              eq(siteStockEvents.colour, colour),
              eq(siteStockEvents.counted, true),
              lte(siteStockEvents.receivedAt, a.receivedAt),
            ),
          )
          .orderBy(desc(siteStockEvents.receivedAt), desc(siteStockEvents.id))
          .limit(1);

        // One cartridge change counts once. A Delivery within SHELF_SAME_CHANGE_DAYS after a counted use of the
        // colour (an Empty, a level rise or another Delivery), or an Empty within that window after a counted
        // Delivery, is that same change: recorded, not counted. A Delivery after a counted Empty (not yet
        // relabelled) with nothing fitted since is that Empty's change whatever the gap, like a level rise
        // after an Empty. (No cap: RECOUNT_DAYS is 14, the same as the window, so a cap would change nothing.)
        // The Delivery is the preferred reason, so a counted Empty it follows is relabelled `delivery`
        // (a level rise keeps its own label).
        const afterEmpty = isDelivery && previous?.source === 'empty_alarm' && previous.reason !== 'delivery';
        const sameChange =
          previous !== undefined &&
          (afterEmpty ||
            ((isDelivery || previous.reason === 'delivery') &&
              a.receivedAt.getTime() - previous.receivedAt.getTime() <= SHELF_SAME_CHANGE_DAYS * 86_400_000));
        if (sameChange) {
          const inserted = await tx
            .insert(siteStockEvents)
            .values({ shelfId: shelf.id, alarmId: a.alarmId, drmsEquipmentId: a.drmsId, colour, receivedAt: a.receivedAt, counted: false, reason: isDelivery ? 'delivery_same_change' : 'same_change', createdAt: now })
            .onConflictDoNothing()
            .returning({ id: siteStockEvents.id });
          if (inserted.length > 0 && isDelivery && previous.source === 'empty_alarm' && previous.reason !== 'delivery') {
            await tx.update(siteStockEvents).set({ reason: 'delivery' }).where(eq(siteStockEvents.id, previous.id));
          }
          return;
        }

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
                // A level use is recorded at its high reading, which is itself the fresh-cartridge evidence.
                (previous.source === 'level' ? gte : gt)(counterSnapshots.receivedTime, previous.receivedAt),
                lte(counterSnapshots.receivedTime, a.receivedAt),
                isNotNull(counterValues.value),
              ),
            );
          levels = rows.map((r) => ({ at: r.at!, value: r.value! }));
        }

        // A Delivery is DRMS saying a cartridge went in: a use in its own right, whatever came before.
        let { counted, reason } = isDelivery
          ? { counted: true, reason: 'delivery' as string }
          : countUse({ colour, receivedAt: a.receivedAt, countingFrom: shelf.countingFrom, previous: previous ?? null, levelsSincePrevious: levels });
        // The first Empty after a counted level rise is the new cartridge running out, even if the
        // rise only reached 50-79 (countUse would call it a repeat without a reading >= 80).
        if (!isDelivery && !counted && reason === 'repeat' && previous?.source === 'level' && colour !== 'waste' && a.receivedAt > previous.receivedAt) {
          counted = true;
          reason = 'fresh_cartridge';
        }
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

  // Level rises: a counted rise is a shelf use like an Empty. Empties were decided above, so each
  // (device, colour) starts from its latest counted use (an Empty there absorbs the rise that follows).
  // Precedence trade-off: Empties are decided first, so when a newer counted Empty lands in the same
  // window as an older rise, the Empty becomes `since` and that older rise is skipped.
  // Level history before spare_black_from (ship time) is never looked at, so deploy does not backfill.
  const [defSettings] = await db
    .select({ from: replenishmentSettings.spareBlackFrom })
    .from(replenishmentSettings)
    .where(eq(replenishmentSettings.scope, 'default'));
  const levelFloor = defSettings?.from ?? null;
  if (shelfOf.size > 0) {
    for (const [drmsId, member] of shelfOf) {
      const memberStart = levelFloor && levelFloor > member.from ? levelFloor : member.from;
      const shelf = shelfById.get(member.shelfId)!;
      for (const colour of member.tracked) {
        if (colour === 'waste') continue;
        const [last] = await db
          .select({ receivedAt: siteStockEvents.receivedAt, source: siteStockEvents.source, reason: siteStockEvents.reason })
          .from(siteStockEvents)
          .where(
            and(
              eq(siteStockEvents.shelfId, shelf.id),
              eq(siteStockEvents.drmsEquipmentId, drmsId),
              eq(siteStockEvents.colour, colour),
              eq(siteStockEvents.counted, true),
            ),
          )
          .orderBy(desc(siteStockEvents.receivedAt), desc(siteStockEvents.id))
          .limit(1);
        const since = last && last.receivedAt > memberStart ? last.receivedAt : memberStart;
        // A Delivery is a fit, not an Empty waiting for its swap: it leaves nothing pending.
        const afterEmpty = last !== undefined && last.receivedAt >= memberStart && last.source === 'empty_alarm' && last.reason !== 'delivery';
        const afterDelivery = last !== undefined && last.reason === 'delivery';

        const rows = await db
          .select({ at: counterSnapshots.receivedTime, value: counterValues.value, snapshotId: counterSnapshots.id })
          .from(counterValues)
          .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
          .where(
            and(
              eq(counterSnapshots.drmsEquipmentId, drmsId),
              eq(counterValues.name, TONER_NAMES[colour as TonerColour]),
              isNotNull(counterValues.value),
              gt(counterSnapshots.receivedTime, since),
            ),
          )
          .orderBy(asc(counterSnapshots.receivedTime), asc(counterSnapshots.id));
        if (rows.length === 0) continue;
        const readings: LevelReading[] = rows.map((r) => ({ at: r.at!, value: r.value!, snapshotId: r.snapshotId }));
        const empties: EmptyEvent[] = []; // counted Empties after `since` cannot exist: `since` is the latest counted use

        for (const c of detectChanges({ since, afterEmpty, readings, empties })) {
          if (c.source !== 'level' || c.highSnapshotId === null) continue;
          // A rise within SHELF_SAME_CHANGE_DAYS after a counted Delivery is that same cartridge change.
          if (afterDelivery && c.at.getTime() - last!.receivedAt.getTime() <= SHELF_SAME_CHANGE_DAYS * 86_400_000) continue;
          stats.considered++;
          await db.transaction(async (tx) => {
            const inserted = await tx
              .insert(siteStockEvents)
              .values({
                shelfId: shelf.id,
                alarmId: null,
                source: 'level',
                highSnapshotId: c.highSnapshotId,
                lowSnapshotId: c.lowSnapshotId,
                drmsEquipmentId: drmsId,
                colour,
                receivedAt: c.at,
                counted: true,
                reason: 'level_rise',
                createdAt: now,
              })
              .onConflictDoNothing()
              .returning({ id: siteStockEvents.id });
            if (inserted.length > 0) {
              await tx
                .update(siteStockShelves)
                .set({ [USED_KEY[colour]]: sql`${USED_COLUMN[colour]} + 1` })
                .where(eq(siteStockShelves.id, shelf.id));
              stats.counted++;
            }
          });
        }
      }
    }
  }

  // Top-ups: one batch per shelf, never while that shelf already has one pending or approved.
  const freshRows = await db
    .select({ shelf: siteStockShelves, isColour: cartridgeFamilies.isColour, selfManaged: selfManagedSourceSql(siteStockShelves.vantageCustomerId) })
    .from(siteStockShelves)
    .innerJoin(cartridgeFamilies, eq(cartridgeFamilies.id, siteStockShelves.familyId));
  const trackedByShelf = new Map(freshRows.map((r) => [r.shelf.id, trackedColours(r.shelf, r.isColour)]));
  const memberByDevice = new Map(members.map((m) => [m.drmsId, m]));
  // Self-managed customers' shelves still count uses (above) but never raise or keep a top-up.
  const selfManagedShelves = new Set(freshRows.filter((r) => r.selfManaged !== null).map((r) => r.shelf.id));

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
    const note = selfManagedShelves.has(p.shelfId!)
      ? SELF_MANAGED_NOTE
      : !tracked.has(p.colour) ? 'no longer held' : memberByDevice.get(p.drmsId)?.shelfId !== p.shelfId ? 'no longer on shelf' : null;
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
    if (liveShelves.has(shelf.id) || selfManagedShelves.has(shelf.id)) continue;
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
        source: siteStockEvents.source,
        colour: siteStockEvents.colour,
        description: deviceAlarms.description,
      })
      .from(siteStockEvents)
      .leftJoin(deviceAlarms, and(eq(siteStockEvents.source, 'empty_alarm'), eq(deviceAlarms.alarmId, siteStockEvents.alarmId)))
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
          alarmDescription: trigger?.source === 'level' ? `Toner level rise (${LEVEL_LABEL[trigger.colour ?? 'black']})` : (trigger?.description ?? null),
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
