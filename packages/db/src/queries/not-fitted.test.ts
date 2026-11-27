import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  vantageEquipment,
  vantageMeterReadings,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { computeHolds, type HoldCandidate } from './not-fitted';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const NOW = d('2026-03-12');
const when = (iso: string) => (iso.length > 10 ? new Date(iso) : d(iso));

describe('computeHolds', () => {
  let t: TestDb;
  let sn = 0;
  let lineSeq = 0;
  let readingSeq = 0;

  beforeEach(async () => {
    t = await createTestDb();
    sn = 0;
    lineSeq = 0;
    readingSeq = 0;
    const [fam] = await t.db
      .insert(cartridgeFamilies)
      .values({ name: 'C300 family', isColour: true, ratedYieldBlack: 20_000, ratedYieldCyan: 20_000 })
      .returning();
    await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub C300i', familyId: fam!.id });
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'col', modelName: 'bizhub C300i', serial: 'S1', isColour: true, raw: {} },
      { drmsId: 'unlinked', modelName: 'bizhub C300i', serial: 'S3', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([{ vantageId: 100, raw: {} }]);
    await t.db.insert(deviceLinks).values([{ drmsEquipmentId: 'col', vantageEquipmentId: 100, method: 'serial' }]);
  });
  afterEach(() => t.close());

  async function snap(drmsId: string, at: string, values: Record<string, number>) {
    const [s] = await t.db
      .insert(counterSnapshots)
      .values({ drmsEquipmentId: drmsId, counterId: `c${++sn}`, receivedTime: when(at), fetchedAt: when(at), raw: {} })
      .returning();
    await t.db.insert(counterValues).values(Object.entries(values).map(([name, value]) => ({ snapshotId: s!.id, name, value })));
  }
  const level = (at: string, v: number) => snap('col', at, { CyanTonerLevel: v });
  const meter = (at: string, colour: number) => snap('col', at, { 'Black:Total': 0, 'Full Color:Total': colour });
  const vantageReading = (at: string, value: number) =>
    t.db.insert(vantageMeterReadings).values({ vantageId: ++readingSeq, vantageEquipmentId: 100, meterTypeId: 2, readingAt: d(at), reading: value, raw: {} });
  async function order(
    soId: number,
    iso: string,
    completed: string | null,
    lines: { colour: string; quantity?: string | null; equipment?: number | null; returned?: boolean }[],
    opts: { deleted?: boolean; headerEquipment?: number | null; createdAt?: string } = {},
  ) {
    await t.db.insert(vantageSalesOrders).values({
      vantageId: soId,
      reference: `SO-${soId}`,
      orderDate: when(iso),
      completedDate: completed ? when(completed) : null,
      vantageEquipmentId: opts.headerEquipment === undefined ? 100 : opts.headerEquipment,
      deletedDate: opts.deleted ? d(iso) : null,
      raw: opts.createdAt ? { CreatedDate: opts.createdAt } : {},
    });
    for (const l of lines) {
      await t.db.insert(vantageSalesOrderLines).values({
        vantageId: ++lineSeq,
        salesOrderId: soId,
        colour: l.colour,
        quantity: l.quantity === undefined ? '1' : l.quantity,
        vantageEquipmentId: l.equipment ?? null,
        returnedDate: l.returned ? d(iso) : null,
        raw: {},
      });
    }
  }
  const cand = (id: number, drms = 'col', colour: HoldCandidate['colour'] = 'cyan'): HoldCandidate => ({ id, drmsEquipmentId: drms, colour });

  it('holds as not_fitted when levels span the order and no fit is seen', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
    const holds = await computeHolds(t.db, [cand(1)], NOW);
    expect(holds.get(1)).toMatchObject({ reason: 'not_fitted' });
    expect(holds.get(1)!.detail).toContain('Cyan sent 1 Feb 2026 (SO-1)');
  });

  describe('Toner Delivery alarms', () => {
    let alarmSeq = 0;
    const delivery = (at: string, description = 'Toner Delivery(C)', status = 'EquipmentDiscovered') =>
      t.db.insert(deviceAlarms).values({ alarmId: `h${++alarmSeq}`, drmsEquipmentId: 'col', receivedTime: when(at), description, status, category: 'toner', raw: {} });

    it('releases a not_fitted hold when a Delivery arrives after the order, with no level rise seen', async () => {
      await meter('2026-03-10', 5_000);
      await level('2026-01-28', 10);
      await level('2026-03-05', 8);
      await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
      expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toMatchObject({ reason: 'not_fitted' });
      await delivery('2026-02-10T09:00:00Z');
      expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
    });
    it('ignores a Delivery from before the order, or for another colour', async () => {
      await meter('2026-03-10', 5_000);
      await level('2026-01-28', 10);
      await level('2026-03-05', 8);
      await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
      await delivery('2026-01-20T09:00:00Z');
      await delivery('2026-02-10T09:00:00Z', 'Toner Delivery(K)');
      expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toMatchObject({ reason: 'not_fitted' });
    });
    it('counts Deliveries from the moment the order was created, not midnight of its date', async () => {
      await meter('2026-03-10', 5_000);
      await level('2026-01-28', 10);
      await level('2026-03-05', 8);
      await order(1, '2026-02-01', null, [{ colour: 'cyan' }], { createdAt: '2026-02-01T14:00:00Z' });
      await delivery('2026-02-01T09:00:00Z'); // the same day, before the order existed: not its fit
      expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toMatchObject({ reason: 'not_fitted' });
      await delivery('2026-02-06T16:00:00Z'); // a later one, clear of the 3-day dedupe, is its fit
      expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
    });
    it('a two-cartridge order with one Delivery is still held for the spare', async () => {
      await meter('2026-03-10', 5_000);
      await level('2026-01-28', 10);
      await level('2026-03-05', 8);
      await order(1, '2026-02-01', null, [{ colour: 'cyan', quantity: '2' }]);
      await delivery('2026-02-10T09:00:00Z');
      const h = (await computeHolds(t.db, [cand(1)], NOW)).get(1);
      expect(h).toMatchObject({ reason: 'not_fitted' });
      expect(h!.detail).toContain('1 fitted since');
    });
  });

  it('releases once a fit is seen after the order', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 90);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
  });

  it('holds as low_yield from Vantage readings either side of the order (interpolated, "~")', async () => {
    await vantageReading('2026-01-25', 1_000);
    await vantageReading('2026-03-10', 3_000);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
    const hold = (await computeHolds(t.db, [cand(1)], NOW)).get(1)!;
    expect(hold.reason).toBe('low_yield');
    expect(hold.detail.startsWith('~')).toBe(true);
    expect(hold.detail).toContain('pages since cyan sent 1 Feb 2026');
  });

  it('no low_yield hold when the newest meter is stale', async () => {
    await vantageReading('2026-01-25', 1_000);
    await vantageReading('2026-02-20', 1_500);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
  });

  it('anchors on order_date, not completed_date: a rise after the order date counts as fitted', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-02-08', 90); // after order_date, before completed_date (completion lags delivery)
    await level('2026-02-11', 85);
    await order(1, '2026-02-01', '2026-02-10', [{ colour: 'cyan' }]);
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
  });

  it('sums quantity across the anchor group: two lines, one fit, still held', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 90);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }, { colour: 'cyan' }]);
    const hold = (await computeHolds(t.db, [cand(1)], NOW)).get(1)!;
    expect(hold.reason).toBe('not_fitted');
    expect(hold.detail).toContain('2 cyan sent');
  });

  it('the newest anchor wins over older orders', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-02-10', 90); // fit for the January order only
    await level('2026-02-28', 85);
    await order(1, '2026-01-20', null, [{ colour: 'cyan' }]);
    await order(2, '2026-02-25', null, [{ colour: 'cyan' }]);
    const hold = (await computeHolds(t.db, [cand(1)], NOW)).get(1)!;
    expect(hold.reason).toBe('not_fitted');
    expect(hold.detail).toContain('25 Feb 2026');
  });

  it('groups by London day of order_date: two orders on the same day are one last order, N=2', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-02-01T09:00:00Z', null, [{ colour: 'cyan' }]);
    await order(2, '2026-02-01T15:00:00Z', null, [{ colour: 'cyan' }]);
    const hold = (await computeHolds(t.db, [cand(1)], NOW)).get(1)!;
    expect(hold.reason).toBe('not_fitted');
    expect(hold.detail).toContain('2 cyan sent 1 Feb 2026');
  });

  it('quantity sums only that day: an earlier order is not part of the last order', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 90);
    await order(1, '2026-01-20', null, [{ colour: 'cyan' }]);
    await order(2, '2026-02-01', null, [{ colour: 'cyan' }]);
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull(); // N=1, one fit
  });

  it('ignores a deleted order', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }], { deleted: true });
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
  });

  it('ignores a returned line', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-02-01', null, [{ colour: 'cyan', returned: true }]);
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
  });

  it('uses the line-level vantage_equipment_id over the header', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-02-01', null, [{ colour: 'cyan', equipment: 100 }], { headerEquipment: 999 });
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toMatchObject({ reason: 'not_fitted' });
  });

  it('a null quantity counts as 1', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-02-01', null, [{ colour: 'cyan', quantity: null }]);
    const hold = (await computeHolds(t.db, [cand(1)], NOW)).get(1)!;
    expect(hold.detail).toContain('Cyan sent 1 Feb 2026');
    expect(hold.detail).not.toContain('2 cyan');
  });

  it('safety net: spanning history but pages since >= rated yield is never held', async () => {
    await meter('2026-02-01', 1_000);
    await meter('2026-03-10', 25_000); // 24,000 pages since, rated 20,000
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
  });

  it('a meter reset after the order gives unknown pages, so no low_yield hold', async () => {
    await meter('2026-02-01', 50_000);
    await meter('2026-03-10', 100);
    await order(1, '2026-02-01', null, [{ colour: 'cyan' }]);
    expect((await computeHolds(t.db, [cand(1)], NOW)).get(1)).toBeNull();
  });

  it('completed_date is ignored when choosing the last order (newest order_date wins)', async () => {
    await meter('2026-03-10', 5_000);
    await level('2026-01-28', 10);
    await level('2026-03-05', 8);
    await order(1, '2026-01-10', '2026-02-20', [{ colour: 'cyan' }]);
    await order(2, '2026-02-01', null, [{ colour: 'cyan' }]);
    const hold = (await computeHolds(t.db, [cand(1)], NOW)).get(1)!;
    expect(hold.detail).toContain('1 Feb 2026 (SO-2)');
  });

  it('every candidate appears; unlinked, unknown and order-less candidates are null', async () => {
    const holds = await computeHolds(t.db, [cand(1), cand(2, 'unlinked'), cand(3, 'nope'), cand(4, 'col', 'yellow')], NOW);
    expect([...holds.keys()].sort()).toEqual([1, 2, 3, 4]);
    for (const id of [1, 2, 3, 4]) expect(holds.get(id)).toBeNull();
  });

  it('empty candidate list gives an empty map', async () => {
    expect((await computeHolds(t.db, [], NOW)).size).toBe(0);
  });
});
