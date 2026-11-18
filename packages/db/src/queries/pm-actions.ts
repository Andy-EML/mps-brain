import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLog, pmActions, users } from '../schema';
import { londonDay, visitVerdict, type PmSettings, type Visit } from './pm-due';
import { SettingsError } from './settings';

/**
 * PM actions: a person's note on a PM-due machine, recorded in the app only (nothing goes to Vantage).
 * One open action per machine; a new one clears the old with `replaced`.
 */

export type PmActionKind = 'booked' | 'dismissed';
export type DismissReason = 'not_now' | 'declined' | 'serviced_outside' | 'other';
export type PmActionClearedReason = 'replaced' | 'undo' | 'visit_seen' | 'expired';
export type PmActionState = 'booked' | 'booked_overdue' | 'snoozed' | 'reset' | 'expired' | 'visit_seen';

export interface PmAction {
  id: number;
  vantageEquipmentId: number;
  kind: PmActionKind;
  bookedFor: Date | null;
  reference: string | null;
  reason: DismissReason | null;
  note: string | null;
  snoozeUntil: Date | null;
  servicedOn: Date | null;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: Date;
}

export const SNOOZE_DAYS = [30, 90, 180] as const;
export const DEFAULT_SNOOZE_DAYS = 90;
export const BOOKED_GRACE_DAYS = 14;
export const BOOKED_NO_DATE_DAYS = 30;
const DAY_MS = 86_400_000;
const DISMISS_REASONS: readonly string[] = ['not_now', 'declined', 'serviced_outside', 'other'];

/** UTC midnight of the date's calendar day: the shape a `date` column reads back as. */
const dayStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
/** UTC midnight of the Europe/London calendar day containing `d`. */
const londonDayStart = (d: Date): Date => new Date(`${londonDay(d)}T00:00:00Z`);

const invalid = (message: string) => new SettingsError(message, 'invalid_pm_action');

/** Pure: where an open action stands, given the machine's visits. */
export function resolvePmAction(a: PmAction, visits: Visit[], s: PmSettings, now: Date): { state: PmActionState } {
  const nowMs = now.getTime();
  if (a.kind === 'booked') {
    const seen = visits.some((v) => {
      const created = a.createdAt.getTime();
      const times = v.units.map((u) => (u.start ?? u.logged)?.getTime() ?? 0);
      if (v.at.getTime() <= created && !times.some((t) => t > created)) return false;
      const verdict = visitVerdict(v, s);
      return verdict === 'counted' || verdict === 'counted_pm' || verdict === 'counted_parts';
    });
    if (seen) return { state: 'visit_seen' };
    const due = a.bookedFor ? a.bookedFor.getTime() : a.createdAt.getTime() + BOOKED_NO_DATE_DAYS * DAY_MS;
    return { state: nowMs > due + BOOKED_GRACE_DAYS * DAY_MS ? 'booked_overdue' : 'booked' };
  }
  if (a.reason === 'serviced_outside') return { state: 'reset' };
  return { state: a.snoozeUntil && nowMs < a.snoozeUntil.getTime() ? 'snoozed' : 'expired' };
}

/** Open (not cleared) actions, keyed by Vantage equipment id. `ids` narrows to those machines. */
export async function loadOpenPmActions(db: Db, ids?: number[]): Promise<Map<number, PmAction>> {
  const out = new Map<number, PmAction>();
  if (ids && ids.length === 0) return out;
  const rows = await db
    .select({ a: pmActions, name: users.username })
    .from(pmActions)
    .leftJoin(users, eq(users.id, pmActions.createdBy))
    .where(and(isNull(pmActions.clearedAt), ids ? inArray(pmActions.vantageEquipmentId, ids) : undefined))
    .orderBy(desc(pmActions.id));
  for (const { a, name } of rows) {
    out.set(a.vantageEquipmentId, {
      id: a.id,
      vantageEquipmentId: a.vantageEquipmentId,
      kind: a.kind as PmActionKind,
      bookedFor: a.bookedFor,
      reference: a.reference,
      reason: a.reason as DismissReason | null,
      note: a.note,
      snoozeUntil: a.snoozeUntil,
      servicedOn: a.servicedOn,
      createdBy: a.createdBy,
      createdByName: name,
      createdAt: a.createdAt,
    });
  }
  return out;
}

/**
 * The latest "Serviced outside Vantage" date per machine, from every such action that was not
 * undone (open, replaced by a later action, or cleared by a visit). Only an explicit Undo removes a
 * reset, so booking or dismissing again does not lose it.
 */
export async function loadManualResets(db: Db, ids: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: pmActions.vantageEquipmentId, servicedOn: pmActions.servicedOn })
    .from(pmActions)
    .where(
      and(
        inArray(pmActions.vantageEquipmentId, ids),
        eq(pmActions.kind, 'dismissed'),
        eq(pmActions.reason, 'serviced_outside'),
        or(isNull(pmActions.clearedReason), ne(pmActions.clearedReason, 'undo')),
      ),
    );
  for (const r of rows) {
    if (!r.servicedOn) continue;
    const cur = out.get(r.id);
    if (!cur || r.servicedOn.getTime() > cur.getTime()) out.set(r.id, r.servicedOn);
  }
  return out;
}

/** Clear open actions by id (used when a visit was seen or a snooze ran out). */
export async function clearPmActions(db: Db, clears: { id: number; reason: PmActionClearedReason }[], now: Date): Promise<void> {
  for (const c of clears) {
    await db
      .update(pmActions)
      .set({ clearedAt: now, clearedReason: c.reason })
      .where(and(eq(pmActions.id, c.id), isNull(pmActions.clearedAt)));
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function replaceOpen(tx: Tx, vantageEquipmentId: number, now: Date): Promise<void> {
  await tx
    .update(pmActions)
    .set({ clearedAt: now, clearedReason: 'replaced' })
    .where(and(eq(pmActions.vantageEquipmentId, vantageEquipmentId), isNull(pmActions.clearedAt)));
}

export async function markPmBooked(
  db: Db,
  args: { vantageEquipmentId: number; bookedFor: Date | null; reference: string | null; userId: number | null; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const reference = args.reference?.trim() || null;
  const bookedFor = args.bookedFor ? dayStart(args.bookedFor) : null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${args.vantageEquipmentId})`);
    await replaceOpen(tx, args.vantageEquipmentId, now);
    await tx.insert(pmActions).values({
      vantageEquipmentId: args.vantageEquipmentId,
      kind: 'booked',
      bookedFor,
      reference,
      createdBy: args.userId,
      createdAt: now,
    });
    if (args.userId !== null) {
      await tx.insert(auditLog).values({
        userId: args.userId,
        action: 'pm_action.booked',
        entity: 'pm_action',
        entityIds: [args.vantageEquipmentId],
        details: { bookedFor: bookedFor?.toISOString().slice(0, 10) ?? null, reference },
      });
    }
  });
}

export async function dismissPm(
  db: Db,
  args: {
    vantageEquipmentId: number;
    reason: DismissReason;
    note: string | null;
    snoozeDays?: number;
    servicedOn: Date | null;
    userId: number | null;
    now?: Date;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  if (!DISMISS_REASONS.includes(args.reason)) throw invalid('Pick a reason for dismissing this machine.');
  const note = args.note?.trim() || null;
  if (args.reason === 'other' && !note) throw invalid('Add a note when the reason is Other.');

  let snoozeUntil: Date | null = null;
  let servicedOn: Date | null = null;
  if (args.reason === 'serviced_outside') {
    servicedOn = args.servicedOn ? dayStart(args.servicedOn) : londonDayStart(now);
    if (servicedOn.getTime() > londonDayStart(now).getTime()) throw invalid('The service date cannot be in the future.');
  } else {
    const days = args.snoozeDays ?? DEFAULT_SNOOZE_DAYS;
    if (!(SNOOZE_DAYS as readonly number[]).includes(days)) throw invalid('Snooze for 30, 90 or 180 days.');
    snoozeUntil = new Date(londonDayStart(now).getTime() + days * DAY_MS);
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${args.vantageEquipmentId})`);
    await replaceOpen(tx, args.vantageEquipmentId, now);
    await tx.insert(pmActions).values({
      vantageEquipmentId: args.vantageEquipmentId,
      kind: 'dismissed',
      reason: args.reason,
      note,
      snoozeUntil,
      servicedOn,
      createdBy: args.userId,
      createdAt: now,
    });
    if (args.userId !== null) {
      await tx.insert(auditLog).values({
        userId: args.userId,
        action: 'pm_action.dismissed',
        entity: 'pm_action',
        entityIds: [args.vantageEquipmentId],
        details: {
          reason: args.reason,
          note,
          snoozeUntil: snoozeUntil?.toISOString().slice(0, 10) ?? null,
          servicedOn: servicedOn?.toISOString().slice(0, 10) ?? null,
        },
      });
    }
  });
}

/** Clears an open action with reason `undo`. Returns false when it was not open (already cleared or unknown). */
export async function undoPmAction(db: Db, actionId: number, userId: number | null, now: Date = new Date()): Promise<boolean> {
  const cleared = await db
    .update(pmActions)
    .set({ clearedAt: now, clearedReason: 'undo' })
    .where(and(eq(pmActions.id, actionId), isNull(pmActions.clearedAt)))
    .returning({ vantageEquipmentId: pmActions.vantageEquipmentId });
  if (cleared.length === 0) return false;
  if (userId !== null) {
    await db.insert(auditLog).values({
      userId,
      action: 'pm_action.undo',
      entity: 'pm_action',
      entityIds: [cleared[0]!.vantageEquipmentId],
      details: { actionId },
    });
  }
  return true;
}
