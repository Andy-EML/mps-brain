import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  siteStockEvents,
  siteStockShelves,
  vantageEquipment,
} from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot } from './drms-snapshot';
import { evaluateSiteStock } from './site-stock-evaluate';

const NOW = new Date('2026-09-21T12:00:00Z');

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
  });
  afterEach(() => t.close());

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

  it('covers nothing for a device that is not on a shelf', async () => {
    await t.db.update(deviceLinks).set({ unlinkedAt: NOW });
    const { covered } = await evaluateSiteStock(t.db, NOW);
    expect(covered.size).toBe(0);
  });
});
