import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { pmPlan } from '../schema';
import { audit } from './site-stock-actions';

/**
 * Per-machine PM planner state (`pm_plan`): the *When in area* and *Priority* flags and the board
 * column the office has put the machine in. Recorded in the app only; nothing goes to Vantage.
 * Booked is never stored here (it is derived from `pm_actions` / the Vantage PM job), so the stored
 * column is `to_plan`, `asked`, `done` or null (not on the board). A row left with no flag and no
 * column is deleted. Every write is one `audit_log` row (entity `pm_plan`).
 */

export type BoardColumnStored = 'to_plan' | 'asked' | 'done';

export interface PmPlanRow {
  vantageEquipmentId: number;
  whenInArea: boolean;
  priority: boolean;
  boardColumn: BoardColumnStored | null;
  boardNote: string | null;
  addedAt: Date | null;
  askedAt: Date | null;
  doneAt: Date | null;
  doneReason: 'visit' | 'manual' | null;
  updatedAt: Date;
}

const COLUMNS: readonly string[] = ['to_plan', 'asked', 'done'] satisfies BoardColumnStored[];

function toRow(r: typeof pmPlan.$inferSelect): PmPlanRow {
  return {
    vantageEquipmentId: r.vantageEquipmentId,
    whenInArea: r.whenInArea,
    priority: r.priority,
    boardColumn: COLUMNS.includes(r.boardColumn ?? '') ? (r.boardColumn as BoardColumnStored) : null,
    boardNote: r.boardNote,
    addedAt: r.addedAt,
    askedAt: r.askedAt,
    doneAt: r.doneAt,
    doneReason: r.doneReason === 'visit' || r.doneReason === 'manual' ? r.doneReason : null,
    updatedAt: r.updatedAt,
  };
}

/** Plan rows by Vantage equipment id; every row when `ids` is omitted, none for an empty list. */
export async function loadPlanRows(db: Db, ids?: number[]): Promise<Map<number, PmPlanRow>> {
  if (ids !== undefined && ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(pmPlan)
    .where(ids === undefined ? undefined : inArray(pmPlan.vantageEquipmentId, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.vantageEquipmentId, toRow(r)]));
}

/** Fields that put a machine on To plan afresh (a done card's history is dropped). */
const freshToPlan = (now: Date) => ({ boardColumn: 'to_plan', addedAt: now, askedAt: null, doneAt: null, doneReason: null }) as const;

/** Deletes the row when nothing is left on it: no flag and not on the board. */
async function dropIfEmpty(t: Db, id: number): Promise<void> {
  await t
    .delete(pmPlan)
    .where(and(eq(pmPlan.vantageEquipmentId, id), eq(pmPlan.whenInArea, false), eq(pmPlan.priority, false), isNull(pmPlan.boardColumn)));
}

async function inTx(db: Db, work: (t: Db) => Promise<void>): Promise<void> {
  await db.transaction(async (tx) => work(tx as unknown as Db));
}

/**
 * Turns *When in area* on or off. The board column is left alone, and so is `updated_at` on an
 * existing row: the booking-lapse sync reads it as "card last moved", which a flag toggle is not.
 */
export async function setWhenInArea(db: Db, a: { vantageEquipmentId: number; on: boolean; userId: number; now?: Date }): Promise<void> {
  const now = a.now ?? new Date();
  await inTx(db, async (t) => {
    await t
      .insert(pmPlan)
      .values({ vantageEquipmentId: a.vantageEquipmentId, whenInArea: a.on, updatedBy: a.userId, updatedAt: now })
      .onConflictDoUpdate({ target: pmPlan.vantageEquipmentId, set: { whenInArea: a.on, updatedBy: a.userId } });
    if (!a.on) await dropIfEmpty(t, a.vantageEquipmentId);
    await audit(t, { userId: a.userId, action: 'pm_plan.when_in_area', entity: 'pm_plan', ids: [a.vantageEquipmentId], details: { on: a.on }, now });
  });
}

/**
 * Turns *Priority* on or off. On puts the machine on the board (To plan) when it is not on it or is
 * in Done; a card already on To plan / Asked stays put. Off leaves the card where it is.
 * `updated_at` is stamped only on insert or when the column changes (see `setWhenInArea`).
 */
export async function setPriority(db: Db, a: { vantageEquipmentId: number; on: boolean; userId: number; now?: Date }): Promise<void> {
  const now = a.now ?? new Date();
  await inTx(db, async (t) => {
    const [cur] = await t.select().from(pmPlan).where(eq(pmPlan.vantageEquipmentId, a.vantageEquipmentId));
    const addToBoard = a.on && (cur === undefined || cur.boardColumn === null || cur.boardColumn === 'done');
    const set = { priority: a.on, updatedBy: a.userId, ...(addToBoard ? { ...freshToPlan(now), updatedAt: now } : {}) };
    await t
      .insert(pmPlan)
      .values({ vantageEquipmentId: a.vantageEquipmentId, ...set, updatedAt: now })
      .onConflictDoUpdate({ target: pmPlan.vantageEquipmentId, set });
    if (!a.on) await dropIfEmpty(t, a.vantageEquipmentId);
    await audit(t, { userId: a.userId, action: 'pm_plan.priority', entity: 'pm_plan', ids: [a.vantageEquipmentId], details: { on: a.on }, now });
  });
}

/**
 * Puts machines on the board's To plan column. A machine not on the board, or in Done, starts afresh
 * (added now, done fields cleared); one already on To plan or Asked is left untouched.
 */
export async function addToPlan(db: Db, a: { vantageEquipmentIds: number[]; userId: number; now?: Date }): Promise<void> {
  const now = a.now ?? new Date();
  const ids = [...new Set(a.vantageEquipmentIds)];
  if (ids.length === 0) return;
  const fresh = { ...freshToPlan(now), updatedBy: a.userId, updatedAt: now };
  await inTx(db, async (t) => {
    await t
      .insert(pmPlan)
      .values(ids.map((id) => ({ vantageEquipmentId: id, ...fresh })))
      .onConflictDoUpdate({
        target: pmPlan.vantageEquipmentId,
        set: fresh,
        setWhere: sql`${pmPlan.boardColumn} is null or ${pmPlan.boardColumn} = 'done'`,
      });
    await audit(t, { userId: a.userId, action: 'pm_plan.add', entity: 'pm_plan', ids, details: {}, now });
  });
}

/** The longest card note (the note form's cap). */
export const BOARD_NOTE_MAX = 500;
/** Between an existing note and an appended line. */
const NOTE_SEPARATOR = '\n';

/**
 * Moves a card to a stored column (a machine not yet on the board is added, and a card taken out of
 * Done to To plan / Asked counts as added now, so a visit from before the move cannot pull it back
 * into Done). Asked stamps `askedAt`;
 * Done stamps `doneAt` with reason `manual`; To plan clears both. `note` replaces the card's note
 * when given (null clears it) and is left alone when omitted. `appendNote` (used instead of `note`)
 * adds a line under the existing note in the same statement, so a typed note (key code, access) is
 * never lost: the appended line is cut to fit `BOARD_NOTE_MAX`, never the existing text, and is left
 * off entirely when the existing note leaves no room.
 */
export async function moveCard(
  db: Db,
  a: { vantageEquipmentId: number; to: BoardColumnStored; note?: string | null; appendNote?: string; userId: number; now?: Date },
): Promise<void> {
  const now = a.now ?? new Date();
  const note = a.note === undefined ? undefined : a.note?.trim() || null;
  const append = a.appendNote?.trim() || null;
  if (note !== undefined && append !== null) throw new Error('moveCard: pass note or appendNote, not both');
  await inTx(db, async (t) => {
    const [cur] = await t.select().from(pmPlan).where(eq(pmPlan.vantageEquipmentId, a.vantageEquipmentId));
    const onBoard = cur !== undefined && cur.boardColumn !== null;
    const outOfDone = cur?.boardColumn === 'done' && a.to !== 'done';
    const set = {
      boardColumn: a.to,
      addedAt: onBoard && !outOfDone ? cur.addedAt : now,
      askedAt: a.to === 'asked' ? (cur?.boardColumn === 'asked' ? cur.askedAt : now) : a.to === 'done' ? (cur?.askedAt ?? null) : null,
      doneAt: a.to === 'done' ? now : null,
      doneReason: a.to === 'done' ? ('manual' as const) : null,
      ...(note === undefined ? {} : { boardNote: note }),
      updatedBy: a.userId,
      updatedAt: now,
    };
    const existing = sql`${pmPlan.boardNote}`;
    const room = sql`${BOARD_NOTE_MAX} - char_length(${existing}) - ${NOTE_SEPARATOR.length}`;
    const appended =
      append === null
        ? {}
        : {
            boardNote: sql<string>`case
              when coalesce(${existing}, '') = '' then ${append.slice(0, BOARD_NOTE_MAX)}
              when ${room} <= 0 then ${existing}
              else ${existing} || ${NOTE_SEPARATOR} || left(${append}, ${room})
            end`,
          };
    await t
      .insert(pmPlan)
      .values({ vantageEquipmentId: a.vantageEquipmentId, ...set, ...(append === null ? {} : { boardNote: append.slice(0, BOARD_NOTE_MAX) }) })
      .onConflictDoUpdate({ target: pmPlan.vantageEquipmentId, set: { ...set, ...appended } });
    await audit(t, {
      userId: a.userId,
      action: 'pm_plan.move',
      entity: 'pm_plan',
      ids: [a.vantageEquipmentId],
      details: append === null ? { to: a.to, note: note ?? null } : { to: a.to, appendNote: append },
      now,
    });
  });
}

/** Takes a card off the board. The flags stay; a row with no flag left is deleted. */
export async function removeFromPlan(db: Db, a: { vantageEquipmentId: number; userId: number; now?: Date }): Promise<void> {
  const now = a.now ?? new Date();
  await inTx(db, async (t) => {
    await t
      .update(pmPlan)
      .set({ boardColumn: null, boardNote: null, addedAt: null, askedAt: null, doneAt: null, doneReason: null, updatedBy: a.userId, updatedAt: now })
      .where(eq(pmPlan.vantageEquipmentId, a.vantageEquipmentId));
    await dropIfEmpty(t, a.vantageEquipmentId);
    await audit(t, { userId: a.userId, action: 'pm_plan.remove', entity: 'pm_plan', ids: [a.vantageEquipmentId], details: {}, now });
  });
}

/**
 * Board sync (system write, no user): cards on To plan / Asked whose machine has had a qualifying
 * visit since they were added move to Done with reason `visit`. Returns the ids moved; one
 * `audit_log` row (user null) when any moved.
 */
export async function markDoneByVisit(db: Db, ids: number[], now: Date = new Date()): Promise<number[]> {
  const want = [...new Set(ids)];
  if (want.length === 0) return [];
  let moved: number[] = [];
  await inTx(db, async (t) => {
    const rows = await t
      .update(pmPlan)
      .set({ boardColumn: 'done', doneAt: now, doneReason: 'visit', updatedAt: now })
      .where(and(inArray(pmPlan.vantageEquipmentId, want), inArray(pmPlan.boardColumn, ['to_plan', 'asked'])))
      .returning({ id: pmPlan.vantageEquipmentId });
    moved = rows.map((r) => r.id);
    if (moved.length > 0) await audit(t, { userId: null, action: 'pm_plan.auto_done', entity: 'pm_plan', ids: moved, details: { reason: 'visit' }, now });
  });
  return moved;
}

/**
 * Board sync (system write, no user): a Priority card that sat in Done past the retention (done
 * before `cutoff`) and whose machine is due again goes back on To plan, added now. `doneAt` /
 * `doneReason` are kept on the To plan row as the "Due again" marker (any move or re-add clears
 * them). Callers pass only the ids of priority machines that are due again. Returns the ids reset.
 */
export async function resetStaleDone(db: Db, ids: number[], cutoff: Date, now: Date = new Date()): Promise<number[]> {
  const want = [...new Set(ids)];
  if (want.length === 0) return [];
  let reset: number[] = [];
  await inTx(db, async (t) => {
    const rows = await t
      .update(pmPlan)
      .set({ boardColumn: 'to_plan', addedAt: now, askedAt: null, updatedAt: now })
      .where(and(inArray(pmPlan.vantageEquipmentId, want), eq(pmPlan.boardColumn, 'done'), eq(pmPlan.priority, true), lt(pmPlan.doneAt, cutoff)))
      .returning({ id: pmPlan.vantageEquipmentId });
    reset = rows.map((r) => r.id);
    if (reset.length > 0) await audit(t, { userId: null, action: 'pm_plan.auto_reset', entity: 'pm_plan', ids: reset, details: { reason: 'due_again' }, now });
  });
  return reset;
}

/**
 * Board sync (system write, no user): a non-priority card that sat in Done past the retention (done
 * before `cutoff`) drops off the board: the board fields are cleared, the When-in-area flag stays
 * and a row left with no flag is deleted. It is not put back on To plan when the machine is due
 * again; the office adds it again from PM due. Returns the ids dropped.
 */
export async function dropExpiredDone(db: Db, ids: number[], cutoff: Date, now: Date = new Date()): Promise<number[]> {
  const want = [...new Set(ids)];
  if (want.length === 0) return [];
  let dropped: number[] = [];
  await inTx(db, async (t) => {
    const rows = await t
      .update(pmPlan)
      .set({ boardColumn: null, boardNote: null, addedAt: null, askedAt: null, doneAt: null, doneReason: null, updatedAt: now })
      .where(and(inArray(pmPlan.vantageEquipmentId, want), eq(pmPlan.boardColumn, 'done'), eq(pmPlan.priority, false), lt(pmPlan.doneAt, cutoff)))
      .returning({ id: pmPlan.vantageEquipmentId });
    dropped = rows.map((r) => r.id);
    for (const id of dropped) await dropIfEmpty(t, id);
    if (dropped.length > 0) await audit(t, { userId: null, action: 'pm_plan.auto_drop', entity: 'pm_plan', ids: dropped, details: { reason: 'done_retention' }, now });
  });
  return dropped;
}

/**
 * Board sync (system write, no user): a card on To plan / Asked whose open booking lapsed (no visit
 * seen) drops to To plan, once per lapse. The card's `updated_at` is stamped with the booking's
 * expiry, which marks "not moved since the lapse": any later move stamps a later time, so the sync
 * (which only touches cards with `updated_at` before the expiry) never repeats or overrides it.
 * Returns the ids changed; one `audit_log` row (user null) when any changed.
 */
export async function markLapsed(db: Db, items: { id: number; expiry: Date }[], now: Date = new Date()): Promise<number[]> {
  if (items.length === 0) return [];
  const changed: number[] = [];
  await inTx(db, async (t) => {
    for (const { id, expiry } of items) {
      const rows = await t
        .update(pmPlan)
        .set({ boardColumn: 'to_plan', askedAt: null, updatedAt: expiry })
        .where(and(eq(pmPlan.vantageEquipmentId, id), inArray(pmPlan.boardColumn, ['to_plan', 'asked']), lt(pmPlan.updatedAt, expiry)))
        .returning({ id: pmPlan.vantageEquipmentId });
      changed.push(...rows.map((r) => r.id));
    }
    if (changed.length > 0) await audit(t, { userId: null, action: 'pm_plan.auto_lapse', entity: 'pm_plan', ids: changed, details: { reason: 'booked_not_seen' }, now });
  });
  return changed;
}
