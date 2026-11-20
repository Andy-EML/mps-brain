import {
  ALARM_WINDOW_DAYS,
  READY_FOR_ERP,
  REJECTED_SUPPRESS_DAYS,
  TONER_COLOURS,
  errorMessage,
  evaluateDevice,
  isRecovered,
  type ColourHistory,
  type ConsumableAlarm,
  type ReplenishColour,
  type TonerColour,
} from '@mps/core';
import { cartridgeChanges, deviceAlarms, drmsEquipment, replenishmentProposals, type Db } from '@mps/db';
import {
  computeHolds,
  counterPivotSubquery,
  effectiveSettingsSubquery,
  getOrderStates,
  londonDayAsUtc,
  notHiddenDevice,
  supersedeHiddenProposals,
  type ColourOrderState,
  type HoldCandidate,
} from '@mps/db/queries';
import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';
import { evaluateSiteStock } from './site-stock-evaluate';
import { evaluateSpareBlack } from './spare-black';

/**
 * The Vantage order that makes a pending proposal redundant, as its reference (`'SO…'`), or null.
 * Someone raised it by hand in Vantage: an open order dated on or after the day the proposal was
 * made, or any order completed after it was made. Vantage order dates are date-only and arrive as
 * midnight UTC of the London calendar date, so the proposal's London day is compared the same way.
 * Our own in-flight orders (`source: 'mps'`) never count — they come from an approved proposal.
 */
export function orderedInVantage(state: ColourOrderState, proposalCreatedAt: Date): string | null {
  const open = state.open;
  if (open?.source === 'vantage' && open.orderDate && open.orderDate >= londonDayAsUtc(proposalCreatedAt)) {
    return open.reference ?? 'no reference';
  }
  if (state.lastCompletedAt && state.lastCompletedAt > proposalCreatedAt) return state.lastCompletedReference ?? 'no reference';
  return null;
}

export interface ReplenishEvaluateDeps {
  db: Db;
  now?: () => Date;
}

/**
 * Runs the engine over every monitored device and persists the result. Proposes only — nothing
 * here talks to Vantage. Safe to run any number of times: the live-proposal unique index and the
 * engine's `live_proposal` suppression both stop duplicates.
 *
 * Hidden devices (`hidden_devices`) are not evaluated at all, so they get no proposals; any pending
 * one still on them (raised by a run that overlapped the hide) is superseded first. Site stock is
 * left as it is: a hidden device's Empty alarms still count against its shelf, and a top-up it
 * raised is the shelf's, not the device's.
 */
export async function runReplenishEvaluate(deps: ReplenishEvaluateDeps): Promise<JobResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  // Site stock first: it raises shelf top-ups and says which colours a shelf now covers.
  const siteStock = await evaluateSiteStock(db, now);
  const hiddenSuperseded = await supersedeHiddenProposals(db, now);
  const eff = effectiveSettingsSubquery(db);
  const pivot = counterPivotSubquery(db);

  const devices = await db
    .select({
      drmsId: drmsEquipment.drmsId,
      isColour: drmsEquipment.isColour,
      vantageEquipmentId: eff.vantageEquipmentId,
      autoReplenish: eff.autoReplenish,
      tBlack: eff.thresholdBlack,
      tCyan: eff.thresholdCyan,
      tMagenta: eff.thresholdMagenta,
      tYellow: eff.thresholdYellow,
      black: pivot.black,
      cyan: pivot.cyan,
      magenta: pivot.magenta,
      yellow: pivot.yellow,
    })
    .from(drmsEquipment)
    .innerJoin(eff, eq(eff.drmsId, drmsEquipment.drmsId))
    .leftJoin(pivot, eq(pivot.drmsId, drmsEquipment.drmsId))
    .where(
      and(
        sql`upper(${drmsEquipment.status}) in ('REGISTERED', 'DISCOVERED')`,
        isNull(drmsEquipment.missingSince),
        notHiddenDevice(drmsEquipment.drmsId),
      ),
    );

  const since = new Date(now.getTime() - ALARM_WINDOW_DAYS * 86_400_000);
  const alarmRows = await db
    .select({
      drmsId: deviceAlarms.drmsEquipmentId,
      alarmId: deviceAlarms.alarmId,
      receivedAt: deviceAlarms.receivedTime,
      category: deviceAlarms.category,
      status: deviceAlarms.status,
      description: deviceAlarms.description,
      fcCode: deviceAlarms.fcCode,
    })
    .from(deviceAlarms)
    .where(and(gte(deviceAlarms.receivedTime, since), eq(deviceAlarms.status, READY_FOR_ERP), inArray(deviceAlarms.category, ['toner', 'waste'])));
  const alarmsByDevice = new Map<string, ConsumableAlarm[]>();
  for (const { drmsId, ...a } of alarmRows) alarmsByDevice.set(drmsId, [...(alarmsByDevice.get(drmsId) ?? []), a]);

  const rejectedSince = new Date(now.getTime() - REJECTED_SUPPRESS_DAYS * 86_400_000);
  const proposalRows = await db
    .select({
      id: replenishmentProposals.id,
      drmsId: replenishmentProposals.drmsEquipmentId,
      colour: replenishmentProposals.colour,
      status: replenishmentProposals.status,
      trigger: replenishmentProposals.trigger,
      decidedAt: replenishmentProposals.decidedAt,
      createdAt: replenishmentProposals.createdAt,
      shelfId: replenishmentProposals.shelfId,
    })
    .from(replenishmentProposals)
    .where(
      // Shelf top-ups belong to the site-stock job: the device loop never supersedes them and their
      // rejections are not the device's, but a live one still counts as live for its device + colour.
      sql`${replenishmentProposals.status} in ('pending', 'approved') or (${replenishmentProposals.shelfId} is null and ${replenishmentProposals.status} = 'rejected' and ${replenishmentProposals.decidedAt} >= ${rejectedSince})`,
    );

  // A proposal a recorded cartridge change relies on (as its cover) is never auto-cleared here, or the
  // spare it stands for would never be ordered.
  const coverRows = await db.select({ id: cartridgeChanges.proposalId }).from(cartridgeChanges).where(isNotNull(cartridgeChanges.proposalId));
  const coversChange = new Set(coverRows.map((r) => r.id!));

  const linkedIds = [...new Set(devices.map((d) => d.vantageEquipmentId).filter((id): id is number => id !== null))];
  const orderStates = await getOrderStates(db, linkedIds, now);

  const stats = { devices: devices.length, proposed: 0, superseded: hiddenSuperseded, suppressed: 0, autoOff: 0, unlinked: 0, siteStockShelves: siteStock.stats.shelves, siteStockConsidered: siteStock.stats.considered, siteStockCounted: siteStock.stats.counted, siteStockTopUps: siteStock.stats.topUps };

  for (const d of devices) {
    const thresholds: Record<TonerColour, number> = { black: Number(d.tBlack), cyan: Number(d.tCyan), magenta: Number(d.tMagenta), yellow: Number(d.tYellow) };
    const levels: Record<TonerColour, number | null> = {
      black: d.black === null ? null : Number(d.black),
      cyan: d.cyan === null ? null : Number(d.cyan),
      magenta: d.magenta === null ? null : Number(d.magenta),
      yellow: d.yellow === null ? null : Number(d.yellow),
    };
    const coveredColours = siteStock.covered.get(d.drmsId) ?? new Set<ReplenishColour>();
    const mine = proposalRows.filter((p) => p.drmsId === d.drmsId);
    const states = d.vantageEquipmentId === null ? undefined : orderStates.get(d.vantageEquipmentId);

    // Supersede first, so a recovered channel does not count as "live" below, and so this
    // device's insert (below) never conflicts with a still-pending row it just replaced —
    // otherwise a same-run alarm proposal for the recovered colour would be silently dropped.
    const toSupersede: { id: number; note: string }[] = [];
    for (const p of mine) {
      if (p.status !== 'pending' || p.shelfId !== null || coversChange.has(p.id)) continue;
      const ordered = states ? orderedInVantage(states[p.colour], p.createdAt) : null;
      if (ordered !== null) toSupersede.push({ id: p.id, note: `ordered in Vantage (${ordered})` });
      else if (coveredColours.has(p.colour)) toSupersede.push({ id: p.id, note: 'covered by site stock' });
      else if (!d.autoReplenish) toSupersede.push({ id: p.id, note: 'auto-replenish switched off' });
      else if (p.trigger === 'threshold' && p.colour !== 'waste' && isRecovered(levels[p.colour], thresholds[p.colour])) {
        toSupersede.push({ id: p.id, note: 'level recovered' });
      }
    }
    const superseded = new Set(toSupersede.map((s) => s.id));
    for (const s of toSupersede) {
      const updated = await db
        .update(replenishmentProposals)
        .set({ status: 'superseded', decidedAt: now, note: s.note })
        .where(and(eq(replenishmentProposals.id, s.id), eq(replenishmentProposals.status, 'pending')))
        .returning({ id: replenishmentProposals.id });
      stats.superseded += updated.length;
    }

    const history: Partial<Record<ReplenishColour, ColourHistory>> = {};
    for (const colour of ['black', 'cyan', 'magenta', 'yellow', 'waste'] as const) {
      const live = mine.some((p) => p.colour === colour && (p.status === 'pending' || p.status === 'approved') && !superseded.has(p.id));
      const rejected = mine
        .filter((p) => p.colour === colour && p.status === 'rejected' && p.decidedAt)
        .map((p) => p.decidedAt!)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      history[colour] = {
        liveProposal: live,
        hasOpenOrder: states?.[colour].open != null,
        lastCompletedAt: states?.[colour].lastCompletedAt ?? null,
        lastRejectedAt: rejected ?? null,
      };
    }

    const result = evaluateDevice({
      vantageEquipmentId: d.vantageEquipmentId,
      isColour: d.isColour,
      autoReplenish: Boolean(d.autoReplenish),
      thresholds,
      levels,
      alarms: alarmsByDevice.get(d.drmsId) ?? [],
      history,
      siteStockCovered: [...coveredColours],
      now,
    });
    if (result.skipped === 'auto_off') stats.autoOff++;
    if (result.skipped === 'unlinked' && result.candidates.length === 0) {
      // Only count devices that would otherwise have had something to order.
      if (TONER_COLOURS.some((c) => levels[c] !== null && levels[c]! < thresholds[c]) || alarmsByDevice.has(d.drmsId)) stats.unlinked++;
    }
    stats.suppressed += result.suppressed.length;

    if (result.candidates.length > 0) {
      const inserted = await db
        .insert(replenishmentProposals)
        .values(
          result.candidates.map((c) => ({
            drmsEquipmentId: d.drmsId,
            vantageEquipmentId: d.vantageEquipmentId,
            colour: c.colour,
            trigger: c.trigger,
            level: c.level,
            threshold: c.threshold,
            alarmId: c.alarmId,
            alarmDescription: c.alarmDescription,
            status: 'pending' as const,
            createdAt: now,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: replenishmentProposals.id });
      stats.proposed += inserted.length;
    }
  }

  // After the device loop, so a threshold proposal raised just now already counts as covering the spare.
  const spare = await evaluateSpareBlack(db, now, siteStock.covered);
  Object.assign(stats, { spareChanges: spare.changes, spareProposed: spare.proposed, spareCovered: spare.covered, spareIneligible: spare.ineligible });

  // Holds are advisory: a failure here must not fail the run, or no proposals would be raised at all.
  try {
    Object.assign(stats, await applyHolds(db, now));
  } catch (err) {
    Object.assign(stats, { holdError: errorMessage(err) });
    console.error('[replenish-evaluate] holds failed; clearing holds so pending proposals fall back to Review', err);
    // Stale holds would keep rows hidden from Review indefinitely, so fail open. Its own try/catch: the run still succeeds.
    try {
      await db
        .update(replenishmentProposals)
        .set({ holdReason: null, holdDetail: null })
        .where(and(eq(replenishmentProposals.status, 'pending'), or(isNotNull(replenishmentProposals.holdReason), isNotNull(replenishmentProposals.holdDetail))));
    } catch (clearErr) {
      console.error('[replenish-evaluate] clearing holds failed', clearErr);
    }
  }

  return { status: 'success', stats };
}

/**
 * Writes (or clears) the hold on pending toner proposals whose last cartridge was probably never
 * fitted. Runs last, so a threshold proposal that has just become a spare-black cover counts as a
 * cover. The candidate set is pending, non-shelf, threshold/alarm, non-waste and not a cover; a pending
 * proposal outside it that still carries a hold gets both columns cleared. Only changed rows are written,
 * each guarded by `status = 'pending'` so an approval or supersede racing this run is never overwritten.
 */
async function applyHolds(db: Db, now: Date): Promise<{ held: number; holdSet: number; holdCleared: number }> {
  const rows = await db
    .select({
      id: replenishmentProposals.id,
      drmsId: replenishmentProposals.drmsEquipmentId,
      colour: replenishmentProposals.colour,
      trigger: replenishmentProposals.trigger,
      shelfId: replenishmentProposals.shelfId,
      holdReason: replenishmentProposals.holdReason,
      holdDetail: replenishmentProposals.holdDetail,
    })
    .from(replenishmentProposals)
    .where(eq(replenishmentProposals.status, 'pending'));
  const coverRows = await db.select({ id: cartridgeChanges.proposalId }).from(cartridgeChanges).where(isNotNull(cartridgeChanges.proposalId));
  const covers = new Set(coverRows.map((r) => r.id!));

  const candidates: HoldCandidate[] = [];
  const stale: number[] = [];
  for (const r of rows) {
    const inSet = r.shelfId === null && (r.trigger === 'threshold' || r.trigger === 'alarm') && r.colour !== 'waste' && !covers.has(r.id);
    if (inSet) candidates.push({ id: r.id, drmsEquipmentId: r.drmsId, colour: r.colour as HoldCandidate['colour'] });
    else if (r.holdReason !== null || r.holdDetail !== null) stale.push(r.id);
  }

  let held = 0;
  let holdSet = 0;
  let holdCleared = 0;
  const write = async (id: number, reason: 'not_fitted' | 'low_yield' | null, detail: string | null) => {
    const updated = await db
      .update(replenishmentProposals)
      .set({ holdReason: reason, holdDetail: detail })
      .where(and(eq(replenishmentProposals.id, id), eq(replenishmentProposals.status, 'pending')))
      .returning({ id: replenishmentProposals.id });
    return updated.length > 0;
  };

  for (const id of stale) if (await write(id, null, null)) holdCleared++;

  const decisions = await computeHolds(db, candidates, now);
  const stored = new Map(rows.map((r) => [r.id, r]));
  for (const c of candidates) {
    const d = decisions.get(c.id) ?? null;
    const cur = stored.get(c.id)!;
    if (d) held++;
    const reason = d?.reason ?? null;
    const detail = d?.detail ?? null;
    if (cur.holdReason === reason && cur.holdDetail === detail) continue;
    if (!(await write(c.id, reason, detail))) {
      if (d) held--;
      continue;
    }
    if (d) holdSet++;
    else holdCleared++;
  }
  return { held, holdSet, holdCleared };
}
