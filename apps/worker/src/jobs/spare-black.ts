import { RISE_LEVEL, detectChanges, siteStockUse, type EmptyEvent, type LevelReading, type ReplenishColour } from '@mps/core';
import {
  cartridgeChanges,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  hiddenDevices,
  replenishmentProposals,
  replenishmentSettings,
  vantageSalesOrderLines,
  vantageSalesOrders,
  type Db,
} from '@mps/db';
import { effectiveSettingsSubquery, londonDayAsUtc } from '@mps/db/queries';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';

const BLACK_LEVEL = 'BlackTonerLevel';
/** With no earlier high reading to date the first cartridge, it is taken to have gone in this long before counting started. */
const FIRST_CARTRIDGE_LOOKBACK_DAYS = 30;

export interface SpareBlackStats {
  changes: number;
  proposed: number;
  covered: number;
  ineligible: number;
}

/**
 * Notices black cartridge changes (a level that fell low then rose, or a Toner Empty(K) alarm) and
 * decides each exactly once: `proposed` (a pending `spare_used` proposal to replace the spare that
 * was just used), `covered` (a black order already exists for this cartridge) or `ineligible`.
 * Counting starts at the later of the default row's `spare_black_from` and the current link's start.
 * `shelfCovered` is `evaluateSiteStock`'s map of colours a shelf already covers per device.
 */
export async function evaluateSpareBlack(
  db: Db,
  now: Date,
  shelfCovered: Map<string, Set<ReplenishColour>> = new Map(),
): Promise<SpareBlackStats> {
  const stats: SpareBlackStats = { changes: 0, proposed: 0, covered: 0, ineligible: 0 };

  const [def] = await db
    .select({ from: replenishmentSettings.spareBlackFrom })
    .from(replenishmentSettings)
    .where(eq(replenishmentSettings.scope, 'default'));
  const from = def?.from ?? null;
  if (!from) return stats;

  const eff = effectiveSettingsSubquery(db);
  const devices = await db
    .select({
      drmsId: drmsEquipment.drmsId,
      vantageEquipmentId: eff.vantageEquipmentId,
      spareBlack: eff.spareBlack,
      autoReplenish: eff.autoReplenish,
      selfManaged: eff.selfManaged,
      linkedAt: deviceLinks.linkedAt,
      hidden: sql<boolean>`exists (select 1 from ${hiddenDevices} where ${hiddenDevices.drmsEquipmentId} = ${drmsEquipment.drmsId})`,
    })
    .from(drmsEquipment)
    .innerJoin(eff, eq(eff.drmsId, drmsEquipment.drmsId))
    .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
    .where(and(sql`upper(${drmsEquipment.status}) in ('REGISTERED', 'DISCOVERED')`, isNull(drmsEquipment.missingSince)));

  for (const d of devices) {
    const countingStart = d.linkedAt && d.linkedAt > from ? d.linkedAt : from;
    const [last] = await db
      .select({ changedAt: cartridgeChanges.changedAt, source: cartridgeChanges.source })
      .from(cartridgeChanges)
      .where(and(eq(cartridgeChanges.drmsEquipmentId, d.drmsId), eq(cartridgeChanges.colour, 'black')))
      .orderBy(desc(cartridgeChanges.changedAt))
      .limit(1);
    const since = last && last.changedAt > countingStart ? last.changedAt : countingStart;
    const afterEmpty = last !== undefined && last.changedAt >= countingStart && last.source === 'empty_alarm';

    const readingRows = await db
      .select({ at: counterSnapshots.receivedTime, value: counterValues.value, snapshotId: counterSnapshots.id })
      .from(counterValues)
      .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
      .where(
        and(
          eq(counterSnapshots.drmsEquipmentId, d.drmsId),
          eq(counterValues.name, BLACK_LEVEL),
          isNotNull(counterValues.value),
          gt(counterSnapshots.receivedTime, since),
        ),
      )
      .orderBy(asc(counterSnapshots.receivedTime));
    const readings: LevelReading[] = readingRows.map((r) => ({ at: r.at!, value: r.value!, snapshotId: r.snapshotId }));

    const alarmRows = await db
      .select({ at: deviceAlarms.receivedTime, alarmId: deviceAlarms.alarmId, description: deviceAlarms.description })
      .from(deviceAlarms)
      .where(and(eq(deviceAlarms.drmsEquipmentId, d.drmsId), eq(deviceAlarms.category, 'toner'), gt(deviceAlarms.receivedTime, since)))
      .orderBy(asc(deviceAlarms.receivedTime));
    const empties: (EmptyEvent & { description: string | null })[] = alarmRows
      .filter((a) => a.at !== null && siteStockUse(a.description) === 'black')
      .map((a) => ({ at: a.at!, alarmId: a.alarmId, description: a.description }));

    const changes = detectChanges({ since, afterEmpty, readings, empties });
    if (changes.length === 0) continue;

    const ineligible: string | null = d.selfManaged
      ? 'self_managed'
      : !d.spareBlack
      ? 'spare_off'
      : !d.autoReplenish
        ? 'auto_off'
        : d.vantageEquipmentId === null
          ? 'unlinked'
          : d.hidden
            ? 'hidden'
            : shelfCovered.get(d.drmsId)?.has('black')
              ? 'shelf'
              : null;

    await db.transaction(async (tx) => {
      // Where the cartridge being judged started. Detection is floored at the counting start, but the
      // guard for a device's first change must reach back to when its cartridge really went in, or an
      // order raised just before go-live would be ignored and the swap would double-order.
      let start: Date | null = last ? last.changedAt : null;
      for (const c of changes) {
        let outcome: 'proposed' | 'covered' | 'ineligible' = 'ineligible';
        let reason: string | null = ineligible;
        let proposalId: number | null = null;
        let coveredLineId: number | null = null;

        if (ineligible === null) {
          const lowAt = c.source === 'level' ? (readings.find((r) => r.snapshotId === c.lowSnapshotId)?.at ?? c.at) : c.at;
          start ??= await firstCartridgeStart(tx as unknown as Db, d.drmsId, lowAt, countingStart);
          const guardStart: Date = start;
          // One proposal or one Vantage line replaces at most one cartridge: those already tied to an
          // earlier change (as its proposal or its covering line) are consumed.
          const consumed = await tx
            .select({ proposalId: cartridgeChanges.proposalId, lineId: cartridgeChanges.coveredLineId })
            .from(cartridgeChanges)
            .where(eq(cartridgeChanges.drmsEquipmentId, d.drmsId));
          const usedProposals = consumed.map((r) => r.proposalId).filter((x): x is number => x !== null);
          const usedLines = consumed.map((r) => r.lineId).filter((x): x is number => x !== null);
          const [existing] = await tx
            .select({ id: replenishmentProposals.id })
            .from(replenishmentProposals)
            .where(
              and(
                eq(replenishmentProposals.drmsEquipmentId, d.drmsId),
                eq(replenishmentProposals.colour, 'black'),
                inArray(replenishmentProposals.status, ['pending', 'approved', 'ordered']),
                sql`${replenishmentProposals.createdAt} >= ${guardStart}`,
                usedProposals.length ? notInArray(replenishmentProposals.id, usedProposals) : undefined,
              ),
            )
            .orderBy(asc(replenishmentProposals.createdAt), asc(replenishmentProposals.id))
            .limit(1);
          if (existing) {
            outcome = 'covered';
            reason = 'proposal';
            proposalId = existing.id;
          } else {
            const line = await blackLineSince(tx as unknown as Db, d.drmsId, d.vantageEquipmentId!, guardStart, usedLines);
            if (line !== null) {
              outcome = 'covered';
              reason = 'vantage_order';
              coveredLineId = line;
            } else {
              const empty = c.source === 'empty_alarm' ? empties.find((e) => e.alarmId === c.alarmId) : undefined;
              const [p] = await tx
                .insert(replenishmentProposals)
                .values({
                  drmsEquipmentId: d.drmsId,
                  vantageEquipmentId: d.vantageEquipmentId,
                  colour: 'black',
                  trigger: 'spare_used',
                  level: c.highLevel,
                  alarmId: empty?.alarmId ?? null,
                  alarmDescription: empty?.description ?? null,
                  quantity: 1,
                  status: 'pending',
                  createdAt: now,
                })
                .onConflictDoNothing()
                .returning({ id: replenishmentProposals.id });
              if (p) {
                outcome = 'proposed';
                reason = null;
                proposalId = p.id;
              } else {
                // An older proposal for this machine is still live, which already covers a spare.
                const [blocking] = await tx
                  .select({ id: replenishmentProposals.id })
                  .from(replenishmentProposals)
                  .where(
                    and(
                      eq(replenishmentProposals.drmsEquipmentId, d.drmsId),
                      eq(replenishmentProposals.colour, 'black'),
                      inArray(replenishmentProposals.status, ['pending', 'approved']),
                      isNull(replenishmentProposals.shelfId),
                    ),
                  )
                  .limit(1);
                outcome = 'covered';
                if (blocking) {
                  reason = 'live_proposal';
                  proposalId = blocking.id;
                } else {
                  // The conflicting row went away between the insert and this lookup: record it, do not hide it.
                  reason = 'live_proposal_race';
                  proposalId = null;
                  console.warn(`[spare-black] ${d.drmsId}: proposal insert conflicted but no live black proposal found; recorded as live_proposal_race`);
                }
              }
            }
          }
        }

        const inserted = await tx
          .insert(cartridgeChanges)
          .values({
            drmsEquipmentId: d.drmsId,
            colour: 'black',
            changedAt: c.at,
            source: c.source,
            alarmId: c.alarmId,
            lowSnapshotId: c.lowSnapshotId,
            highSnapshotId: c.highSnapshotId,
            lowLevel: c.lowLevel,
            highLevel: c.highLevel,
            outcome,
            reason,
            proposalId,
            coveredLineId,
          })
          .onConflictDoNothing()
          .returning({ id: cartridgeChanges.id });
        if (inserted.length === 0) {
          // The change is already recorded (a concurrent run): drop what this attempt created and count nothing.
          if (outcome === 'proposed' && proposalId !== null) await tx.delete(replenishmentProposals).where(eq(replenishmentProposals.id, proposalId));
          continue;
        }
        stats.changes++;
        stats[outcome]++;
        start = c.at;
      }
    });
  }
  return stats;
}

/**
 * The earliest black Vantage order line raised since the cartridge started that no earlier change
 * has used (order dates are London dates at midnight UTC). Lines that a consumed proposal was
 * closed by (`vantage_sales_order_line_id`) are consumed too.
 */
async function blackLineSince(db: Db, drmsId: string, vantageEquipmentId: number, start: Date, usedLines: number[]): Promise<number | null> {
  const closedByProposal = await db
    .select({ id: replenishmentProposals.vantageSalesOrderLineId })
    .from(replenishmentProposals)
    .where(and(eq(replenishmentProposals.drmsEquipmentId, drmsId), isNotNull(replenishmentProposals.vantageSalesOrderLineId)));
  const used = [...usedLines, ...closedByProposal.map((r) => r.id!)];
  const [row] = await db
    .select({ id: vantageSalesOrderLines.vantageId })
    .from(vantageSalesOrderLines)
    .innerJoin(vantageSalesOrders, eq(vantageSalesOrders.vantageId, vantageSalesOrderLines.salesOrderId))
    .where(
      and(
        eq(vantageSalesOrderLines.colour, 'black'),
        isNull(vantageSalesOrderLines.returnedDate),
        isNull(vantageSalesOrders.deletedDate),
        sql`coalesce(${vantageSalesOrderLines.vantageEquipmentId}, ${vantageSalesOrders.vantageEquipmentId}) = ${vantageEquipmentId}`,
        sql`${vantageSalesOrders.orderDate} >= ${londonDayAsUtc(start)}`,
        used.length ? notInArray(vantageSalesOrderLines.vantageId, used) : undefined,
      ),
    )
    .orderBy(asc(vantageSalesOrders.orderDate), asc(vantageSalesOrderLines.vantageId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * When a device's first recorded change's cartridge started: the last black reading at or above the
 * rise level before the change's low reading (or the Empty), looked up ignoring the counting-start
 * floor; with none, the counting start less FIRST_CARTRIDGE_LOOKBACK_DAYS.
 */
async function firstCartridgeStart(db: Db, drmsId: string, before: Date, countingStart: Date): Promise<Date> {
  const [row] = await db
    .select({ at: counterSnapshots.receivedTime })
    .from(counterValues)
    .innerJoin(counterSnapshots, eq(counterSnapshots.id, counterValues.snapshotId))
    .where(
      and(
        eq(counterSnapshots.drmsEquipmentId, drmsId),
        eq(counterValues.name, BLACK_LEVEL),
        gte(counterValues.value, RISE_LEVEL),
        lt(counterSnapshots.receivedTime, before),
      ),
    )
    .orderBy(desc(counterSnapshots.receivedTime))
    .limit(1);
  return row?.at ?? new Date(countingStart.getTime() - FIRST_CARTRIDGE_LOOKBACK_DAYS * 86_400_000);
}
