import {
  ALARM_WINDOW_DAYS,
  READY_FOR_ERP,
  REJECTED_SUPPRESS_DAYS,
  TONER_COLOURS,
  evaluateDevice,
  isRecovered,
  type ColourHistory,
  type ConsumableAlarm,
  type ReplenishColour,
  type TonerColour,
} from '@mps/core';
import { deviceAlarms, drmsEquipment, replenishmentProposals, type Db } from '@mps/db';
import { counterPivotSubquery, effectiveSettingsSubquery, getOrderStates, type ColourOrderState } from '@mps/db/queries';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';
import { evaluateSiteStock } from './site-stock-evaluate';

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

function londonDayAsUtc(at: Date): Date {
  // en-CA formats as YYYY-MM-DD.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Date(`${day}T00:00:00Z`);
}

export interface ReplenishEvaluateDeps {
  db: Db;
  now?: () => Date;
}

/**
 * Runs the engine over every monitored device and persists the result. Proposes only — nothing
 * here talks to Vantage. Safe to run any number of times: the live-proposal unique index and the
 * engine's `live_proposal` suppression both stop duplicates.
 */
export async function runReplenishEvaluate(deps: ReplenishEvaluateDeps): Promise<JobResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  // Site stock first: it raises shelf top-ups and says which colours a shelf now covers.
  const siteStock = await evaluateSiteStock(db, now);
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
    .where(and(sql`upper(${drmsEquipment.status}) in ('REGISTERED', 'DISCOVERED')`, isNull(drmsEquipment.missingSince)));

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

  const linkedIds = [...new Set(devices.map((d) => d.vantageEquipmentId).filter((id): id is number => id !== null))];
  const orderStates = await getOrderStates(db, linkedIds, now);

  const stats = { devices: devices.length, proposed: 0, superseded: 0, suppressed: 0, autoOff: 0, unlinked: 0, siteStockShelves: siteStock.stats.shelves, siteStockConsidered: siteStock.stats.considered, siteStockCounted: siteStock.stats.counted, siteStockTopUps: siteStock.stats.topUps };

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
      if (p.status !== 'pending' || p.shelfId !== null) continue;
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

  return { status: 'success', stats };
}
