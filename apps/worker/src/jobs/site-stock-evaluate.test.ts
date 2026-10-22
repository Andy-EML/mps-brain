import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  siteStockEvents,
  siteStockMembers,
  siteStockShelves,
  vantageEquipment,
} from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot } from './drms-snapshot';
import { evaluateSiteStock } from './site-stock-evaluate';

const NOW = new Date('2026-09-21T12:00:00Z');
const COUNTING_FROM = new Date('2026-09-01T00:00:00Z');


describe('evaluateSiteStock', () => {
  let t: TestDb;
  let shelfId: number;
  let seq = 0;

  beforeEach(async () => {
    seq = 0;
    t = await createTestDb();
    const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'C-series', isColour: true }).returning();
    await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub C300i', familyId: fam!.id });
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'dA', modelName: 'bizhub C300i', status: 'Registered', isColour: true, raw: {} },
      { drmsId: 'dB', modelName: 'bizhub C300i', status: 'Registered', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 1, vantageCustomerId: 100, raw: {} },
      { vantageId: 2, vantageCustomerId: 100, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'dA', vantageEquipmentId: 1, method: 'serial' },
      { drmsEquipmentId: 'dB', vantageEquipmentId: 2, method: 'serial' },
    ]);
    const [shelf] = await t.db
      .insert(siteStockShelves)
      .values({ vantageCustomerId: 100, familyId: fam!.id, holdingBlack: 3, holdingCyan: 2, holdingMagenta: 2, holdingYellow: 2, countingFrom: new Date('2026-09-01T00:00:00Z') })
      .returning();
    shelfId = shelf!.id;
    await join(COUNTING_FROM);
  });
  afterEach(() => t.close());

  /** A run with no new alarms: records today's members as joining the shelf at `at`. */
  const join = (at: Date) => evaluateSiteStock(t.db, at);

  const alarm = (drmsId: string, at: string, description: string, status = 'ReadyForErpDelivery') =>
    t.db.insert(deviceAlarms).values({
      alarmId: `a${++seq}`, drmsEquipmentId: drmsId, receivedTime: new Date(`${at}Z`.replace(' ', 'T')), category: 'toner', status, description, raw: {},
    });
  const reading = (drmsId: string, at: string, black: number) =>
    saveSnapshot(t.db, drmsId, {
      CounterId: `r${++seq}`, ReceivedTime: at, Counters: [{ Name: 'BlackTonerLevel', Value: black }], ModeSizeCounters: [],
    } as never, NOW);
  const shelf = async () => (await t.db.select().from(siteStockShelves))[0]!;
  const events = () => t.db.select().from(siteStockEvents).orderBy(siteStockEvents.receivedAt);

  it('counts the three blacks, one cyan and one yellow, then raises one top-up on the third black device', async () => {
    await alarm('dA', '2026-09-05 08:00:00', 'Toner Empty(BK)');
    await alarm('dB', '2026-09-08 08:00:00', 'Toner Empty(BK)');
    await alarm('dB', '2026-09-09 08:00:00', 'Toner Empty(C)');
    await alarm('dA', '2026-09-10 08:00:00', 'Toner Empty(Y)');
    await reading('dA', '2026-09-11 02:00:00', 95);
    await alarm('dA', '2026-09-12 08:00:00', 'Toner Empty(BK)');

    const { stats, covered } = await evaluateSiteStock(t.db, NOW);
    expect(stats).toEqual({ shelves: 1, considered: 5, counted: 5, topUps: 3 });
    expect([...covered.get('dA')!].sort()).toEqual(['black', 'cyan', 'magenta', 'yellow']);
    expect(await shelf()).toMatchObject({ usedBlack: 3, usedCyan: 1, usedYellow: 1, usedMagenta: 0 });
    const rows = await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.colour);
    expect(rows.map((p) => [p.colour, p.quantity, p.trigger, p.shelfId, p.drmsEquipmentId, p.vantageEquipmentId, p.status, p.alarmDescription])).toEqual([
      ['black', 3, 'site_stock', shelfId, 'dA', 1, 'pending', 'Toner Empty(BK)'],
      ['cyan', 1, 'site_stock', shelfId, 'dA', 1, 'pending', 'Toner Empty(BK)'],
      ['yellow', 1, 'site_stock', shelfId, 'dA', 1, 'pending', 'Toner Empty(BK)'],
    ]);
    expect((await events()).find((e) => e.drmsEquipmentId === 'dA' && e.receivedAt.getUTCDate() === 12)?.reason).toBe('fresh_cartridge');
  });

  it('counts a repeated empty once when there is no reading between', async () => {
    await alarm('dA', '2026-09-05 08:00:00', 'Toner Empty(BK)');
    await alarm('dA', '2026-09-09 08:00:00', 'Toner Empty(BK)');
    const { stats } = await evaluateSiteStock(t.db, NOW);
    expect(stats).toMatchObject({ considered: 2, counted: 1, topUps: 0 });
    expect((await events()).map((e) => [e.counted, e.reason])).toEqual([[true, 'first'], [false, 'repeat']]);
    expect(await shelf()).toMatchObject({ usedBlack: 1 });
  });

  it('ignores alarms before counting_from, warnings and colours with no holding, and counts any DRMS status', async () => {
    await alarm('dA', '2026-08-30 08:00:00', 'Toner Empty(BK)');
    await alarm('dA', '2026-09-05 08:00:00', 'Toner Near Empty(BK)');
    await alarm('dA', '2026-09-06 08:00:00', 'Waste Toner Bottle Full'); // holding_waste is 0
    await alarm('dB', '2026-09-07 08:00:00', 'Toner Empty(BK)', 'NoAlarmFilterHierarchyFound');
    const { stats } = await evaluateSiteStock(t.db, NOW);
    expect(stats).toMatchObject({ considered: 1, counted: 1 });
    expect(await events()).toHaveLength(1);
    expect(await shelf()).toMatchObject({ usedBlack: 1, usedWaste: 0 });
    expect(await t.db.select().from(replenishmentProposals)).toEqual([]);
  });

  it('ignores cyan, magenta and yellow empties on a mono family (no event row)', async () => {
    const [mono] = await t.db.insert(cartridgeFamilies).values({ name: 'Mono', isColour: false }).returning();
    await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub 301i', familyId: mono!.id });
    await t.db.insert(drmsEquipment).values({ drmsId: 'dC', modelName: 'bizhub 301i', status: 'Registered', raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 3, vantageCustomerId: 100, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dC', vantageEquipmentId: 3, method: 'serial' });
    await t.db.insert(siteStockShelves).values({ vantageCustomerId: 100, familyId: mono!.id, holdingBlack: 2, holdingCyan: 2, countingFrom: new Date('2026-09-01T00:00:00Z') });
    await join(COUNTING_FROM);
    await alarm('dC', '2026-09-05 08:00:00', 'Toner Empty(C)');
    const { stats, covered } = await evaluateSiteStock(t.db, NOW);
    expect(stats).toMatchObject({ considered: 0, counted: 0 });
    expect(await events()).toEqual([]);
    expect([...covered.get('dC')!]).toEqual(['black']);
  });

  it('does not re-raise a rejected top-up until a further use is counted', async () => {
    for (const d of ['2026-09-01', '2026-09-16', '2026-10-01']) await alarm('dA', `${d} 08:00:00`, 'Toner Empty(BK)');
    await evaluateSiteStock(t.db, new Date('2026-10-02T00:00:00Z'));
    await t.db.update(replenishmentProposals).set({ status: 'rejected', decidedAt: new Date('2026-10-02T06:00:00Z') });
    const same = await evaluateSiteStock(t.db, new Date('2026-10-03T00:00:00Z'));
    expect(same.stats.topUps).toBe(0);
    expect(await t.db.select().from(replenishmentProposals)).toHaveLength(1);
    await alarm('dB', '2026-10-03 09:00:00', 'Toner Empty(BK)');
    const again = await evaluateSiteStock(t.db, new Date('2026-10-04T00:00:00Z'));
    expect(again.stats).toMatchObject({ counted: 1, topUps: 1 });
    const live = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.status, 'pending'));
    expect(live.map((p) => [p.colour, p.quantity, p.drmsEquipmentId])).toEqual([['black', 4, 'dB']]);
  });

  it('puts the top-up on a device still on the shelf when the triggering device has left', async () => {
    await t.db.update(siteStockShelves).set({ holdingBlack: 4 });
    await alarm('dB', '2026-09-01 08:00:00', 'Toner Empty(BK)');
    await alarm('dB', '2026-09-16 08:00:00', 'Toner Empty(BK)');
    await alarm('dA', '2026-10-01 08:00:00', 'Toner Empty(BK)');
    await evaluateSiteStock(t.db, new Date('2026-10-02T00:00:00Z'));
    expect(await shelf()).toMatchObject({ usedBlack: 3 });
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW }).where(eq(deviceLinks.drmsEquipmentId, 'dA'));
    await t.db.update(siteStockShelves).set({ holdingBlack: 3 });
    const r = await evaluateSiteStock(t.db, new Date('2026-10-03T00:00:00Z'));
    expect(r.stats.topUps).toBe(1);
    const [p] = await t.db.select().from(replenishmentProposals);
    expect(p).toMatchObject({ drmsEquipmentId: 'dB', vantageEquipmentId: 2 });
  });

  it('is idempotent', async () => {
    for (const d of ['2026-09-01', '2026-09-16', '2026-10-01']) await alarm('dA', `${d} 08:00:00`, 'Toner Empty(BK)');
    await evaluateSiteStock(t.db, NOW);
    const before = await shelf();
    const again = await evaluateSiteStock(t.db, NOW);
    expect(again.stats).toMatchObject({ considered: 0, counted: 0, topUps: 0 });
    expect(await shelf()).toEqual(before);
    expect(await t.db.select().from(replenishmentProposals)).toHaveLength(1);
  });

  it('keeps counting while a top-up is pending but raises no second one', async () => {
    // 3 blacks 7+ days apart with no readings: only the first counts; use 15-day gaps to count all.
    for (const d of ['2026-09-01', '2026-09-16', '2026-10-01']) await alarm('dA', `${d} 08:00:00`, 'Toner Empty(BK)');
    await evaluateSiteStock(t.db, new Date('2026-10-02T00:00:00Z'));
    expect(await t.db.select().from(replenishmentProposals)).toHaveLength(1);
    await alarm('dB', '2026-10-02 09:00:00', 'Toner Empty(BK)');
    const again = await evaluateSiteStock(t.db, new Date('2026-10-03T00:00:00Z'));
    expect(again.stats).toMatchObject({ counted: 1, topUps: 0 });
    expect(await shelf()).toMatchObject({ usedBlack: 4 });
    expect(await t.db.select().from(replenishmentProposals)).toHaveLength(1);
  });

  it('moves a pending top-up off a device that has left the shelf onto one still on it', async () => {
    for (const d of ['2026-09-01', '2026-09-16', '2026-10-01']) await alarm('dA', `${d} 08:00:00`, 'Toner Empty(BK)');
    await evaluateSiteStock(t.db, new Date('2026-10-02T00:00:00Z'));
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW }).where(eq(deviceLinks.drmsEquipmentId, 'dA'));
    const r = await evaluateSiteStock(t.db, new Date('2026-10-03T00:00:00Z'));
    expect(r.stats.topUps).toBe(1);
    const rows = await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.id);
    expect(rows.map((p) => [p.drmsEquipmentId, p.colour, p.quantity, p.status, p.note])).toEqual([
      ['dA', 'black', 3, 'superseded', 'no longer on shelf'],
      ['dB', 'black', 3, 'pending', null],
    ]);
    expect(await shelf()).toMatchObject({ usedBlack: 3 });
  });

  it('supersedes a cyan top-up and raises none once the family is mono', async () => {
    await t.db.update(siteStockShelves).set({ usedCyan: 2 });
    await evaluateSiteStock(t.db, NOW);
    expect((await t.db.select().from(replenishmentProposals)).map((p) => [p.colour, p.status])).toEqual([['cyan', 'pending']]);
    await t.db.update(cartridgeFamilies).set({ isColour: false });
    const r = await evaluateSiteStock(t.db, NOW);
    expect(r.stats.topUps).toBe(0);
    expect((await t.db.select().from(replenishmentProposals)).map((p) => [p.colour, p.status, p.note])).toEqual([['cyan', 'superseded', 'no longer held']]);
  });

  describe('membership start', () => {
    async function addDevice(drmsId: string, model: string, vantageId: number, customer: number) {
      await t.db.insert(drmsEquipment).values({ drmsId, modelName: model, status: 'Registered', isColour: true, raw: {} });
      await t.db.insert(vantageEquipment).values({ vantageId, vantageCustomerId: customer, raw: {} });
      await t.db.insert(deviceLinks).values({ drmsEquipmentId: drmsId, vantageEquipmentId: vantageId, method: 'serial' });
    }

    it('does not count Empties from before a model joined the family, but counts later ones', async () => {
      await addDevice('dD', 'bizhub C250i', 4, 100);
      await alarm('dD', '2026-09-05 08:00:00', 'Toner Empty(BK)');
      await evaluateSiteStock(t.db, new Date('2026-09-10T00:00:00Z'));
      const [fam] = await t.db.select().from(cartridgeFamilies);
      await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub C250i', familyId: fam!.id });
      const joined = await evaluateSiteStock(t.db, new Date('2026-09-12T00:00:00Z'));
      expect(joined.stats).toMatchObject({ considered: 0, counted: 0 });
      expect(await events()).toEqual([]);
      await alarm('dD', '2026-09-13 08:00:00', 'Toner Empty(BK)');
      const later = await evaluateSiteStock(t.db, new Date('2026-09-14T00:00:00Z'));
      expect(later.stats).toMatchObject({ considered: 1, counted: 1 });
      expect(await shelf()).toMatchObject({ usedBlack: 1 });
    });

    it('does not count an Empty again on the shelf a device is relinked to', async () => {
      const [fam] = await t.db.select().from(cartridgeFamilies);
      const [b] = await t.db
        .insert(siteStockShelves)
        .values({ vantageCustomerId: 200, familyId: fam!.id, holdingBlack: 3, countingFrom: COUNTING_FROM })
        .returning();
      await alarm('dA', '2026-09-05 08:00:00', 'Toner Empty(BK)');
      await evaluateSiteStock(t.db, new Date('2026-09-06T00:00:00Z'));

      await t.db.insert(vantageEquipment).values({ vantageId: 5, vantageCustomerId: 200, raw: {} });
      await t.db.update(deviceLinks).set({ unlinkedAt: new Date('2026-09-07T00:00:00Z') }).where(eq(deviceLinks.drmsEquipmentId, 'dA'));
      await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dA', vantageEquipmentId: 5, method: 'serial' });
      const moved = await evaluateSiteStock(t.db, new Date('2026-09-07T00:00:00Z'));
      expect(moved.stats).toMatchObject({ considered: 0, counted: 0 });
      const rows = await t.db.select().from(siteStockShelves).orderBy(siteStockShelves.id);
      expect(rows.map((r) => [r.id, r.usedBlack])).toEqual([[shelfId, 1], [b!.id, 0]]);
      const dA = (await t.db.select().from(siteStockMembers)).filter((m) => m.drmsEquipmentId === 'dA');
      expect(dA.map((m) => [m.shelfId, m.since])).toEqual([[b!.id, new Date('2026-09-07T00:00:00Z')]]);
    });
  });

  it('covers nothing for a device that is not on a shelf', async () => {
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW });
    const { covered } = await evaluateSiteStock(t.db, NOW);
    expect(covered.size).toBe(0);
  });
});
