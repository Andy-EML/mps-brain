import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, pmPlan, users } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { addToPlan, loadPlanRows, moveCard, removeFromPlan, setPriority, setWhenInArea } from './pm-plan';

const NOW = new Date('2026-11-23T10:00:00Z');
const LATER = new Date('2026-11-24T10:00:00Z');

describe('pm plan', () => {
  let t: TestDb;
  let userId: number;
  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
    userId = u!.id;
  });
  afterEach(() => t.close());

  const get = async (id: number) => (await loadPlanRows(t.db, [id])).get(id) ?? null;
  const audits = async () => t.db.select().from(auditLog).orderBy(asc(auditLog.id));

  it('setPriority on a machine with no row creates it on to_plan (auto-added)', async () => {
    await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
    expect(await get(1)).toMatchObject({ vantageEquipmentId: 1, priority: true, whenInArea: false, boardColumn: 'to_plan', addedAt: NOW });
    const [row] = await t.db.select().from(pmPlan).where(eq(pmPlan.vantageEquipmentId, 1));
    expect(row!.updatedBy).toBe(userId);
  });

  it('setPriority on a done card puts it back on to_plan; on an asked card leaves the column', async () => {
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: NOW });
    await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: LATER });
    expect(await get(1)).toMatchObject({ boardColumn: 'to_plan', doneAt: null, doneReason: null, addedAt: LATER });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'asked', userId, now: NOW });
    await setPriority(t.db, { vantageEquipmentId: 2, on: true, userId, now: LATER });
    expect(await get(2)).toMatchObject({ boardColumn: 'asked', askedAt: NOW, priority: true });
  });

  it('setPriority off keeps the card on the board', async () => {
    await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
    await setPriority(t.db, { vantageEquipmentId: 1, on: false, userId, now: LATER });
    expect(await get(1)).toMatchObject({ priority: false, boardColumn: 'to_plan' });
  });

  it('setWhenInArea toggles without touching the column', async () => {
    await setWhenInArea(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
    expect(await get(1)).toMatchObject({ whenInArea: true, boardColumn: null });
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', userId, now: NOW });
    await setWhenInArea(t.db, { vantageEquipmentId: 1, on: false, userId, now: LATER });
    expect(await get(1)).toMatchObject({ whenInArea: false, boardColumn: 'asked' });
  });

  it('turning the last flag off on a machine not on the board deletes its row', async () => {
    await setWhenInArea(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
    await setWhenInArea(t.db, { vantageEquipmentId: 1, on: false, userId, now: LATER });
    expect(await get(1)).toBeNull();
    await setPriority(t.db, { vantageEquipmentId: 3, on: false, userId, now: NOW });
    expect(await get(3)).toBeNull();
  });

  it('addToPlan of a done row resets to to_plan and clears doneAt / doneReason', async () => {
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: NOW });
    expect(await get(1)).toMatchObject({ boardColumn: 'done', doneAt: NOW, doneReason: 'manual' });
    await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: LATER });
    expect(await get(1)).toMatchObject({ boardColumn: 'to_plan', addedAt: LATER, doneAt: null, doneReason: null, askedAt: null });
  });

  it('addToPlan leaves an asked row untouched and adds new machines', async () => {
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', userId, now: NOW });
    const before = await get(1);
    await addToPlan(t.db, { vantageEquipmentIds: [1, 2, 2], userId, now: LATER });
    expect(await get(1)).toEqual(before);
    expect(await get(2)).toMatchObject({ boardColumn: 'to_plan', addedAt: LATER });
  });

  it('moveCard to asked sets askedAt; to done sets doneReason manual; back to to_plan clears them', async () => {
    await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', note: 'Rang Dave', userId, now: LATER });
    expect(await get(1)).toMatchObject({ boardColumn: 'asked', askedAt: LATER, boardNote: 'Rang Dave', addedAt: NOW });
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: LATER });
    expect(await get(1)).toMatchObject({ boardColumn: 'done', doneAt: LATER, doneReason: 'manual', boardNote: 'Rang Dave' });
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'to_plan', note: null, userId, now: LATER });
    expect(await get(1)).toMatchObject({ boardColumn: 'to_plan', askedAt: null, doneAt: null, doneReason: null, boardNote: null });
  });

  it('moveCard out of Done to To plan or Asked re-stamps addedAt (so an old visit cannot pull it back)', async () => {
    await addToPlan(t.db, { vantageEquipmentIds: [1, 2], userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'done', userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'to_plan', userId, now: LATER });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'asked', userId, now: LATER });
    expect(await get(1)).toMatchObject({ boardColumn: 'to_plan', addedAt: LATER });
    expect(await get(2)).toMatchObject({ boardColumn: 'asked', addedAt: LATER });
    // a move between To plan and Asked keeps the original addedAt
    await addToPlan(t.db, { vantageEquipmentIds: [3], userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 3, to: 'asked', userId, now: LATER });
    expect(await get(3)).toMatchObject({ boardColumn: 'asked', addedAt: NOW });
  });

  it('setPriority / setWhenInArea leave updatedAt alone unless the board column changes', async () => {
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', userId, now: NOW });
    await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: LATER });
    await setWhenInArea(t.db, { vantageEquipmentId: 1, on: true, userId, now: LATER });
    await setPriority(t.db, { vantageEquipmentId: 1, on: false, userId, now: LATER });
    expect(await get(1)).toMatchObject({ boardColumn: 'asked', priority: false, whenInArea: true, updatedAt: NOW });
    // Priority on a Done card puts it on To plan: that is a column change, so it is stamped.
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'done', userId, now: NOW });
    await setPriority(t.db, { vantageEquipmentId: 2, on: true, userId, now: LATER });
    expect(await get(2)).toMatchObject({ boardColumn: 'to_plan', updatedAt: LATER });
    // A new row is stamped on insert.
    await setWhenInArea(t.db, { vantageEquipmentId: 3, on: true, userId, now: LATER });
    expect(await get(3)).toMatchObject({ updatedAt: LATER });
  });

  it('moveCard appendNote adds a line under an existing note and never cuts the existing text', async () => {
    // No row yet: the appended line is the note.
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', appendNote: 'Asked Dave for 24 Nov', userId, now: NOW });
    expect(await get(1)).toMatchObject({ boardColumn: 'asked', boardNote: 'Asked Dave for 24 Nov', addedAt: NOW, askedAt: NOW });
    // A typed note stays; the line goes under it.
    await addToPlan(t.db, { vantageEquipmentIds: [2], userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'to_plan', note: 'Key code 1234', userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'asked', appendNote: '  Asked Sam for 25 Nov ', userId, now: LATER });
    expect(await get(2)).toMatchObject({ boardColumn: 'asked', boardNote: 'Key code 1234\nAsked Sam for 25 Nov', askedAt: LATER });
    // On the board with a blank note: just the line.
    await addToPlan(t.db, { vantageEquipmentIds: [3], userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 3, to: 'asked', appendNote: 'Asked Dave for 24 Nov', userId, now: NOW });
    expect((await get(3))!.boardNote).toBe('Asked Dave for 24 Nov');
    const [last] = (await audits()).slice(-1);
    expect(last).toMatchObject({ action: 'pm_plan.move', details: { to: 'asked', appendNote: 'Asked Dave for 24 Nov' } });
  });

  it('moveCard appendNote trims only the appended part to fit 500 characters', async () => {
    const typed = 'x'.repeat(480);
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'to_plan', note: typed, userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', appendNote: 'Asked Dave for 24 Nov', userId, now: NOW });
    const note = (await get(1))!.boardNote!;
    expect(note).toHaveLength(500);
    expect(note).toBe(`${typed}\n${'Asked Dave for 24 Nov'.slice(0, 19)}`);
    // A full note is left exactly as typed.
    const full = 'y'.repeat(500);
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'to_plan', note: full, userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'asked', appendNote: 'Asked Dave for 24 Nov', userId, now: NOW });
    expect((await get(2))!.boardNote).toBe(full);
    await moveCard(t.db, { vantageEquipmentId: 3, to: 'to_plan', note: 'z'.repeat(499), userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 3, to: 'asked', appendNote: 'Asked', userId, now: NOW });
    expect((await get(3))!.boardNote).toBe('z'.repeat(499));
  });

  it('moveCard refuses note and appendNote together', async () => {
    await expect(moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', note: 'a', appendNote: 'b', userId, now: NOW })).rejects.toThrow();
  });

  it('removeFromPlan with flags keeps the row off the board; without flags deletes it', async () => {
    await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
    await removeFromPlan(t.db, { vantageEquipmentId: 1, userId });
    expect(await get(1)).toMatchObject({ priority: true, boardColumn: null, addedAt: null });
    await addToPlan(t.db, { vantageEquipmentIds: [2], userId, now: NOW });
    await removeFromPlan(t.db, { vantageEquipmentId: 2, userId });
    expect(await get(2)).toBeNull();
  });

  it('loadPlanRows with no ids loads every row; an empty id list loads none', async () => {
    await addToPlan(t.db, { vantageEquipmentIds: [1, 2], userId, now: NOW });
    expect([...(await loadPlanRows(t.db)).keys()].sort()).toEqual([1, 2]);
    expect((await loadPlanRows(t.db, [])).size).toBe(0);
  });

  it('every write adds an audit_log row with the user id', async () => {
    await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
    await setWhenInArea(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
    await addToPlan(t.db, { vantageEquipmentIds: [2], userId, now: NOW });
    await moveCard(t.db, { vantageEquipmentId: 2, to: 'asked', userId, now: NOW });
    await removeFromPlan(t.db, { vantageEquipmentId: 2, userId });
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['pm_plan.priority', 'pm_plan.when_in_area', 'pm_plan.add', 'pm_plan.move', 'pm_plan.remove']);
    expect(rows.every((r) => r.userId === userId && r.entity === 'pm_plan')).toBe(true);
    expect(rows[0]!.entityIds).toEqual([1]);
    expect(rows[0]!.details).toEqual({ on: true });
    expect(rows[3]!.details).toEqual({ to: 'asked', note: null });
  });
});
