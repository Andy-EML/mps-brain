import { deviceAlarms, deviceLinks, drmsEquipment, replenishmentProposals, vantageEquipment, vantageSalesOrderLines, vantageSalesOrders } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { updateDeviceSettings } from '@mps/db/queries';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot } from './drms-snapshot';
import { orderedInVantage, runReplenishEvaluate } from './replenish-evaluate';

const NOW = new Date('2026-09-21T14:00:00Z');

describe('orderedInVantage', () => {
  const state = (open: { date: string; source?: 'vantage' | 'mps' } | null, completed: string | null = null) => ({
    open: open && { reference: 'SO1', orderDate: new Date(open.date), source: open.source ?? ('vantage' as const) },
    lastCompletedAt: completed ? new Date(completed) : null,
    lastCompletedReference: completed ? 'SO2' : null,
    last: null,
  });
  // 23:30 UTC on 20 Sep is 00:30 on 21 Sep in London (BST): the proposal's day is the 21st.
  const created = new Date('2026-09-20T23:30:00Z');

  it("compares an open order's date with the proposal's London day", () => {
    expect(orderedInVantage(state({ date: '2026-09-21T00:00:00Z' }), created)).toBe('SO1');
    expect(orderedInVantage(state({ date: '2026-09-20T00:00:00Z' }), created)).toBeNull();
  });

  it('ignores our own in-flight orders and completions from before the proposal', () => {
    expect(orderedInVantage(state({ date: '2026-09-22T00:00:00Z', source: 'mps' }), created)).toBeNull();
    expect(orderedInVantage(state(null, '2026-09-20T23:00:00Z'), created)).toBeNull();
    expect(orderedInVantage(state(null, '2026-09-21T08:00:00Z'), created)).toBe('SO2');
  });
});

describe('runReplenishEvaluate', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'colour', status: 'Registered', isColour: true, raw: {} },
      { drmsId: 'mono', status: 'Registered', isColour: false, raw: {} },
      { drmsId: 'loose', status: 'Registered', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([{ vantageId: 1, raw: {} }, { vantageId: 2, raw: {} }]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'colour', vantageEquipmentId: 1, method: 'serial' },
      { drmsEquipmentId: 'mono', vantageEquipmentId: 2, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  const levels = (id: string, counterId: string, k: number, c: number, m = 50, y = 50) =>
    saveSnapshot(t.db, id, {
      CounterId: counterId,
      ReceivedTime: '2026-09-21 09:00:00',
      Counters: [
        { Name: 'BlackTonerLevel', Value: k },
        { Name: 'CyanTonerLevel', Value: c },
        { Name: 'MagentaTonerLevel', Value: m },
        { Name: 'YellowTonerLevel', Value: y },
      ],
      ModeSizeCounters: [],
    } as never, NOW);

  it('proposes low channels for linked devices only, respecting mono', async () => {
    await levels('colour', 'c1', 12, 4);
    await levels('mono', 'm1', 5, 0);
    await levels('loose', 'l1', 1, 1);
    const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.status).toBe('success');
    expect(r.stats).toMatchObject({ proposed: 3, unlinked: 1 });
    const rows = await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.drmsEquipmentId, replenishmentProposals.colour);
    expect(rows.map((p) => [p.drmsEquipmentId, p.colour, p.trigger, p.level, p.threshold, p.status, p.vantageEquipmentId])).toEqual([
      ['colour', 'black', 'threshold', 12, 15, 'pending', 1],
      ['colour', 'cyan', 'threshold', 4, 10, 'pending', 1],
      ['mono', 'black', 'threshold', 5, 15, 'pending', 2],
    ]);
  });

  it('is idempotent: a second run proposes nothing new', async () => {
    await levels('colour', 'c1', 12, 50);
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    const again = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(again.stats).toMatchObject({ proposed: 0, suppressed: 1 });
    expect(await t.db.select().from(replenishmentProposals)).toHaveLength(1);
  });

  it('proposes waste from a ready alarm', async () => {
    await t.db.insert(deviceAlarms).values({
      alarmId: 'w1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'waste',
      status: 'ReadyForErpDelivery', description: 'Waste Toner Bottle Almost Full', raw: {},
    });
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    const [p] = await t.db.select().from(replenishmentProposals);
    expect(p).toMatchObject({ colour: 'waste', trigger: 'alarm', alarmId: 'w1', level: null });
  });

  it('supersedes a pending threshold proposal once the level recovers, or auto-replenish is switched off', async () => {
    await levels('colour', 'c1', 12, 4);
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    await levels('colour', 'c2', 98, 4); // black cartridge replaced
    let r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1 });
    await updateDeviceSettings(t.db, { drmsIds: ['colour'], patch: { autoReplenish: false }, userId: await userId() });
    r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1, autoOff: 1 });
    const live = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.status, 'pending'));
    expect(live).toEqual([]);
  });

  describe('an order appearing in Vantage', () => {
    // The pending proposal is created at NOW (14:00 UTC on 21 Sep); Vantage order dates are date-only.
    async function vantageOrder(id: number, o: { date: string; completed?: string }) {
      await t.db.insert(vantageSalesOrders).values({
        vantageId: id, reference: `SO${id}`, orderDate: new Date(o.date), completedDate: o.completed ? new Date(o.completed) : null,
        vantageEquipmentId: 1, raw: {},
      });
      await t.db.insert(vantageSalesOrderLines).values({ vantageId: id * 10, salesOrderId: id, colour: 'cyan', raw: {} });
    }
    const pendingCyan = async () => {
      await levels('colour', 'c1', 50, 4);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
    };
    const LATER = new Date('2026-09-21T15:20:00Z');
    const cyan = async () =>
      (await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.colour, 'cyan'))).map((p) => [p.status, p.note]);

    it('supersedes a pending proposal when an open Vantage order is dated on or after its day', async () => {
      await pendingCyan();
      await vantageOrder(9, { date: '2026-09-21T00:00:00Z' });
      const r = await runReplenishEvaluate({ db: t.db, now: () => LATER });
      expect(r.stats).toMatchObject({ superseded: 1, proposed: 0 });
      expect(await cyan()).toEqual([['superseded', 'ordered in Vantage (SO9)']]);
    });

    it('supersedes a pending proposal when a Vantage order completes after it was created', async () => {
      await pendingCyan();
      await vantageOrder(8, { date: '2026-09-18T00:00:00Z', completed: '2026-09-21T15:00:00Z' });
      const r = await runReplenishEvaluate({ db: t.db, now: () => LATER });
      expect(r.stats).toMatchObject({ superseded: 1, proposed: 0 });
      expect(await cyan()).toEqual([['superseded', 'ordered in Vantage (SO8)']]);
    });

    it('leaves the proposal pending for an older open order, or one completed before it was created', async () => {
      await pendingCyan();
      await vantageOrder(7, { date: '2026-09-20T00:00:00Z' });
      await vantageOrder(6, { date: '2026-09-01T00:00:00Z', completed: '2026-09-02T10:00:00Z' });
      const r = await runReplenishEvaluate({ db: t.db, now: () => LATER });
      expect(r.stats).toMatchObject({ superseded: 0 });
      expect(await cyan()).toEqual([['pending', null]]);
    });
  });

  async function userId() {
    const { users } = await import('@mps/db');
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    return u!.id;
  }
});
