import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  pmPlan,
  postcodeDistricts,
  users,
  vantageCustomers,
  vantageEngineers,
  vantageEquipment,
  vantageEquipmentContracts,
  vantageMeterReadings,
  vantageScheduledUnits,
  vantageWorkVisits,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { setOtherDealer } from './other-dealer';
import { dismissPm, markPmBooked, type PmAction } from './pm-actions';
import { addToPlan, markDoneByVisit, markLapsed, moveCard, setPriority, setWhenInArea, type PmPlanRow } from './pm-plan';
import {
  askedDaysOf,
  boardColumnOf,
  getScheduledCall,
  groupCardsByArea,
  haversineMiles,
  loadBoard,
  loadMapPins,
  loadUpcoming,
  suggestNear,
  type SuggestionCandidate,
} from './pm-planner';
import { listPmDue, type PmRow } from './pm-queries';
import type { PmPatch } from './pm-planner-settings';

vi.mock('./pm-plan', async (orig) => {
  const m = await orig<typeof import('./pm-plan')>();
  return { ...m, markDoneByVisit: vi.fn(m.markDoneByVisit) };
});

const d = (iso: string) => new Date(`${iso}T09:00:00Z`);
const NOW = d('2026-11-23');
const DAY = 86_400_000;
const ago = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY);

function plan(over: Partial<PmPlanRow> = {}): PmPlanRow {
  return {
    vantageEquipmentId: 1,
    whenInArea: false,
    priority: false,
    boardColumn: 'to_plan',
    boardNote: null,
    addedAt: ago(10),
    askedAt: null,
    doneAt: null,
    doneReason: null,
    updatedAt: ago(10),
    ...over,
  };
}

function pmRow(over: Partial<PmRow> = {}, status: PmRow['result']['status'] = 'overdue'): PmRow {
  return {
    vantageEquipmentId: 1,
    drmsEquipmentId: null,
    customerName: 'Acme',
    town: null,
    customerId: 7,
    district: 'GU14',
    county: 'Hampshire',
    areaCounty: null,
    otherDealer: { dealer: null, source: null, region: null },
    plan: { whenInArea: false, priority: false, boardColumn: 'to_plan' },
    serial: 'A1',
    model: 'C300i',
    family: null,
    intervalPages: 100000,
    intervalSource: 'global',
    action: null,
    bookedOverdue: false,
    view: 'due',
    result: {
      status,
      reason: null,
      lastQualifying: null,
      pagesSince: null,
      pagesSinceIsLowerBound: false,
      pctUsed: null,
      pagesPerDay: null,
      estDueDate: null,
      timeCapDate: null,
      clockStart: null,
      clockSource: null,
      bookedFor: null,
      frequentVisits: 0,
      holdUntil: null,
      visits: [],
    },
    ...over,
  };
}

const booked = (over: Partial<PmAction> = {}): PmAction => ({
  id: 1,
  vantageEquipmentId: 1,
  kind: 'booked',
  bookedFor: new Date('2026-11-25T00:00:00Z'),
  reference: 'W-123',
  reason: null,
  note: null,
  snoozeUntil: null,
  servicedOn: null,
  createdBy: null,
  createdByName: null,
  createdAt: ago(5),
  ...over,
});

describe('boardColumnOf', () => {
  it('keeps the stored asked column', () => {
    expect(boardColumnOf(plan({ boardColumn: 'asked', askedAt: ago(2) }), pmRow(), NOW)).toEqual({ column: 'asked', reason: null });
  });

  it('shows Booked with the reference when an open booked action exists', () => {
    const r = pmRow({ action: booked(), view: 'booked' });
    expect(boardColumnOf(plan(), r, NOW)).toEqual({ column: 'booked', reason: 'Booked for 25 Nov (ref W-123)' });
    expect(boardColumnOf(plan({ boardColumn: 'asked', askedAt: ago(1) }), r, NOW).column).toBe('booked');
  });

  it('shows Booked for a Vantage PM job', () => {
    const r = pmRow({ view: 'booked' }, 'booked');
    r.result.bookedFor = new Date('2026-11-25T08:00:00Z');
    expect(boardColumnOf(plan(), r, NOW)).toEqual({ column: 'booked', reason: 'Booked: PM job in Vantage for 25 Nov' });
  });

  it('returns a lapsed booking (expired 3 days ago) to To plan with a reason', () => {
    const r = pmRow({ action: booked({ bookedFor: ago(17), reference: null }), bookedOverdue: true });
    expect(boardColumnOf(plan(), r, NOW)).toEqual({ column: 'to_plan', reason: 'Booked visit not seen' });
    expect(boardColumnOf(plan({ boardColumn: 'asked', askedAt: ago(8) }), r, NOW)).toEqual({ column: 'to_plan', reason: 'Booked visit not seen' });
  });

  it('lets a move to Asked after the lapse stick', () => {
    const r = pmRow({ action: booked({ bookedFor: ago(17), reference: null }), bookedOverdue: true });
    expect(boardColumnOf(plan({ boardColumn: 'asked', askedAt: ago(1), updatedAt: ago(1) }), r, NOW)).toEqual({ column: 'asked', reason: null });
  });

  it('drops the lapsed reason once the booking expired more than 14 days ago', () => {
    const r = pmRow({ action: booked({ bookedFor: ago(40) }), bookedOverdue: true });
    expect(boardColumnOf(plan(), r, NOW)).toEqual({ column: 'to_plan', reason: null });
    // moved after the lapse: stays; untouched since before it: To plan, no reason, no flip back to Asked
    expect(boardColumnOf(plan({ boardColumn: 'asked', askedAt: ago(8), updatedAt: ago(8) }), r, NOW)).toEqual({ column: 'asked', reason: null });
    expect(boardColumnOf(plan({ boardColumn: 'asked', askedAt: ago(50), updatedAt: ago(50) }), r, NOW)).toEqual({ column: 'to_plan', reason: null });
  });

  it('keeps done as done, with the visit date as the reason', () => {
    const r = pmRow();
    r.result.lastQualifying = { at: new Date('2026-11-21T10:00:00Z') } as PmRow['result']['lastQualifying'];
    expect(boardColumnOf(plan({ boardColumn: 'done', doneAt: ago(1), doneReason: 'visit' }), r, NOW)).toEqual({ column: 'done', reason: 'Visit seen 21 Nov' });
    expect(boardColumnOf(plan({ boardColumn: 'done', doneAt: ago(1), doneReason: 'manual' }), null, NOW)).toEqual({ column: 'done', reason: null });
  });

  it('works when the machine has no PM row (contract ended)', () => {
    expect(boardColumnOf(plan(), null, NOW)).toEqual({ column: 'to_plan', reason: null });
  });

  it('says Due again on a To plan card the sync brought back from Done (doneAt kept as the marker)', () => {
    expect(boardColumnOf(plan({ doneAt: ago(15), doneReason: 'manual' }), pmRow(), NOW)).toEqual({ column: 'to_plan', reason: 'Due again' });
  });
});

describe('askedDaysOf', () => {
  it('counts whole days since askedAt for an asked card only', () => {
    expect(askedDaysOf(plan({ boardColumn: 'asked', askedAt: ago(9) }), NOW)).toBe(9);
    expect(askedDaysOf(plan({ boardColumn: 'to_plan', askedAt: null }), NOW)).toBeNull();
  });
});

describe('groupCardsByArea', () => {
  const card = (id: number, county: string | null, district: string | null, o: { priority?: boolean; overdue?: number | null } = {}) => ({
    id,
    county,
    district,
    priority: o.priority ?? false,
    overdueMonths: o.overdue ?? null,
  });

  it('groups districts of one county under it', () => {
    const g = groupCardsByArea([card(1, 'Hampshire', 'GU14'), card(2, 'Hampshire', 'GU51'), card(3, 'Surrey', 'GU1')], []);
    expect(g.map((x) => x.county)).toEqual(['Hampshire', 'Surrey']);
    expect(g[0]!.patches).toHaveLength(1);
    expect(g[0]!.patches[0]!.name).toBeNull();
    expect(g[0]!.patches[0]!.districts.map((x) => x.district)).toEqual(['GU14', 'GU51']);
  });

  it('nests a patch holding GU14 and GU11 and leaves other districts in the unnamed patch', () => {
    const patches: PmPatch[] = [{ name: 'Farnborough patch', districts: ['GU14', 'GU11', 'GU51'] }];
    const g = groupCardsByArea([card(1, 'Hampshire', 'GU14'), card(2, 'Hampshire', 'GU11'), card(3, 'Hampshire', 'RG24')], patches);
    expect(g[0]!.patches.map((p) => [p.name, p.districts.map((x) => x.district)])).toEqual([
      ['Farnborough patch', ['GU11', 'GU14']],
      [null, ['RG24']],
    ]);
  });

  it('shows a patch spanning two counties under each, with only that county districts', () => {
    const patches: PmPatch[] = [{ name: 'Border', districts: ['GU14', 'GU1'] }];
    const g = groupCardsByArea([card(1, 'Hampshire', 'GU14'), card(2, 'Surrey', 'GU1')], patches);
    expect(g.map((x) => [x.county, x.patches.map((p) => [p.name, p.districts.map((y) => y.district)])])).toEqual([
      ['Hampshire', [['Border', ['GU14']]]],
      ['Surrey', [['Border', ['GU1']]]],
    ]);
  });

  it('lists the unknown county last and no-postcode last inside a county', () => {
    const g = groupCardsByArea([card(1, null, 'GU14'), card(2, 'Hampshire', null), card(3, 'Hampshire', 'GU14')], []);
    expect(g.map((x) => x.county)).toEqual(['Hampshire', 'Unknown county']);
    expect(g[0]!.patches[0]!.districts.map((x) => x.district)).toEqual(['GU14', null]);
  });

  it('counts due, overdue and priority, and orders a district priority then most overdue', () => {
    const g = groupCardsByArea(
      [card(1, 'Hampshire', 'GU14', { overdue: 3 }), card(2, 'Hampshire', 'GU14', { overdue: 18 }), card(3, 'Hampshire', 'GU14', { priority: true }), card(4, 'Hampshire', 'GU14')],
      [],
    );
    expect(g[0]).toMatchObject({ due: 4, overdue: 2, priority: 1 });
    expect(g[0]!.patches[0]!.districts[0]!.cards.map((c) => c.id)).toEqual([3, 2, 1, 4]);
  });
});

describe('haversineMiles', () => {
  it('Farnborough to Guildford is about 8.9 miles (brief said ~8.6; the coordinates give 8.93); same point is 0', () => {
    const fb = { lat: 51.2933, lng: -0.7556 };
    const gf = { lat: 51.2362, lng: -0.5704 };
    expect(haversineMiles(fb, gf)).toBeGreaterThan(8.5);
    expect(haversineMiles(fb, gf)).toBeLessThan(9.0);
    expect(haversineMiles(fb, fb)).toBe(0);
  });
});

describe('suggestNear', () => {
  const HERE = { lat: 51.2933, lng: -0.7556 };
  // ~0.0145 degrees of latitude is one mile
  const at = (miles: number) => ({ lat: HERE.lat + miles * 0.0145, lng: HERE.lng });
  const cand = (id: number, o: Partial<SuggestionCandidate> = {}): SuggestionCandidate => ({
    vantageEquipmentId: id,
    customerId: 100 + id,
    customerName: `Cust ${id}`,
    town: null,
    serial: `S${id}`,
    model: 'C300i',
    status: 'overdue',
    overdueMonths: 2,
    priority: false,
    whenInArea: false,
    district: 'ZZ9',
    at: null,
    approximate: false,
    view: 'due',
    dealer: null,
    boardColumn: null,
    ...o,
  });
  const call = { customerId: 1, district: 'GU14', at: HERE as { lat: number; lng: number } | null };
  const ids = (s: { vantageEquipmentId: number }[]) => s.map((x) => x.vantageEquipmentId);

  it('includes the same district with no coordinates', () => {
    const s = suggestNear({ customerId: null, district: 'GU14', at: null }, [cand(1, { district: 'GU14' }), cand(2, { district: 'RG24' })], 10);
    expect(ids(s)).toEqual([1]);
    expect(s[0]).toMatchObject({ sameDistrict: true, sameSite: false, distanceMiles: null });
  });

  it('a call with no district and no location finds nothing', () => {
    expect(suggestNear({ customerId: null, district: null, at: null }, [cand(1, { district: 'GU14' })], 10)).toEqual([]);
  });

  it('uses the radius: 9 miles in, 11 miles out', () => {
    const s = suggestNear(call, [cand(1, { at: at(9) }), cand(2, { at: at(11) })], 10);
    expect(ids(s)).toEqual([1]);
    expect(s[0]!.distanceMiles).toBeGreaterThan(8.5);
    expect(s[0]!.distanceMiles).toBeLessThan(9.5);
  });

  it('flags the same site', () => {
    const s = suggestNear(call, [cand(1, { customerId: 1, district: 'GU14', at: HERE })], 10);
    expect(s[0]).toMatchObject({ sameSite: true, sameDistrict: true });
  });

  it('orders priority, overdue, due soon, then when in area (even an overdue one), then distance', () => {
    const s = suggestNear(
      call,
      [
        cand(1, { status: 'due_soon', at: at(1) }),
        cand(2, { whenInArea: true, status: 'overdue', at: at(0.5) }),
        cand(3, { status: 'overdue', at: at(5) }),
        cand(4, { priority: true, status: 'due_soon', at: at(8) }),
        cand(5, { status: 'overdue', at: at(2) }),
      ],
      10,
    );
    expect(ids(s)).toEqual([4, 5, 3, 1, 2]);
  });

  it('limits to 8 by default and honours an explicit limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => cand(i + 1, { district: 'GU14' }));
    expect(suggestNear(call, many, 10)).toHaveLength(8);
    expect(suggestNear(call, many, 10, 3)).toHaveLength(3);
  });

  it('excludes booked, dismissed and other-dealer machines', () => {
    const s = suggestNear(
      call,
      [cand(1, { district: 'GU14', view: 'booked' }), cand(2, { district: 'GU14', view: 'dismissed' }), cand(3, { district: 'GU14', dealer: 'MJ Flood' }), cand(4, { district: 'GU14' })],
      10,
    );
    expect(ids(s)).toEqual([4]);
  });
});

describe('planner database loaders', () => {
  let t: TestDb;
  let userId: number;
  let wid = 0;
  let rid = 0;

  beforeEach(async () => {
    t = await createTestDb();
    wid = 0;
    rid = 0;
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
    userId = u!.id;
  });
  afterEach(() => t.close());

  const customer = (id: number, name: string, raw: Record<string, unknown>) => t.db.insert(vantageCustomers).values({ vantageId: id, name, raw });
  const item = { Item: { IsMetered: true, NominalCode: '4000' } };
  /** A due (overdue, time cap) machine with an active contract. */
  async function dueMachine(id: number, customerId: number | null, o: { contract?: boolean; now?: Date } = {}) {
    await t.db.insert(vantageEquipment).values({ vantageId: id, customerName: `Cust ${customerId}`, vantageCustomerId: customerId, serial: `SER${id}`, description: 'C300i', raw: item });
    await t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: id, contractId: id * 10, isActive: o.contract ?? true });
    const now = o.now ?? NOW;
    for (const [iso, v] of [[ago(300, now), 1000], [ago(10, now), 50_000]] as const) {
      await t.db.insert(vantageMeterReadings).values({ vantageId: ++rid, vantageEquipmentId: id, meterTypeId: 1, readingAt: iso, reading: v, raw: {} });
    }
    await visit(id, ago(600, now));
  }
  const visit = (id: number, at: Date) =>
    t.db.insert(vantageWorkVisits).values({
      workUnitId: ++wid,
      workId: wid,
      vantageEquipmentId: id,
      categoryId: 1,
      categoryName: 'Break/fix',
      categoryType: 'Field',
      loggedAt: at,
      workStart: at,
      workHours: 2,
      raw: {},
    });
  const plans = async () => Object.fromEntries((await t.db.select().from(pmPlan)).map((r) => [r.vantageEquipmentId, r]));

  describe('loadBoard', () => {
    it('lists only machines that were added, with area and overdue fields', async () => {
      await customer(7, 'Acme', { Town: 'Farnborough', PostCode: 'GU14 7PR', County: 'Hampshire' });
      await dueMachine(1, 7);
      await dueMachine(2, 7);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(2) });
      const { cards, settings } = await loadBoard(t.db, NOW);
      expect(settings.nearMiles).toBe(10);
      expect(cards.map((c) => c.vantageEquipmentId)).toEqual([1]);
      expect(cards[0]).toMatchObject({
        customerId: 7,
        customerName: 'Cust 7',
        town: 'Farnborough',
        serial: 'SER1',
        model: 'C300i',
        district: 'GU14',
        county: 'Hampshire',
        status: 'overdue',
        column: 'to_plan',
        leftDue: null,
        priority: false,
        whenInArea: false,
        askedDays: null,
        askedStale: false,
        note: null,
      });
      expect(cards[0]!.overdueMonths).toBeGreaterThanOrEqual(0);
    });

    it('prefers the cached postcodes.io county over the Vantage county text', async () => {
      await customer(7, 'Acme', { PostCode: 'GU14 7PR', County: 'Hants' });
      await t.db.insert(postcodeDistricts).values({ district: 'GU14', county: 'Hampshire', status: 'ok' });
      await dueMachine(1, 7);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(2) });
      expect((await loadBoard(t.db, NOW)).cards[0]!.county).toBe('Hampshire');
    });

    it('shows a flagged when-in-area machine and carries priority and the note', async () => {
      await dueMachine(1, null);
      await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: ago(2) });
      await setWhenInArea(t.db, { vantageEquipmentId: 1, on: true, userId, now: ago(2) });
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', note: 'Rang Dave', userId, now: ago(9) });
      const c = (await loadBoard(t.db, NOW)).cards[0]!;
      expect(c).toMatchObject({ priority: true, whenInArea: true, note: 'Rang Dave', column: 'asked', askedDays: 9, askedStale: true });
    });

    it('keeps a priority card whose customer is now other dealer, with a reason (Review Focus 3)', async () => {
      await customer(8, 'Dublin Ltd', { PostCode: 'D04 EK2K' });
      await dueMachine(1, 8);
      await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: ago(2) });
      const c = (await loadBoard(t.db, NOW)).cards[0]!;
      expect(c).toMatchObject({ vantageEquipmentId: 1, column: 'to_plan', leftDue: 'other_dealer', priority: true });
      expect(await plans()).toHaveProperty('1');
    });

    it('keeps a card whose contract ended, showing the serial from vantage_equipment', async () => {
      await customer(7, 'Acme', { PostCode: 'GU14 7PR' });
      await dueMachine(1, 7, { contract: false });
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(2) });
      const c = (await loadBoard(t.db, NOW)).cards[0]!;
      expect(c).toMatchObject({ leftDue: 'left_contract', serial: 'SER1', customerId: 7, district: 'GU14', status: null, overdueMonths: null, column: 'to_plan' });
    });

    it('keeps a dismissed card with the reason', async () => {
      await dueMachine(1, null);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(2) });
      await dismissPm(t.db, { vantageEquipmentId: 1, reason: 'not_now', note: null, servicedOn: null, userId, now: ago(1) });
      expect((await loadBoard(t.db, NOW)).cards[0]).toMatchObject({ leftDue: 'dismissed', column: 'to_plan' });
    });

    it('flags a card whose machine is no longer due as not_due', async () => {
      await dueMachine(1, null);
      await visit(1, ago(20));
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(2) });
      expect((await loadBoard(t.db, NOW)).cards[0]).toMatchObject({ column: 'to_plan', leftDue: 'not_due', status: 'ok' });
    });

    it('shows a manually booked machine in Booked, and a lapsed booking back in To plan', async () => {
      await dueMachine(1, null);
      await dueMachine(2, null);
      await addToPlan(t.db, { vantageEquipmentIds: [1, 2], userId, now: ago(30) });
      await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: new Date('2026-11-27T00:00:00Z'), reference: 'W-9', userId, now: ago(1) });
      await markPmBooked(t.db, { vantageEquipmentId: 2, bookedFor: ago(18), reference: null, userId, now: ago(25) });
      const by = Object.fromEntries((await loadBoard(t.db, NOW)).cards.map((c) => [c.vantageEquipmentId, c]));
      expect(by[1]).toMatchObject({ column: 'booked', reason: 'Booked for 27 Nov (ref W-9)' });
      expect(by[2]).toMatchObject({ column: 'to_plan', reason: 'Booked visit not seen' });
    });

    it('a lapse drops an Asked card to To plan once, and a later move to Asked sticks', async () => {
      await dueMachine(1, null);
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', userId, now: ago(40) });
      await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: ago(18), reference: null, userId, now: ago(30) });
      const first = (await loadBoard(t.db, NOW)).cards[0]!;
      expect(first).toMatchObject({ column: 'to_plan', reason: 'Booked visit not seen', askedDays: null });
      expect((await plans())[1]).toMatchObject({ boardColumn: 'to_plan', askedAt: null });
      expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm_plan.auto_lapse'))).toHaveLength(1);
      // idempotent: a second load changes and audits nothing more
      await loadBoard(t.db, NOW);
      expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm_plan.auto_lapse'))).toHaveLength(1);
      // the user asks the engineer: sticks, with the asked-days badge
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', userId, now: new Date(NOW.getTime() - 3_600_000) });
      expect((await loadBoard(t.db, NOW)).cards[0]).toMatchObject({ column: 'asked', reason: null, askedDays: 0 });
      // and still sticks 20 days later (no day-15 flip either way)
      expect((await loadBoard(t.db, new Date(NOW.getTime() + 20 * DAY))).cards[0]!.column).toBe('asked');
    });

    it('markLapsed is guarded: it never overrides a card touched after the expiry', async () => {
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', userId, now: ago(2) });
      expect(await markLapsed(t.db, [{ id: 1, expiry: ago(5) }], NOW)).toEqual([]);
      expect(await markLapsed(t.db, [{ id: 1, expiry: ago(1) }], NOW)).toEqual([1]);
      expect(await markLapsed(t.db, [{ id: 1, expiry: ago(1) }], NOW)).toEqual([]);
    });

    it('moves a card to done when a qualifying visit landed after it was added, and persists it', async () => {
      await dueMachine(1, null);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(5) });
      await visit(1, ago(2));
      const c = (await loadBoard(t.db, NOW)).cards[0]!;
      expect(c).toMatchObject({ column: 'done' });
      expect(c.reason).toMatch(/^Visit seen \d+ \w{3}$/);
      const p = (await plans())[1]!;
      expect(p).toMatchObject({ boardColumn: 'done', doneReason: 'visit' });
      expect(p.doneAt?.getTime()).toBe(NOW.getTime());
      const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm_plan.auto_done'));
      expect(audits).toHaveLength(1);
    });

    it('does not move a card for a visit from before it was added', async () => {
      await dueMachine(1, null);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(5) });
      expect((await loadBoard(t.db, NOW)).cards[0]!.column).toBe('to_plan');
    });

    it('keeps done cards for the retention period then drops them off the board (flags kept)', async () => {
      await dueMachine(1, null);
      await dueMachine(2, null);
      // not due: visits recently so they stay done
      await visit(1, ago(3));
      await visit(2, ago(20));
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: ago(13) });
      await moveCard(t.db, { vantageEquipmentId: 2, to: 'done', userId, now: ago(15) });
      await setWhenInArea(t.db, { vantageEquipmentId: 2, on: true, userId, now: ago(15) });
      const { cards } = await loadBoard(t.db, NOW);
      expect(cards.map((c) => c.vantageEquipmentId)).toEqual([1]);
      expect((await plans())[2]).toMatchObject({ boardColumn: null, doneAt: null, doneReason: null, addedAt: null, whenInArea: true });
      expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm_plan.auto_drop'))).toHaveLength(1);
    });

    it('keeps a manual Done card in Done for the 14-day retention even when the machine is due again', async () => {
      await dueMachine(1, null);
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: ago(3) });
      expect((await loadBoard(t.db, NOW)).cards[0]).toMatchObject({ column: 'done', reason: null });
      expect((await loadBoard(t.db, new Date(NOW.getTime() + 10 * DAY))).cards[0]).toMatchObject({ column: 'done' });
      expect((await plans())[1]).toMatchObject({ boardColumn: 'done', doneReason: 'manual' });
    });

    it('drops a manual Done card of a due machine after the retention; it is not put back in To plan', async () => {
      await dueMachine(1, null);
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: ago(15) });
      expect((await loadBoard(t.db, NOW)).cards).toEqual([]);
      expect((await plans())[1]).toBeUndefined();
      expect((await loadBoard(t.db, new Date(NOW.getTime() + DAY))).cards).toEqual([]);
    });

    it('brings a Priority Done card that is due again back to To plan with Due again, after the retention', async () => {
      await dueMachine(1, null);
      await dueMachine(2, null);
      await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: ago(20) });
      await setPriority(t.db, { vantageEquipmentId: 2, on: true, userId, now: ago(20) });
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'done', userId, now: ago(15) });
      await moveCard(t.db, { vantageEquipmentId: 2, to: 'done', userId, now: ago(3) });
      const by = Object.fromEntries((await loadBoard(t.db, NOW)).cards.map((c) => [c.vantageEquipmentId, c]));
      expect(by[1]).toMatchObject({ column: 'to_plan', reason: 'Due again', priority: true });
      expect(by[2]).toMatchObject({ column: 'done' });
      expect((await plans())[1]).toMatchObject({ boardColumn: 'to_plan', askedAt: null });
      expect((await plans())[1]!.addedAt?.getTime()).toBe(NOW.getTime());
      expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm_plan.auto_reset'))).toHaveLength(1);
      // a move clears the badge
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'asked', userId, now: NOW });
      expect((await loadBoard(t.db, NOW)).cards.find((c) => c.vantageEquipmentId === 1)).toMatchObject({ column: 'asked', reason: null });
    });

    it('a card moved out of Done after a visit stays where it was put', async () => {
      await dueMachine(1, null);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(5) });
      await visit(1, ago(2));
      expect((await loadBoard(t.db, ago(1))).cards[0]!.column).toBe('done');
      await moveCard(t.db, { vantageEquipmentId: 1, to: 'to_plan', userId, now: ago(1) });
      expect((await loadBoard(t.db, NOW)).cards[0]!.column).toBe('to_plan');
    });

    it('logs a failed sync write and still loads the board', async () => {
      await dueMachine(1, null);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(5) });
      await visit(1, ago(2));
      vi.mocked(markDoneByVisit).mockRejectedValueOnce(new Error('db down'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { cards } = await loadBoard(t.db, NOW);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.column).toBe('done');
        expect(spy).toHaveBeenCalled();
        expect((await plans())[1]!.boardColumn).toBe('to_plan');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('loadUpcoming', () => {
    // 1 April 2026 08:00Z = 09:00 BST
    const NOW2 = new Date('2026-04-01T08:00:00Z');
    const unit = (id: number, start: string, o: Partial<typeof vantageScheduledUnits.$inferInsert> = {}) =>
      t.db.insert(vantageScheduledUnits).values({
        workUnitId: id,
        workId: id,
        workReference: `W-${id}`,
        engineerId: 1,
        customerId: 7,
        scheduledStart: new Date(start),
        categoryName: 'Break/fix',
        categoryType: 'Field',
        raw: {},
        ...o,
      });

    beforeEach(async () => {
      await t.db.insert(vantageEngineers).values([
        { vantageId: 1, name: 'Dave Smith', raw: {} },
        { vantageId: 2, name: 'Amy Jones', raw: {} },
      ]);
      await customer(7, 'Acme Ltd', { PostCode: 'GU14 7PR', Latitude: '51.2933', Longitude: '-0.7556' });
    });

    it('puts a 23:30Z unit on 31 Mar (BST) onto 1 Apr, and a 22:30Z one on 31 Mar (excluded)', async () => {
      await unit(1, '2026-03-31T23:30:00Z');
      await unit(2, '2026-03-31T22:30:00Z');
      await unit(3, '2026-04-02T07:00:00Z');
      await unit(4, '2026-04-03T07:00:00Z');
      const r = await loadUpcoming(t.db, NOW2);
      expect(r.today).toBe('2026-04-01');
      expect(r.tomorrow).toBe('2026-04-02');
      const dave = r.engineers.find((e) => e.name === 'Dave Smith')!;
      expect(dave.days.map((x) => [x.which, x.date, x.calls.map((c) => c.workUnitId)])).toEqual([
        ['today', '2026-04-01', [1]],
        ['tomorrow', '2026-04-02', [3]],
      ]);
    });

    it('excludes completed units, flags started, sorts by start, carries reference and names', async () => {
      await unit(1, '2026-04-01T13:00:00Z');
      await unit(2, '2026-04-01T07:30:00Z', { workStart: new Date('2026-04-01T07:40:00Z'), vantageEquipmentId: 5 });
      await unit(3, '2026-04-01T09:00:00Z', { completedAt: new Date('2026-04-01T09:30:00Z') });
      await t.db.insert(vantageEquipment).values({ vantageId: 5, vantageCustomerId: 7, serial: 'SER5', description: 'bizhub C300i', raw: item });
      const dave = (await loadUpcoming(t.db, NOW2)).engineers[0]!;
      const calls = dave.days[0]!.calls;
      expect(calls.map((c) => c.workUnitId)).toEqual([2, 1]);
      expect(calls[0]).toMatchObject({ started: true, reference: 'W-2', customerName: 'Acme Ltd', district: 'GU14', categoryName: 'Break/fix', located: 'customer' });
      expect(calls[0]!.equipment).toContain('SER5');
      expect(calls[1]!.started).toBe(false);
    });

    it('groups two engineers with names; unknown and null engineers get fallbacks', async () => {
      await unit(1, '2026-04-01T09:00:00Z', { engineerId: 2 });
      await unit(2, '2026-04-01T09:00:00Z', { engineerId: 1 });
      await unit(3, '2026-04-01T09:00:00Z', { engineerId: 99 });
      await unit(4, '2026-04-01T09:00:00Z', { engineerId: null });
      const names = (await loadUpcoming(t.db, NOW2)).engineers.map((e) => [e.engineerId, e.name]);
      expect(names).toEqual([[2, 'Amy Jones'], [1, 'Dave Smith'], [99, 'Engineer 99'], [null, 'Unassigned']]);
    });

    it('lists a call with no machine, no coordinates and no cached district as unlocated; suggestions by district only', async () => {
      await customer(9, 'Nowhere Ltd', { PostCode: 'ZZ9 9ZZ' });
      await customer(10, 'No postcode', {});
      await unit(1, '2026-04-01T09:00:00Z', { customerId: 9 });
      await unit(2, '2026-04-01T10:00:00Z', { customerId: 10 });
      await unit(3, '2026-04-01T11:00:00Z', { customerId: null });
      await dueMachine(20, 9, { now: NOW2 });
      await dueMachine(21, 7, { now: NOW2 });
      const calls = (await loadUpcoming(t.db, NOW2)).engineers[0]!.days[0]!.calls;
      expect(calls.map((c) => [c.located, c.district])).toEqual([[null, 'ZZ9'], [null, null], [null, null]]);
      expect(calls[0]!.suggestions.map((s) => s.vantageEquipmentId)).toEqual([20]);
      expect(calls[1]!.suggestions).toEqual([]);
      expect(calls[2]!.suggestions).toEqual([]);
    });

    it('parses customer coordinates given as strings or numbers', async () => {
      await customer(11, 'Num', { PostCode: 'GU15 1AA', latitude: 51.3, longitude: -0.74 });
      await unit(1, '2026-04-01T09:00:00Z', { customerId: 11 });
      await unit(2, '2026-04-01T10:00:00Z', { customerId: 7 });
      const calls = (await loadUpcoming(t.db, NOW2)).engineers[0]!.days[0]!.calls;
      expect(calls.map((c) => c.located)).toEqual(['customer', 'customer']);
    });

    it('falls back to the district centroid', async () => {
      await customer(12, 'No coords', { PostCode: 'GU51 1AA' });
      await t.db.insert(postcodeDistricts).values({ district: 'GU51', latitude: 51.28, longitude: -0.83, status: 'ok' });
      await t.db.insert(postcodeDistricts).values({ district: 'GU99', status: 'not_found' });
      await unit(1, '2026-04-01T09:00:00Z', { customerId: 12 });
      expect((await loadUpcoming(t.db, NOW2)).engineers[0]!.days[0]!.calls[0]).toMatchObject({ located: 'district', district: 'GU51' });
    });

    it('suggests due machines near a call and excludes booked, dismissed and other-dealer ones; reports the board column', async () => {
      await customer(13, 'Near Co', { PostCode: 'GU11 1AA', Latitude: '51.30', Longitude: '-0.76' });
      await customer(14, 'Far Co', { PostCode: 'AB10 1AA' });
      await customer(15, 'Dublin', { PostCode: 'D04 EK2K', Latitude: '51.29', Longitude: '-0.75' });
      await unit(1, '2026-04-01T09:00:00Z');
      await dueMachine(30, 13, { now: NOW2 }); // near, suggested
      await dueMachine(31, 14, { now: NOW2 }); // Scotland, far
      await dueMachine(32, 15, { now: NOW2 }); // Irish (other dealer), near
      await dueMachine(33, 13, { now: NOW2 }); // booked
      await dueMachine(34, 13, { now: NOW2 }); // dismissed
      await dueMachine(35, 7, { now: NOW2 }); // same site
      await markPmBooked(t.db, { vantageEquipmentId: 33, bookedFor: new Date('2026-04-10T00:00:00Z'), reference: null, userId, now: NOW2 });
      await dismissPm(t.db, { vantageEquipmentId: 34, reason: 'not_now', note: null, servicedOn: null, userId, now: NOW2 });
      await addToPlan(t.db, { vantageEquipmentIds: [30], userId, now: ago(1, NOW2) });
      await setPriority(t.db, { vantageEquipmentId: 35, on: true, userId, now: ago(1, NOW2) });
      const sug = (await loadUpcoming(t.db, NOW2)).engineers[0]!.days[0]!.calls[0]!.suggestions;
      expect(sug.map((s) => s.vantageEquipmentId)).toEqual([35, 30]);
      expect(sug[0]).toMatchObject({ sameSite: true, priority: true, status: 'overdue', boardColumn: 'to_plan', distanceMiles: 0 });
      expect(sug[1]).toMatchObject({ sameSite: false, customerName: 'Cust 13', boardColumn: 'to_plan', sameDistrict: false });
      expect(sug[1]!.distanceMiles).toBeGreaterThan(0);
    });

    it('a site flagged as ours is suggested even in Ireland', async () => {
      await customer(15, 'Dublin', { PostCode: 'D04 EK2K', Latitude: '51.29', Longitude: '-0.75' });
      await setOtherDealer(t.db, { vantageCustomerId: 15, mode: 'ours', userId });
      await unit(1, '2026-04-01T09:00:00Z');
      await dueMachine(32, 15, { now: NOW2 });
      const sug = (await loadUpcoming(t.db, NOW2)).engineers[0]!.days[0]!.calls[0]!.suggestions;
      expect(sug.map((s) => s.vantageEquipmentId)).toEqual([32]);
    });

    it('lists Field calls only (an Office or Booking unit is not an engineer visit)', async () => {
      await unit(1, '2026-04-01T09:00:00Z');
      await unit(2, '2026-04-01T10:00:00Z', { categoryType: 'Office', categoryName: 'Return to Fit' });
      await unit(3, '2026-04-01T11:00:00Z', { categoryType: 'Booking' });
      await unit(4, '2026-04-01T12:00:00Z', { categoryType: null });
      const calls = (await loadUpcoming(t.db, NOW2)).engineers.flatMap((e) => e.days.flatMap((x) => x.calls));
      expect(calls.map((c) => c.workUnitId)).toEqual([1]);
    });

    it('with PM rows passed in, gives the same result and sees the board sync made just before', async () => {
      await unit(1, '2026-04-01T09:00:00Z');
      await dueMachine(35, 7, { now: NOW2 });
      await dueMachine(36, 7, { now: NOW2 });
      await addToPlan(t.db, { vantageEquipmentIds: [36], userId, now: ago(1, NOW2) });
      // 35 sat in Done past the retention: the board sync drops it off the board
      await moveCard(t.db, { vantageEquipmentId: 35, to: 'done', userId, now: ago(15, NOW2) });
      const rows = await listPmDue(t.db, NOW2, { view: 'all', dealer: 'all' });
      await loadBoard(t.db, NOW2, rows);
      const passed = await loadUpcoming(t.db, NOW2, rows);
      expect(passed).toEqual(await loadUpcoming(t.db, NOW2));
      const sug = passed.engineers[0]!.days[0]!.calls[0]!.suggestions;
      expect(sug.map((s) => [s.vantageEquipmentId, s.boardColumn])).toEqual([
        [35, null],
        [36, 'to_plan'],
      ]);
    });

    it('getScheduledCall names the engineer as the panel does, and is null for a missing or unassigned unit', async () => {
      await unit(1, '2026-04-01T09:00:00Z');
      await unit(2, '2026-04-01T10:00:00Z', { engineerId: 9 });
      await unit(3, '2026-04-01T11:00:00Z', { engineerId: null });
      expect(await getScheduledCall(t.db, 1)).toEqual({ engineerId: 1, engineerName: 'Dave Smith', start: new Date('2026-04-01T09:00:00Z') });
      expect(await getScheduledCall(t.db, 2)).toEqual({ engineerId: 9, engineerName: 'Engineer 9', start: new Date('2026-04-01T10:00:00Z') });
      expect(await getScheduledCall(t.db, 3)).toBeNull();
      expect(await getScheduledCall(t.db, 99)).toBeNull();
    });
  });

  describe('loadUpcoming call location', () => {
    const NOW3 = new Date('2026-04-01T08:00:00Z');
    const callUnit = (id: number, customerId: number | null) =>
      t.db.insert(vantageScheduledUnits).values({ workUnitId: id, workId: id, engineerId: 1, customerId, scheduledStart: new Date('2026-04-01T09:00:00Z'), categoryName: 'Break/fix', categoryType: 'Field', raw: {} });

    it('loadUpcoming returns the call location', async () => {
      await customer(7, 'Acme Ltd', { PostCode: 'GU14 7PR', Latitude: '51.2933', Longitude: '-0.7556' });
      await customer(9, 'Nowhere Ltd', { PostCode: 'ZZ9 9ZZ' });
      await callUnit(1, 7);
      await callUnit(2, 9);
      const calls = (await loadUpcoming(t.db, NOW3)).engineers[0]!.days[0]!.calls;
      expect(calls[0]!.at).toEqual({ lat: 51.2933, lng: -0.7556 });
      expect(calls[1]!.at).toBeNull();
    });
  });

  describe('loadMapPins', () => {
    it('loadMapPins returns due machines with customer location', async () => {
      await customer(7, 'Acme', { PostCode: 'GU14 7PR', Town: 'Farnborough', Latitude: '51.2933', Longitude: '-0.7556' });
      await dueMachine(1, 7);
      const { pins, unlocated } = await loadMapPins(t.db, NOW);
      expect(unlocated).toBe(0);
      expect(pins).toHaveLength(1);
      expect(pins[0]).toMatchObject({ vantageEquipmentId: 1, customerId: 7, serial: 'SER1', district: 'GU14', at: { lat: 51.2933, lng: -0.7556 }, approximate: false, status: 'overdue', town: 'Farnborough' });
    });

    it('falls back to district centre', async () => {
      await customer(12, 'No coords', { PostCode: 'GU51 1AA' });
      await t.db.insert(postcodeDistricts).values({ district: 'GU51', latitude: 51.28, longitude: -0.83, status: 'ok' });
      await dueMachine(1, 12);
      const { pins } = await loadMapPins(t.db, NOW);
      expect(pins[0]).toMatchObject({ at: { lat: 51.28, lng: -0.83 }, approximate: true });
    });

    it('counts machines with no location', async () => {
      await customer(9, 'Nowhere', { PostCode: 'ZZ9 9ZZ' });
      await dueMachine(1, 9);
      const r = await loadMapPins(t.db, NOW);
      expect(r.pins).toEqual([]);
      expect(r.unlocated).toBe(1);
    });

    it('leaves out other dealer, dismissed and booked', async () => {
      await customer(7, 'Acme', { PostCode: 'GU14 7PR', Latitude: '51.29', Longitude: '-0.75' });
      await customer(15, 'Dublin', { PostCode: 'D04 EK2K', Latitude: '51.29', Longitude: '-0.75' });
      await dueMachine(1, 7); // shown
      await dueMachine(2, 15); // other dealer
      await dueMachine(3, 7); // dismissed
      await dueMachine(4, 7); // booked
      await dueMachine(5, 7); // booked and on the board (Booked column)
      await dismissPm(t.db, { vantageEquipmentId: 3, reason: 'not_now', note: null, servicedOn: null, userId, now: NOW });
      await markPmBooked(t.db, { vantageEquipmentId: 4, bookedFor: new Date('2026-12-10T00:00:00Z'), reference: null, userId, now: NOW });
      await addToPlan(t.db, { vantageEquipmentIds: [5], userId, now: ago(1) });
      await markPmBooked(t.db, { vantageEquipmentId: 5, bookedFor: new Date('2026-12-10T00:00:00Z'), reference: null, userId, now: NOW });
      const { pins } = await loadMapPins(t.db, NOW);
      expect(pins.map((p) => p.vantageEquipmentId)).toEqual([1]);
    });

    it('keeps when-in-area machines', async () => {
      await customer(7, 'Acme', { PostCode: 'GU14 7PR', Latitude: '51.29', Longitude: '-0.75' });
      await dueMachine(1, 7);
      await addToPlan(t.db, { vantageEquipmentIds: [1], userId, now: ago(1) });
      await setWhenInArea(t.db, { vantageEquipmentId: 1, on: true, userId, now: ago(1) });
      const { pins } = await loadMapPins(t.db, NOW);
      expect(pins).toHaveLength(1);
      expect(pins[0]!.whenInArea).toBe(true);
    });

    it('sorts priority first, then overdue months, then id', async () => {
      await customer(7, 'Acme', { PostCode: 'GU14 7PR', Latitude: '51.29', Longitude: '-0.75' });
      await dueMachine(2, 7);
      await dueMachine(1, 7);
      await dueMachine(3, 7);
      await setPriority(t.db, { vantageEquipmentId: 3, on: true, userId, now: ago(1) });
      const { pins } = await loadMapPins(t.db, NOW);
      expect(pins.map((p) => p.vantageEquipmentId)).toEqual([3, 1, 2]);
    });
  });
});
