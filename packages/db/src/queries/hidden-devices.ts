import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';
import type { Db } from '../client';
import {
  auditLog,
  deviceAlerts,
  deviceLinks,
  drmsEquipment,
  hiddenDevices,
  replenishmentProposals,
  users,
  vantageEquipment,
} from '../schema';
import { deviceRowNames } from './devices';
import { drmsEquipmentName } from './shared';

/**
 * Hiding a device: the operator's way of saying "this machine is no longer ours to look after"
 * (out of contract, scrapped, moved to another dealer) without touching DRMS. A hidden device is
 * left out of the devices list and Fleet overview (rows and every headline count), Needs
 * reconnecting, Link issues and the alerts; the replenishment engine proposes nothing for it.
 * Its device page still opens, with a banner and an Unhide button.
 *
 * Every one of those places asks the same question through `notHiddenDevice`, so "is it hidden?"
 * has one answer everywhere.
 */

/** The note a hide puts on the pending proposals it withdraws, as the engine's own supersede notes read. */
export const HIDDEN_NOTE = 'device hidden';
/** `device_alerts.details.clearedReason` for an alert cleared because its device was hidden. */
export const HIDDEN_ALERT_REASON = 'device hidden';
/** Longest reason accepted; the dialog's `maxLength` matches. */
export const HIDE_REASON_MAX = 500;

export { notHiddenDevice } from './shared';

export class HideError extends Error {
  constructor(
    message: string,
    readonly code: 'no_devices' | 'reason_too_long',
  ) {
    super(message);
    this.name = 'HideError';
  }
}

export interface HideResult {
  /** Devices newly hidden by this call; ones already hidden are left as they were. */
  hidden: number;
  /** Their pending toner proposals, superseded with `HIDDEN_NOTE`. */
  superseded: number;
  /** Their open alerts, cleared with `HIDDEN_ALERT_REASON`. */
  alertsCleared: number;
}

/**
 * Hides devices, all in one transaction with one audit row. A device that is already hidden keeps
 * its original who/when/reason — a second hide is not a new decision — and is not counted.
 *
 * What hiding withdraws, so nothing is left waiting on a machine nobody will look at:
 * - its own **pending** toner proposals become `superseded` (note `device hidden`), the status the
 *   engine already uses for a proposal that no longer applies. Approved ones are already an order
 *   and are left alone, as are site stock top-ups (`shelf_id` set), which belong to the shelf.
 * - its **open alerts** are cleared, tagged `clearedReason: device hidden` the way alerts-off does.
 * The worker repeats both as a safety net (`supersedeHiddenProposals`, and `evaluateOfflineAlerts`
 * skipping hidden devices), so a proposal raised mid-hide cannot survive either.
 *
 * `userId` comes from the session, never the request.
 */
export async function hideDevices(
  db: Db,
  args: { drmsIds: string[]; userId: number; reason?: string | null; now?: Date },
): Promise<HideResult> {
  const now = args.now ?? new Date();
  const ids = [...new Set(args.drmsIds)];
  if (ids.length === 0) throw new HideError('Select at least one device to hide.', 'no_devices');
  const reason = args.reason?.trim() || null;
  if (reason && reason.length > HIDE_REASON_MAX) {
    throw new HideError(`Keep the reason to ${HIDE_REASON_MAX} characters.`, 'reason_too_long');
  }

  return db.transaction(async (tx) => {
    // Only ids that exist: the foreign key would otherwise throw on a stale or made-up id.
    const existing = await tx
      .select({ drmsId: drmsEquipment.drmsId })
      .from(drmsEquipment)
      .where(inArray(drmsEquipment.drmsId, ids));
    if (existing.length === 0) throw new HideError('None of those devices exist any more.', 'no_devices');

    const inserted = await tx
      .insert(hiddenDevices)
      .values(existing.map((e) => ({ drmsEquipmentId: e.drmsId, hiddenBy: args.userId, hiddenAt: now, reason })))
      .onConflictDoNothing()
      .returning({ drmsId: hiddenDevices.drmsEquipmentId });
    const newly = inserted.map((r) => r.drmsId);
    if (newly.length === 0) return { hidden: 0, superseded: 0, alertsCleared: 0 };

    const superseded = await supersedePending(tx as unknown as Db, newly, now);
    const cleared = await tx
      .update(deviceAlerts)
      .set({
        clearedAt: now,
        details: sql`${deviceAlerts.details} || ${JSON.stringify({ clearedReason: HIDDEN_ALERT_REASON })}::jsonb`,
      })
      .where(and(inArray(deviceAlerts.drmsEquipmentId, newly), isNull(deviceAlerts.clearedAt)))
      .returning({ id: deviceAlerts.id });

    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'device.hide',
      entity: 'device',
      entityIds: newly,
      details: { reason, supersededProposals: superseded, clearedAlerts: cleared.map((c) => c.id) },
    });
    return { hidden: newly.length, superseded: superseded.length, alertsCleared: cleared.length };
  });
}

/**
 * Unhides devices: deletes their rows, with one audit row recording who had hidden each and why,
 * since that is the only place the history survives. Nothing withdrawn on hide comes back — the
 * next replenish-evaluate and alerts runs treat the device like any other and may propose or alert
 * again. Ids that are not hidden are ignored.
 */
export async function unhideDevices(
  db: Db,
  args: { drmsIds: string[]; userId: number; now?: Date },
): Promise<{ unhidden: number }> {
  const now = args.now ?? new Date();
  const ids = [...new Set(args.drmsIds)];
  if (ids.length === 0) throw new HideError('Select at least one device to unhide.', 'no_devices');

  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(hiddenDevices)
      .where(inArray(hiddenDevices.drmsEquipmentId, ids))
      .returning({
        drmsId: hiddenDevices.drmsEquipmentId,
        hiddenBy: hiddenDevices.hiddenBy,
        hiddenAt: hiddenDevices.hiddenAt,
        reason: hiddenDevices.reason,
      });
    if (removed.length > 0) {
      await tx.insert(auditLog).values({
        at: now,
        userId: args.userId,
        action: 'device.unhide',
        entity: 'device',
        entityIds: removed.map((r) => r.drmsId),
        details: { was: removed.map((r) => ({ ...r, hiddenAt: r.hiddenAt.toISOString() })) },
      });
    }
    return { unhidden: removed.length };
  });
}

async function supersedePending(db: Db, drmsIds: string[], now: Date): Promise<number[]> {
  if (drmsIds.length === 0) return [];
  const p = replenishmentProposals;
  const rows = await db
    .update(p)
    .set({ status: 'superseded', decidedAt: now, note: HIDDEN_NOTE })
    .where(and(inArray(p.drmsEquipmentId, drmsIds), eq(p.status, 'pending'), isNull(p.shelfId)))
    .returning({ id: p.id });
  return rows.map((r) => r.id);
}

/**
 * The replenish-evaluate job's safety net: supersedes any pending (non-top-up) proposal still
 * sitting on a hidden device — one raised by a run that overlapped the hide. Returns how many.
 */
export async function supersedeHiddenProposals(db: Db, now: Date): Promise<number> {
  const hidden = await db.select({ drmsId: hiddenDevices.drmsEquipmentId }).from(hiddenDevices);
  return (await supersedePending(db, hidden.map((h) => h.drmsId), now)).length;
}

export interface HiddenInfo {
  hiddenAt: Date;
  hiddenBy: string | null;
  reason: string | null;
}

/** Who hid this device, when and why; null when it is not hidden. For the device page's banner. */
export async function getHiddenDevice(db: Db, drmsId: string): Promise<HiddenInfo | null> {
  const [row] = await db
    .select({ hiddenAt: hiddenDevices.hiddenAt, hiddenBy: users.username, reason: hiddenDevices.reason })
    .from(hiddenDevices)
    .leftJoin(users, eq(users.id, hiddenDevices.hiddenBy))
    .where(eq(hiddenDevices.drmsEquipmentId, drmsId));
  return row ?? null;
}

export interface HiddenDeviceRow extends HiddenInfo {
  drmsId: string;
  serial: string | null;
  model: string | null;
  displayName: string;
  equipmentName: string | null;
  customerName: string | null;
}

/** The devices list's *Hidden* tab: newest hide first, searchable like the other tabs. */
export async function listHiddenDevices(
  db: Db,
  o: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: HiddenDeviceRow[]; total: number }> {
  const limit = o.limit ?? 50;
  const offset = o.offset ?? 0;
  const q = o.search ? `%${o.search}%` : null;
  const where = q
    ? or(
        ilike(drmsEquipment.serial, q),
        ilike(drmsEquipment.productName, q),
        ilike(drmsEquipment.customerName, q),
        ilike(vantageEquipment.customerName, q),
      )
    : undefined;

  // Every join is at most one row per hidden device, so none can multiply rows or the count.
  const joined = <T extends PgSelect>(qb: T): T =>
    qb
      .innerJoin(drmsEquipment, eq(drmsEquipment.drmsId, hiddenDevices.drmsEquipmentId))
      .leftJoin(deviceLinks, and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)))
      .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
      .leftJoin(users, eq(users.id, hiddenDevices.hiddenBy))
      .where(where) as unknown as T;

  const [rows, [totalRow]] = await Promise.all([
    joined(
      db
        .select({
          drmsId: hiddenDevices.drmsEquipmentId,
          serial: drmsEquipment.serial,
          model: drmsEquipment.modelName,
          equipmentName: drmsEquipmentName(),
          customerName: drmsEquipment.customerName,
          vantageCustomerName: vantageEquipment.customerName,
          hiddenAt: hiddenDevices.hiddenAt,
          hiddenBy: users.username,
          reason: hiddenDevices.reason,
        })
        .from(hiddenDevices)
        .$dynamic(),
    )
      .orderBy(desc(hiddenDevices.hiddenAt), hiddenDevices.drmsEquipmentId)
      .limit(limit)
      .offset(offset),
    joined(db.select({ n: count() }).from(hiddenDevices).$dynamic()),
  ]);

  return {
    rows: rows.map((r) => ({
      drmsId: r.drmsId,
      serial: r.serial,
      model: r.model,
      ...deviceRowNames(r),
      customerName: r.vantageCustomerName ?? r.customerName,
      hiddenAt: r.hiddenAt,
      hiddenBy: r.hiddenBy,
      reason: r.reason,
    })),
    total: totalRow?.n ?? 0,
  };
}

/** How many devices are hidden, for the Hidden tab's label. */
export async function countHiddenDevices(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(hiddenDevices);
  return row?.n ?? 0;
}
