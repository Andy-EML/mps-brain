import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, pmActions, users, vantageEquipment, vantageEquipmentContracts } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { DEFAULT_PM_SETTINGS, type Visit } from './pm-due';
import { dismissPm, markPmBooked, resolvePmAction, undoPmAction, type PmAction } from './pm-actions';
import { SettingsError } from './settings';
import { listPmDue } from './pm-queries';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const at = (iso: string) => new Date(`${iso}T09:00:00Z`);
const NOW = at('2026-11-18');
const DAY_MS = 86_400_000;

const action = (o: Partial<PmAction>): PmAction => ({
  id: 1,
  vantageEquipmentId: 1,
  kind: 'booked',
  bookedFor: null,
  reference: null,
  reason: null,
  note: null,
  snoozeUntil: null,
  servicedOn: null,
  createdBy: null,
  createdByName: null,
  createdAt: at('2026-11-01'),
  ...o,
});

const visitAt = (iso: string, o: { isField?: boolean; isPm?: boolean; minutes?: number | null } = {}): Visit => ({
  day: iso,
  at: at(iso),
  minutes: o.minutes === undefined ? 60 : o.minutes,
  displayMinutes: o.minutes === undefined ? 60 : o.minutes,
  isField: o.isField ?? true,
  isPm: o.isPm ?? false,
  matchedParts: [],
  matchedKeywords: [],
  units: [],
});

describe('resolvePmAction', () => {
  const s = DEFAULT_PM_SETTINGS;

  it('booked with a date inside the grace period is booked', () => {
    expect(resolvePmAction(action({ bookedFor: day('2026-11-10') }), [], s, NOW).state).toBe('booked');
  });
  it('booked past the date plus 14 days is booked_overdue; no date uses created + 30 days', () => {
    expect(resolvePmAction(action({ bookedFor: day('2026-11-01') }), [], s, NOW).state).toBe('booked_overdue');
    expect(resolvePmAction(action({ createdAt: new Date(NOW.getTime() - 45 * DAY_MS) }), [], s, NOW).state).toBe('booked_overdue');
    expect(resolvePmAction(action({ createdAt: new Date(NOW.getTime() - 40 * DAY_MS) }), [], s, NOW).state).toBe('booked');
  });
  it('booked with a counted visit after creation is visit_seen; before creation or too short is not', () => {
    expect(resolvePmAction(action({}), [visitAt('2026-11-05')], s, NOW).state).toBe('visit_seen');
    expect(resolvePmAction(action({}), [visitAt('2026-11-05', { isField: false, isPm: true })], s, NOW).state).toBe('visit_seen');
    expect(resolvePmAction(action({}), [visitAt('2026-10-20')], s, NOW).state).toBe('booked');
    expect(resolvePmAction(action({}), [visitAt('2026-11-05', { minutes: 10 })], s, NOW).state).toBe('booked');
  });
  it('a visit counts as seen if any of its units is after creation', () => {
    const unit = (iso: string) => ({ start: new Date(iso), logged: null }) as unknown as Visit['units'][number];
    const v: Visit = { ...visitAt('2026-11-05'), units: [unit('2026-11-05T09:00:00Z'), unit('2026-11-05T14:00:00Z')] };
    const created = new Date('2026-11-05T10:00:00Z');
    expect(resolvePmAction(action({ createdAt: created }), [v], s, NOW).state).toBe('visit_seen');
    const early: Visit = { ...v, units: [unit('2026-11-05T09:00:00Z')] };
    expect(resolvePmAction(action({ createdAt: created }), [early], s, NOW).state).toBe('booked');
  });
  it('dismissed is snoozed until snoozeUntil, then expired; serviced_outside is reset', () => {
    const snoozed = action({ kind: 'dismissed', reason: 'not_now', snoozeUntil: day('2026-12-01') });
    expect(resolvePmAction(snoozed, [], s, NOW).state).toBe('snoozed');
    expect(resolvePmAction(snoozed, [], s, at('2026-12-02')).state).toBe('expired');
    expect(resolvePmAction(action({ kind: 'dismissed', reason: 'serviced_outside', servicedOn: day('2026-11-10') }), [], s, NOW).state).toBe('reset');
  });
});

describe('pm action writes', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageEquipment).values({ vantageId: 1, customerName: 'Cust', serial: 'S1', raw: { Item: { IsMetered: true, NominalCode: '4000' } } });
    await t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: 1, contractId: 10, contractReference: 'C1', isActive: true });
  });
  afterEach(() => t.close());

  const dismiss = (o: Partial<Parameters<typeof dismissPm>[1]> = {}) =>
    dismissPm(t.db, { vantageEquipmentId: 1, reason: 'not_now', note: null, snoozeDays: 90, servicedOn: null, userId: null, now: NOW, ...o });

  it('dismissPm rejects snoozeDays 45', async () => {
    const err = await dismiss({ snoozeDays: 45 }).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.code).toBe('invalid_pm_action');
    expect(await t.db.select().from(pmActions)).toHaveLength(0);
  });

  it('other without a note is rejected', async () => {
    await expect(dismiss({ reason: 'other', note: '  ' })).rejects.toMatchObject({ code: 'invalid_pm_action' });
    await dismiss({ reason: 'other', note: 'Customer away' });
    expect(await t.db.select().from(pmActions)).toHaveLength(1);
  });

  it('a new action replaces the open one', async () => {
    await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: day('2026-12-01'), reference: 'W1', userId: null, now: NOW });
    await dismiss();
    const rows = await t.db.select().from(pmActions).orderBy(pmActions.id);
    expect(rows.map((r) => [r.kind, r.clearedReason])).toEqual([
      ['booked', 'replaced'],
      ['dismissed', null],
    ]);
    expect(rows[1]!.snoozeUntil).toEqual(day('2027-02-16'));
  });

  it('writes an audit row when a user is given', async () => {
    const [u] = await t.db.insert(users).values({ username: 'a', passwordHash: 'x' }).returning();
    await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: null, reference: null, userId: u!.id, now: NOW });
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.entity, 'pm_action'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('pm_action.booked');
  });

  it('undo clears the action and the row returns to due', async () => {
    await dismiss();
    expect((await listPmDue(t.db, NOW, { view: 'dismissed' })).map((r) => r.vantageEquipmentId)).toEqual([1]);
    const [open] = await t.db.select().from(pmActions);
    await undoPmAction(t.db, open!.id, null, NOW);
    const [row] = await t.db.select().from(pmActions);
    expect(row).toMatchObject({ clearedReason: 'undo' });
    expect(row!.clearedAt).not.toBeNull();
    expect((await listPmDue(t.db, NOW, { view: 'due' })).map((r) => r.vantageEquipmentId)).toEqual([1]);
  });
});
