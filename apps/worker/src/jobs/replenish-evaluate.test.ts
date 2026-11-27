import { replenishmentOrders, users, customerFlags, cartridgeChanges, cartridgeFamilies, cartridgeFamilyModels, siteStockShelves, deviceAlarms, deviceLinks, drmsEquipment, replenishmentProposals, replenishmentSettings, vantageEquipment, vantageSalesOrderLines, vantageSalesOrders } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { approveProposals, computeHolds, hideDevices, unhideDevices, updateDeviceSettings } from '@mps/db/queries';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSnapshot } from './drms-snapshot';

// computeHolds passes through to the real one unless a test makes it throw.
vi.mock('@mps/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mps/db/queries')>();
  return { ...actual, computeHolds: vi.fn(actual.computeHolds) };
});

import { orderedInVantage, runReplenishEvaluate } from './replenish-evaluate';
import { evaluateSiteStock } from './site-stock-evaluate';

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

  describe('Toner Delivery alarms (a cartridge fitted)', () => {
    let seq = 0;
    const alarm = (drmsId: string, at: string, description: string, status = 'ReadyForErpDelivery', category = 'toner') =>
      t.db.insert(deviceAlarms).values({ alarmId: `dl${++seq}`, drmsEquipmentId: drmsId, receivedTime: new Date(at), category, status, description, raw: {} });
    const rows = async () => (await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.id)).map((p) => [p.colour, p.trigger, p.status, p.note]);

    it('raises no proposal from a Delivery alarm, ready for ERP or not, toner or waste', async () => {
      await levels('colour', 'c1', 50, 50);
      await alarm('colour', '2026-09-20T08:00:00Z', 'Toner Delivery(BK)');
      await alarm('colour', '2026-09-20T08:00:00Z', 'Toner Delivery(C)', 'EquipmentDiscovered');
      await alarm('colour', '2026-09-20T08:00:00Z', 'Waste Toner Bottle Delivery', 'ReadyForErpDelivery', 'waste');
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ proposed: 0 });
      expect(await rows()).toEqual([]);
    });

    it('reads a low level as 100% when a Delivery is newer than the reading, so the threshold does not fire', async () => {
      await levels('colour', 'c1', 8, 50); // read 09:00, black far below 15
      await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Delivery(BK)', 'CounterDifferenceNotHighEnough');
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ proposed: 0 });
      expect(await rows()).toEqual([]);
    });

    it('still proposes when the reading is newer than the Delivery', async () => {
      await alarm('colour', '2026-09-21T07:00:00Z', 'Toner Delivery(BK)');
      await levels('colour', 'c1', 8, 50);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await rows()).toEqual([['black', 'threshold', 'pending', null]]);
    });

    it('a Delivery for another colour supersedes nothing: a pending alarm proposal stays, and Near Empty still proposes', async () => {
      await levels('colour', 'c1', 50, 50);
      await alarm('colour', '2026-09-20T08:00:00Z', 'Toner Near Empty(M)');
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Delivery(C)');
      await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Near Empty(Y)');
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await rows()).toEqual([
        ['magenta', 'alarm', 'pending', null],
        ['yellow', 'alarm', 'pending', null],
      ]);
    });

    it('existing recovery rule: a pending threshold proposal is superseded once the effective level reads 100%', async () => {
      await levels('colour', 'c1', 8, 50);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Delivery(BK)');
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ superseded: 1, proposed: 0 });
      expect(await rows()).toEqual([['black', 'threshold', 'superseded', 'level recovered']]);
    });

    describe('a Delivery at or after the alarm (toner already changed)', () => {
      it('raises no alarm proposal when a Delivery follows the Empty, and counts nothing superseded', async () => {
        await levels('colour', 'c1', 50, 50);
        await alarm('colour', '2026-09-21T10:46:00Z', 'Toner Empty(C)');
        await alarm('colour', '2026-09-21T11:28:00Z', 'Toner Delivery(C)', 'CounterDifferenceNotHighEnough');
        await alarm('colour', '2026-09-21T10:46:00Z', 'Waste Toner Bottle Full', 'ReadyForErpDelivery', 'waste');
        await alarm('colour', '2026-09-21T10:46:00Z', 'Toner Near Empty(Y)');
        await alarm('colour', '2026-09-21T10:46:00Z', 'Waste Toner Bottle Delivery', 'ReadyForErpDelivery', 'waste');
        const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
        expect(r.stats).toMatchObject({ proposed: 1, alarmSupersededByDelivery: 0 });
        expect(await rows()).toEqual([['yellow', 'alarm', 'pending', null]]);
      });

      it('supersedes a pending alarm proposal once a later Delivery for its colour arrives, with a dated note', async () => {
        await levels('colour', 'c1', 50, 50);
        await alarm('colour', '2026-09-21T10:46:00Z', 'Toner Empty(C)');
        await alarm('colour', '2026-09-21T10:46:00Z', 'Waste Toner Bottle Almost Full', 'ReadyForErpDelivery', 'waste');
        await alarm('colour', '2026-09-21T10:46:00Z', 'Toner Near Empty(M)');
        await runReplenishEvaluate({ db: t.db, now: () => NOW });
        await alarm('colour', '2026-09-21T11:28:00Z', 'Toner Delivery(C)', 'CounterDifferenceNotHighEnough');
        await alarm('colour', '2026-09-21T12:00:00Z', 'Waste Toner Bottle Delivery', 'EquipmentDiscovered', 'waste');
        const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
        expect(r.stats).toMatchObject({ alarmSupersededByDelivery: 2, superseded: 2, proposed: 0 });
        expect(await rows()).toEqual([
          ['cyan', 'alarm', 'superseded', 'toner changed after alarm (Delivery 2026-09-21)'],
          ['magenta', 'alarm', 'pending', null],
          ['waste', 'alarm', 'superseded', 'toner changed after alarm (Delivery 2026-09-21)'],
        ]);
      });

      it('leaves it pending when the Delivery is older than the alarm, or for another colour', async () => {
        await levels('colour', 'c1', 50, 50);
        await alarm('colour', '2026-09-21T08:00:00Z', 'Toner Delivery(C)');
        await alarm('colour', '2026-09-21T10:46:00Z', 'Toner Empty(C)');
        await alarm('colour', '2026-09-21T10:46:00Z', 'Toner Empty(M)');
        await runReplenishEvaluate({ db: t.db, now: () => NOW });
        await alarm('colour', '2026-09-21T11:28:00Z', 'Toner Delivery(Y)');
        const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
        expect(r.stats).toMatchObject({ alarmSupersededByDelivery: 0 });
        expect(await rows()).toEqual([['cyan', 'alarm', 'pending', null], ['magenta', 'alarm', 'pending', null]]);
      });

      it('falls back to created_at when the proposal has no alarm time, and never touches threshold or approved proposals', async () => {
        await levels('colour', 'c1', 50, 50);
        const mk = (colour: string, over: Partial<typeof replenishmentProposals.$inferInsert>) =>
          t.db.insert(replenishmentProposals).values({
            drmsEquipmentId: 'colour', vantageEquipmentId: 1, colour, trigger: 'alarm', status: 'pending', createdAt: new Date('2026-09-21T10:00:00Z'), ...over,
          });
        await mk('cyan', {}); // no alarm id: created_at 10:00 < Delivery 11:00 -> superseded
        await mk('magenta', { trigger: 'threshold' });
        await mk('yellow', { status: 'approved' });
        await mk('black', { createdAt: new Date('2026-09-21T12:30:00Z') }); // created after the Delivery -> stays
        await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Delivery(C)');
        await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Delivery(M)');
        await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Delivery(Y)');
        await alarm('colour', '2026-09-21T11:00:00Z', 'Waste Toner Bottle Delivery', 'ReadyForErpDelivery', 'waste');
        const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
        expect(r.stats).toMatchObject({ alarmSupersededByDelivery: 1 });
        expect(await rows()).toEqual([
          ['cyan', 'alarm', 'superseded', 'toner changed after alarm (Delivery 2026-09-21)'],
          ['magenta', 'threshold', 'superseded', 'level recovered'], // the existing rule, not the Delivery-after-alarm one
          ['yellow', 'alarm', 'approved', null],
          ['black', 'alarm', 'pending', null],
        ]);
      });
    });

    it('closes an in-progress order for the delivered colour only, and leaves pending Review proposals alone', async () => {
      await levels('colour', 'c1', 8, 4);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
      const [black] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.colour, 'black'));
      const approvedAt = new Date('2026-09-21T10:00:00Z');
      const { orderId } = await approveProposals(t.db, { drmsId: 'colour', items: [{ proposalId: black!.id, quantity: 1 }], userId: u!.id, now: approvedAt });
      await alarm('colour', '2026-09-21T11:00:00Z', 'Toner Delivery(BK)');
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ deliveryClosed: 1 });
      const [order] = await t.db.select().from(replenishmentOrders).where(eq(replenishmentOrders.id, orderId));
      expect(order!.status).toBe('submitted');
      expect(await rows()).toEqual([
        ['black', 'threshold', 'ordered', 'closed by Toner Delivery alarm 2026-09-21'],
        ['cyan', 'threshold', 'pending', null],
      ]);
    });
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

  it('does not drop a same-run alarm proposal for a colour whose threshold proposal just recovered', async () => {
    await levels('colour', 'c1', 12, 50); // black below threshold
    await runReplenishEvaluate({ db: t.db, now: () => NOW }); // pending black threshold proposal
    await levels('colour', 'c2', 98, 50); // black cartridge replaced: recovers
    await t.db.insert(deviceAlarms).values({
      alarmId: 'k1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'toner',
      status: 'ReadyForErpDelivery', description: 'Toner Near Empty(K)', raw: {},
    });
    const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1, proposed: 1 });
    const black = await t.db
      .select()
      .from(replenishmentProposals)
      .where(eq(replenishmentProposals.colour, 'black'))
      .orderBy(replenishmentProposals.id);
    expect(black.map((p) => [p.status, p.trigger, p.note])).toEqual([
      ['superseded', 'threshold', 'level recovered'],
      ['pending', 'alarm', null],
    ]);
  });

  it('runs the spare-black step and reports its stats', async () => {
    await t.db.update(replenishmentSettings).set({ spareBlackFrom: new Date('2026-09-01T00:00:00Z') }).where(eq(replenishmentSettings.scope, 'default'));
    await t.db.update(deviceLinks).set({ linkedAt: new Date('2026-09-02T00:00:00Z') });
    await t.db.insert(deviceAlarms).values({
      alarmId: 'sb1', drmsEquipmentId: 'mono', receivedTime: new Date('2026-09-10T08:00:00Z'), category: 'toner', status: 'Acknowledged', description: 'Toner Empty(K)', raw: {},
    });
    const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ spareChanges: 1, spareProposed: 1, spareCovered: 0, spareIneligible: 0 });
    const rows = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.trigger, 'spare_used'));
    expect(rows.map((p) => [p.drmsEquipmentId, p.colour])).toEqual([['mono', 'black']]);
  });

  it('does not supersede a threshold proposal that covers a recorded cartridge change, even once the level recovers', async () => {
    await t.db.update(replenishmentSettings).set({ spareBlackFrom: new Date('2026-09-01T00:00:00Z') }).where(eq(replenishmentSettings.scope, 'default'));
    await t.db.update(deviceLinks).set({ linkedAt: new Date('2026-09-02T00:00:00Z') });
    await t.db.insert(deviceAlarms).values({
      alarmId: 'sb1', drmsEquipmentId: 'mono', receivedTime: new Date('2026-09-10T08:00:00Z'), category: 'toner', status: 'Acknowledged', description: 'Toner Empty(K)', raw: {},
    });
    await levels('mono', 'm1', 10, 50); // black low: a pending threshold proposal T is raised this run
    const r1 = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r1.stats).toMatchObject({ spareChanges: 1, spareProposed: 0, spareCovered: 1 });
    const [tp] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.drmsEquipmentId, 'mono'));
    expect(tp).toMatchObject({ trigger: 'threshold', status: 'pending' });
    const [chg] = await t.db.select().from(cartridgeChanges);
    expect(chg).toMatchObject({ outcome: 'covered', proposalId: tp!.id });

    await levels('mono', 'm2', 90, 50); // the cartridge is replaced: the level recovers
    const r2 = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r2.stats).toMatchObject({ superseded: 0 });
    const [after] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, tp!.id));
    expect(after).toMatchObject({ status: 'pending', note: null });
  });

  describe('not-fitted holds', () => {
    // Cyan sent 1 Sep, level 10 before it and 4 now: no fit seen, so the cyan threshold proposal is held.
    const cyanAt = (counterId: string, received: string, cyan: number, magenta = 50) =>
      saveSnapshot(t.db, 'colour', {
        CounterId: counterId,
        ReceivedTime: received,
        Counters: [
          { Name: 'BlackTonerLevel', Value: 50 },
          { Name: 'CyanTonerLevel', Value: cyan },
          { Name: 'MagentaTonerLevel', Value: magenta },
          { Name: 'YellowTonerLevel', Value: 50 },
        ],
        ModeSizeCounters: [],
      } as never, NOW);
    const sendCyan = async () => {
      await t.db.insert(vantageSalesOrders).values({ vantageId: 900, reference: 'SO-900', orderDate: new Date('2026-09-01T00:00:00Z'), completedDate: new Date('2026-09-01T00:00:00Z'), vantageEquipmentId: 1, raw: {} });
      await t.db.insert(vantageSalesOrderLines).values({ vantageId: 9001, salesOrderId: 900, colour: 'cyan', quantity: '1', raw: {} });
    };
    const cyanProposal = async () => {
      const [p] = await t.db.select().from(replenishmentProposals).where(and(eq(replenishmentProposals.drmsEquipmentId, 'colour'), eq(replenishmentProposals.colour, 'cyan')));
      return p!;
    };

    it('writes the hold reason onto a pending proposal, and counts it', async () => {
      await sendCyan();
      await cyanAt('h1', '2026-08-20 09:00:00', 10);
      await cyanAt('h2', '2026-09-21 09:00:00', 4);
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ held: 1, holdSet: 1, holdCleared: 0 });
      expect(await cyanProposal()).toMatchObject({ status: 'pending', holdReason: 'not_fitted' });
      expect((await cyanProposal()).holdDetail).toContain('Cyan sent 1 Sep 2026');
      // Unchanged on a second run: nothing is rewritten.
      const r2 = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r2.stats).toMatchObject({ held: 1, holdSet: 0, holdCleared: 0 });
    });

    it('clears the hold on a later run once a rise is seen after the order', async () => {
      await sendCyan();
      await cyanAt('h1', '2026-08-20 09:00:00', 10);
      await cyanAt('h2', '2026-09-21 09:00:00', 4);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      // After the anchor (1 Sep): low, then a rise to 90. The newest reading is low again, so the proposal stays pending.
      await cyanAt('h3', '2026-09-05 09:00:00', 8);
      await cyanAt('h4', '2026-09-10 09:00:00', 90);
      await cyanAt('h5', '2026-09-21 12:00:00', 4);
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ held: 0, holdSet: 0, holdCleared: 1 });
      expect(await cyanProposal()).toMatchObject({ status: 'pending', holdReason: null, holdDetail: null });
    });

    it('clears the hold on a held proposal that has become a cartridge-change cover', async () => {
      await sendCyan();
      await cyanAt('h1', '2026-08-20 09:00:00', 10);
      await cyanAt('h2', '2026-09-21 09:00:00', 4);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      const held = await cyanProposal();
      expect(held.holdReason).toBe('not_fitted');
      await t.db.insert(cartridgeChanges).values({
        drmsEquipmentId: 'colour', colour: 'cyan', changedAt: NOW, source: 'level', outcome: 'covered', proposalId: held.id,
      });
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ held: 0, holdSet: 0, holdCleared: 1 });
      expect(await cyanProposal()).toMatchObject({ status: 'pending', holdReason: null, holdDetail: null });
    });

    it('never holds a spare_used proposal, on data that does hold a threshold proposal', async () => {
      await sendCyan();
      await t.db.insert(vantageSalesOrderLines).values({ vantageId: 9002, salesOrderId: 900, colour: 'magenta', quantity: '1', raw: {} });
      // Cyan (below threshold) and magenta (above it, so no threshold proposal) both show the not-fitted pattern.
      await cyanAt('h1', '2026-08-20 09:00:00', 10, 10);
      await cyanAt('h2', '2026-09-21 09:00:00', 4, 12);
      await t.db.insert(replenishmentProposals).values({
        drmsEquipmentId: 'colour', vantageEquipmentId: 1, colour: 'magenta', trigger: 'spare_used', status: 'pending', createdAt: NOW,
      });
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ held: 1, holdSet: 1 });
      expect(await cyanProposal()).toMatchObject({ trigger: 'threshold', holdReason: 'not_fitted' });
      const [spare] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.trigger, 'spare_used'));
      expect(spare).toMatchObject({ colour: 'magenta', holdReason: null, holdDetail: null });
    });

    it('clears a stale hold left on an out-of-set pending proposal that is not a cover', async () => {
      await t.db.insert(replenishmentProposals).values({
        drmsEquipmentId: 'colour', vantageEquipmentId: 1, colour: 'waste', trigger: 'alarm', status: 'pending', createdAt: NOW,
        holdReason: 'not_fitted', holdDetail: 'left over',
      });
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ held: 0, holdSet: 0, holdCleared: 1 });
      const [w] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.colour, 'waste'));
      expect(w).toMatchObject({ status: 'pending', holdReason: null, holdDetail: null });
    });

    it('does not fail the job when computing holds throws', async () => {
      await sendCyan();
      await cyanAt('h1', '2026-08-20 09:00:00', 10);
      await cyanAt('h2', '2026-09-21 09:00:00', 4);
      // A hold left from an earlier run: a failure falls back to Review, not "hidden as of last run".
      await t.db.insert(replenishmentProposals).values({
        drmsEquipmentId: 'colour', vantageEquipmentId: 1, colour: 'magenta', trigger: 'spare_used', status: 'pending', createdAt: NOW,
        holdReason: 'not_fitted', holdDetail: 'left over',
      });
      vi.mocked(computeHolds).mockRejectedValueOnce(new Error('boom'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.status).toBe('success');
      expect(r.stats).toMatchObject({ proposed: 1, holdError: 'Error: boom' });
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
      const [m] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.colour, 'magenta'));
      expect(m).toMatchObject({ status: 'pending', holdReason: null, holdDetail: null });
      expect(await cyanProposal()).toMatchObject({ status: 'pending', holdReason: null });
    });
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

  describe('site stock', () => {
    async function shelfFor(holdingBlack: number, holdingWaste = 0) {
      const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'Fam', isColour: true }).returning();
      await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub C300i', familyId: fam!.id });
      await t.db.update(drmsEquipment).set({ modelName: 'bizhub C300i' }).where(eq(drmsEquipment.drmsId, 'colour'));
      await t.db.update(vantageEquipment).set({ vantageCustomerId: 100 }).where(eq(vantageEquipment.vantageId, 1));
      const [shelf] = await t.db
        .insert(siteStockShelves)
        .values({ vantageCustomerId: 100, familyId: fam!.id, holdingBlack, holdingWaste, countingFrom: new Date('2026-09-01T00:00:00Z') })
        .returning();
      // The device joins the shelf when it is made, so its alarms from then on count.
      await evaluateSiteStock(t.db, new Date('2026-09-01T00:00:00Z'));
      return shelf!.id;
    }
    const states = async () =>
      (await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.id)).map((p) => [p.colour, p.trigger, p.status, p.note]);

    it('supersedes a pending threshold proposal for a covered colour, and stops proposing it', async () => {
      await levels('colour', 'c1', 12, 50);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      await shelfFor(3);
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ superseded: 1, proposed: 0, siteStockShelves: 1 });
      expect(await states()).toEqual([['black', 'threshold', 'superseded', 'covered by site stock']]);
    });

    it('a Delivery for a colour the shelf holds is a shelf use and raises the top-up, with no device proposal', async () => {
      await shelfFor(1);
      await levels('colour', 'c1', 50, 50);
      await t.db.insert(deviceAlarms).values({
        alarmId: 'sd1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'toner',
        status: 'CounterDifferenceNotHighEnough', description: 'Toner Delivery(BK)', raw: {},
      });
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW, deliveryFrom: new Date('2026-09-01T00:00:00Z') });
      expect(r.stats).toMatchObject({ siteStockCounted: 1, siteStockTopUps: 1 });
      expect(await states()).toEqual([['black', 'site_stock', 'pending', null]]);
    });

    it('a Delivery for a colour the shelf does not hold orders nothing', async () => {
      await shelfFor(1); // holds black only
      await levels('colour', 'c1', 50, 50);
      await t.db.insert(deviceAlarms).values({
        alarmId: 'sd2', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'toner',
        status: 'ReadyForErpDelivery', description: 'Toner Delivery(C)', raw: {},
      });
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([]);
    });

    it('still proposes a colour the shelf does not hold', async () => {
      await shelfFor(3, 0);
      await t.db.insert(deviceAlarms).values({
        alarmId: 'w1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'waste',
        status: 'ReadyForErpDelivery', description: 'Waste Toner Bottle Almost Full', raw: {},
      });
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([['waste', 'alarm', 'pending', null]]);
    });

    it('proposes normally again once the device moves to another customer', async () => {
      await shelfFor(3);
      await levels('colour', 'c1', 12, 50);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([]);
      await t.db.update(vantageEquipment).set({ vantageCustomerId: 200 }).where(eq(vantageEquipment.vantageId, 1));
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([['black', 'threshold', 'pending', null]]);
    });

    it('leaves a shelf top-up alone in the device loop', async () => {
      await shelfFor(1);
      await t.db.insert(deviceAlarms).values({
        alarmId: 'k1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-03T08:00:00Z'), category: 'toner',
        status: 'ReadyForErpDelivery', description: 'Toner Empty(BK)', raw: {},
      });
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([['black', 'site_stock', 'pending', null]]);
    });

    const live = async () => (await t.db.select().from(replenishmentProposals)).filter((p) => p.status === 'pending' || p.status === 'approved');
    async function pendingTopUp() {
      const shelfId = await shelfFor(1);
      await levels('colour', 'c1', 12, 50);
      await t.db.insert(deviceAlarms).values({
        alarmId: 'k1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-03T08:00:00Z'), category: 'toner',
        status: 'ReadyForErpDelivery', description: 'Toner Empty(BK)', raw: {},
      });
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([['black', 'site_stock', 'pending', null]]);
      return shelfId;
    }

    it('supersedes a pending top-up when the shelf stops holding the colour, and the device proposes it instead', async () => {
      const shelfId = await pendingTopUp();
      await t.db.update(siteStockShelves).set({ holdingBlack: 0 }).where(eq(siteStockShelves.id, shelfId));
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([
        ['black', 'site_stock', 'superseded', 'no longer held'],
        ['black', 'threshold', 'pending', null],
      ]);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await live()).toHaveLength(1);
    });

    it('counts an approved top-up as live for its device, so the device proposes nothing alongside it', async () => {
      const shelfId = await pendingTopUp();
      await t.db.update(replenishmentProposals).set({ status: 'approved' });
      await t.db.update(siteStockShelves).set({ holdingBlack: 0 }).where(eq(siteStockShelves.id, shelfId));
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await states()).toEqual([['black', 'site_stock', 'approved', null]]);
    });
  });

  describe('self-managed customers', () => {
    const selfManage = async (on = true) => {
      await t.db.update(vantageEquipment).set({ vantageCustomerId: 100 }).where(eq(vantageEquipment.vantageId, 1));
      await t.db.insert(customerFlags).values({ vantageCustomerId: 100, selfManaged: on }).onConflictDoUpdate({ target: customerFlags.vantageCustomerId, set: { selfManaged: on } });
    };
    const readyNearEmpty = () =>
      t.db.insert(deviceAlarms).values({
        alarmId: 'sm1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'toner',
        status: 'ReadyForErpDelivery', description: 'Toner Near Empty(K)', raw: {},
      });
    const colourProposals = () => t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.drmsEquipmentId, 'colour'));

    it('proposes nothing for a self-managed device below threshold with a Ready alarm, and counts it', async () => {
      await selfManage();
      await levels('colour', 'c1', 12, 4);
      await readyNearEmpty();
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ selfManaged: 1, proposed: 0 });
      expect(await colourProposals()).toEqual([]);
    });

    it('a device-level autoReplenish = true override does not beat the customer flag', async () => {
      await selfManage();
      await updateDeviceSettings(t.db, { drmsIds: ['colour'], patch: { autoReplenish: true }, userId: await userId() });
      await levels('colour', 'c1', 12, 4);
      await readyNearEmpty();
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ selfManaged: 1, proposed: 0 });
      expect(await colourProposals()).toEqual([]);
    });

    it('supersedes a pending proposal on a self-managed device and reports it', async () => {
      await levels('colour', 'c1', 12, 4);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect((await colourProposals()).map((p) => p.status)).toEqual(['pending', 'pending']);
      await selfManage();
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ selfManaged: 1, selfManagedSuperseded: 2, proposed: 0 });
      expect((await colourProposals()).map((p) => [p.status, p.note])).toEqual([['superseded', 'customer self-managed'], ['superseded', 'customer self-managed']]);
    });

    it('Review Focus 4: turning the flag off does not back-fill, the next run proposes from current levels', async () => {
      await selfManage();
      await levels('colour', 'c1', 12, 4);
      await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(await colourProposals()).toEqual([]);
      await selfManage(false);
      const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
      expect(r.stats).toMatchObject({ selfManaged: 0, proposed: 2 });
      expect((await colourProposals()).map((p) => [p.colour, p.status])).toEqual([['black', 'pending'], ['cyan', 'pending']]);
    });
  });

  async function userId() {
    const { users } = await import('@mps/db');
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    return u!.id;
  }
});

describe('runReplenishEvaluate with hidden devices', () => {
  let t: TestDb;
  let userId: number;
  beforeEach(async () => {
    t = await createTestDb();
    const [user] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
    userId = user!.id;
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'shown', status: 'Registered', isColour: false, raw: {} },
      { drmsId: 'hidden', status: 'Registered', isColour: false, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([{ vantageId: 1, raw: {} }, { vantageId: 2, raw: {} }]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'shown', vantageEquipmentId: 1, method: 'serial' },
      { drmsEquipmentId: 'hidden', vantageEquipmentId: 2, method: 'serial' },
    ]);
    for (const id of ['shown', 'hidden']) {
      await saveSnapshot(t.db, id, {
        CounterId: `${id}-1`,
        ReceivedTime: '2026-09-21 09:00:00',
        Counters: [{ Name: 'BlackTonerLevel', Value: 3 }],
        ModeSizeCounters: [],
      } as never, NOW);
    }
  });
  afterEach(() => t.close());

  it('proposes nothing for a hidden device', async () => {
    await hideDevices(t.db, { drmsIds: ['hidden'], userId, now: NOW });
    const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ devices: 1, proposed: 1 });
    const rows = await t.db.select().from(replenishmentProposals);
    expect(rows.map((p) => p.drmsEquipmentId)).toEqual(['shown']);
  });

  it('supersedes a pending proposal left on a hidden device, and proposes again once unhidden', async () => {
    await hideDevices(t.db, { drmsIds: ['hidden'], userId, now: NOW });
    // As if a run that overlapped the hide had raised it.
    await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: 'hidden', colour: 'black', trigger: 'threshold', status: 'pending', createdAt: NOW });
    const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1 });
    const [left] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.drmsEquipmentId, 'hidden'));
    expect(left).toMatchObject({ status: 'superseded', note: 'device hidden' });

    await unhideDevices(t.db, { drmsIds: ['hidden'], userId, now: NOW });
    const again = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(again.stats).toMatchObject({ devices: 2, proposed: 1 });
    const live = await t.db
      .select()
      .from(replenishmentProposals)
      .where(and(eq(replenishmentProposals.drmsEquipmentId, 'hidden'), eq(replenishmentProposals.status, 'pending')));
    expect(live).toHaveLength(1);
  });
});
