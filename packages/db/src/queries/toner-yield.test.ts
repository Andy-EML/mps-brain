import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  vantageEquipment,
  vantageMeterReadings,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import {
  averageAchieved,
  buildCartridges,
  computeColourYield,
  EARLY_PCT_THRESHOLD,
  getDeviceYield,
  getYieldCheckForProposals,
  isEarly,
  isStale,
  isUnderYielding,
  listUnderYielding,
  INTERPOLATE_MAX_DAYS,
  meterAt,
  meterPointsFor,
  mergeSnapshots,
  pageMeterValue,
  vantageSnapshots,
  getFleetYields,
  UNDER_YIELD_PCT_THRESHOLD,
  type DeliveryEvent,
  type MeterSnapshot,
  type VantageMeterPoint,
  type YieldMeterPoint,
} from './toner-yield';

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const pt = (iso: string, value: number): YieldMeterPoint => ({ at: d(iso), value });
const ev = (lineId: number, iso: string, quantity: number | null = 1): DeliveryEvent => ({ orderDate: d(iso), salesOrderId: lineId * 10, lineId, quantity });

describe('pageMeterValue / meterPointsFor', () => {
  it('uses the colour meter for CMY and black plus colour for black and waste', () => {
    const s = { black: 1000, colour: 400 };
    expect(pageMeterValue('cyan', true, s)).toBe(400);
    expect(pageMeterValue('yellow', true, s)).toBe(400);
    expect(pageMeterValue('black', true, s)).toBe(1400);
    expect(pageMeterValue('waste', true, s)).toBe(1400);
  });
  it('is unknown when a needed meter is missing; a mono device needs only black', () => {
    expect(pageMeterValue('cyan', true, { black: 1, colour: null })).toBeNull();
    expect(pageMeterValue('black', true, { black: null, colour: 5 })).toBeNull();
    expect(pageMeterValue('black', true, { black: 100, colour: null })).toBeNull();
    expect(pageMeterValue('black', false, { black: 100, colour: null })).toBe(100);
  });
  it('drops snapshots without the meter and sorts oldest first', () => {
    const pts = meterPointsFor('cyan', true, [
      { at: d('2026-02-01'), black: 1, colour: 20 },
      { at: d('2026-01-01'), black: 1, colour: 10 },
      { at: d('2026-03-01'), black: 1, colour: null },
    ]);
    expect(pts.map((p) => p.value)).toEqual([10, 20]);
  });
});

describe('meterAt', () => {
  const points = [pt('2026-02-01', 100), pt('2026-03-01', 200)];
  it('is the exact reading on a hit', () => {
    expect(meterAt(points, d('2026-03-01'))).toMatchObject({ value: 200, estimated: false });
    expect(meterAt(points, d('2026-03-01'))!.before).toBe(points[1]);
    expect(meterAt(points, d('2026-03-01'))!.after).toBeNull();
  });
  it('interpolates linearly between bracketing readings up to 45 days apart', () => {
    const p = [pt('2026-03-27', 33_710), pt('2026-04-26', 35_356)];
    const r = meterAt(p, d('2026-04-02'))!;
    expect(r.estimated).toBe(true);
    expect(Math.abs(r.value - (33_710 + (1646 * 6) / 30))).toBeLessThanOrEqual(1);
    expect(r.value).toBe(34_039);
    expect(r.before).toBe(p[0]);
    expect(r.after).toBe(p[1]);
    expect(INTERPOLATE_MAX_DAYS).toBe(45);
  });
  it('falls back to the newest before when the bracket is wider than 45 days', () => {
    const p = [pt('2026-01-01', 1_000), pt('2026-02-16', 2_000)]; // 46 days
    const r = meterAt(p, d('2026-01-20'))!;
    expect(r).toMatchObject({ value: 1_000, estimated: false, after: null });
    expect(r.before).toBe(p[0]);
    const exact45 = [pt('2026-01-01', 1_000), pt('2026-02-15', 2_000)];
    expect(meterAt(exact45, d('2026-01-20'))!.estimated).toBe(true);
  });
  it('does not interpolate across a meter reset inside the bracket', () => {
    const p = [pt('2026-03-01', 50_000), pt('2026-03-21', 100)];
    expect(meterAt(p, d('2026-03-11'))).toMatchObject({ value: 50_000, estimated: false, after: null });
  });
  it('uses the newest before when nothing is after', () => {
    expect(meterAt(points, d('2026-06-01'))).toMatchObject({ value: 200, estimated: false, after: null });
  });
  it('with nothing before, takes a reading up to 14 days after, else unknown', () => {
    const r = meterAt(points, d('2026-01-22'))!; // 10 days
    expect(r).toMatchObject({ value: 100, estimated: false, before: null });
    expect(r.after).toBe(points[0]);
    expect(meterAt(points, d('2026-01-17'))).toBeNull(); // 15 days
    expect(meterAt([], d('2026-01-10'))).toBeNull();
  });
});

describe('buildCartridges', () => {
  const points = [pt('2026-01-01', 0), pt('2026-02-01', 10_000), pt('2026-03-01', 25_000), pt('2026-04-01', 26_000)];

  it('no orders gives no cartridges', () => {
    expect(buildCartridges([], points)).toEqual([]);
  });
  it('one order has no measured pages (nothing after it)', () => {
    const [c] = buildCartridges([ev(1, '2026-01-01')], points);
    expect(c).toMatchObject({ lineId: 1, quantity: 1, pagesDone: null, pagesPerCartridge: null });
  });
  it('measures pages to the next delivery', () => {
    const cs = buildCartridges([ev(2, '2026-02-01'), ev(1, '2026-01-01'), ev(3, '2026-03-01')], points);
    expect(cs.map((c) => c.lineId)).toEqual([1, 2, 3]);
    expect(cs.map((c) => c.pagesDone)).toEqual([10_000, 15_000, null]);
  });
  it('divides by quantity when several cartridges came at once', () => {
    const [a] = buildCartridges([ev(1, '2026-01-01', 2), ev(2, '2026-03-01')], points);
    expect(a).toMatchObject({ quantity: 2, pagesDone: 25_000, pagesPerCartridge: 12_500 });
  });
  it('merges lines on the same order date into one delivery', () => {
    const cs = buildCartridges([ev(1, '2026-01-01'), ev(2, '2026-01-01'), ev(3, '2026-02-01')], points);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ lineId: 1, lineIds: [1, 2], quantity: 2, pagesDone: 10_000, pagesPerCartridge: 5_000 });
  });
  it('treats null or sub-1 quantity as 1', () => {
    expect(buildCartridges([ev(1, '2026-01-01', null)], points)[0]!.quantity).toBe(1);
    expect(buildCartridges([ev(1, '2026-01-01', 0)], points)[0]!.quantity).toBe(1);
  });
  it('is not measurable with a missing meter, a shared snapshot, or a reset', () => {
    expect(buildCartridges([ev(1, '2025-06-01'), ev(2, '2026-02-01')], points)[0]!.pagesDone).toBeNull(); // no reading near first
    expect(buildCartridges([ev(1, '2026-02-05'), ev(2, '2026-02-20')], points)[0]!.pagesDone).toBeNull(); // same snapshot
    const reset = [pt('2026-01-01', 50_000), pt('2026-02-01', 100)];
    expect(buildCartridges([ev(1, '2026-01-01'), ev(2, '2026-02-01')], reset)[0]!.pagesDone).toBeNull();
  });
});

describe('buildCartridges with a Delivery fit date', () => {
  const points = [pt('2026-01-01', 0), pt('2026-01-11', 1_000), pt('2026-02-01', 10_000), pt('2026-02-11', 11_000), pt('2026-03-01', 25_000)];
  const fitted = (e: DeliveryEvent, iso: string): DeliveryEvent => ({ ...e, fitDate: d(iso) });
  it('measures from the fit date, not the order date', () => {
    // Order 01-01, fitted 01-11; next order 02-01, fitted 02-11: 11,000 - 1,000, not 10,000 - 0.
    const [a] = buildCartridges([fitted(ev(1, '2026-01-01'), '2026-01-11'), fitted(ev(2, '2026-02-01'), '2026-02-11')], points);
    expect(a).toMatchObject({ anchor: d('2026-01-11'), orderDate: d('2026-01-01'), pagesDone: 10_000 });
  });
  it('falls back to the order date with no Delivery', () => {
    const [a] = buildCartridges([ev(1, '2026-01-01'), ev(2, '2026-02-01')], points);
    expect(a).toMatchObject({ anchor: d('2026-01-01'), pagesDone: 10_000 });
  });
  it('pages since the last order start at its fit date', () => {
    const c = computeColourYield({ colour: 'black', ratedYield: 20_000, events: [fitted(ev(1, '2026-02-01'), '2026-02-11')], points, stale: false });
    expect(c).toMatchObject({ lastOrderDate: d('2026-02-01'), pagesSinceLastOrder: 14_000 });
    const plain = computeColourYield({ colour: 'black', ratedYield: 20_000, events: [ev(1, '2026-02-01')], points, stale: false });
    expect(plain.pagesSinceLastOrder).toBe(15_000);
  });
});

describe('buildCartridges with interpolation', () => {
  const points = [pt('2026-03-01', 1_000), pt('2026-04-01', 4_100), pt('2026-04-30', 7_000)];
  it('is not measurable when both deliveries sit in one interpolation gap', () => {
    expect(buildCartridges([ev(1, '2026-03-10'), ev(2, '2026-03-20')], points)[0]!.pagesDone).toBeNull();
  });
  it('measures from interpolated ends when a reading lies between the deliveries', () => {
    const [a] = buildCartridges([ev(1, '2026-03-16'), ev(2, '2026-04-15')], points);
    // 03-16: 1,000 + 3,100*15/31 = 2,500; 04-15: 4,100 + 2,900*14/29 = 5,500.
    expect(a!.pagesDone).toBe(3_000);
  });
});

describe('averageAchieved', () => {
  const cart = (pagesDone: number | null, quantity = 1) => ({
    orderDate: d('2026-01-01'),
    anchor: d('2026-01-01'),
    salesOrderId: 1,
    lineId: 1,
    lineIds: [1],
    quantity,
    pagesDone,
    pagesPerCartridge: pagesDone === null ? null : pagesDone / quantity,
  });
  it('is null with nothing measurable', () => {
    expect(averageAchieved([])).toEqual({ avg: null, counted: 0 });
    expect(averageAchieved([cart(null)])).toEqual({ avg: null, counted: 0 });
  });
  it('averages the last five measurable cartridges, weighting by quantity', () => {
    const cs = [cart(1_000), cart(10_000), cart(10_000), cart(10_000), cart(10_000), cart(10_000), cart(null)];
    expect(averageAchieved(cs)).toEqual({ avg: 10_000, counted: 5 });
    expect(averageAchieved([cart(10_000, 2), cart(5_000)])).toEqual({ avg: 5_000, counted: 3 });
  });
});

describe('flags', () => {
  it('isUnderYielding needs a percentage and two cartridges', () => {
    expect(isUnderYielding(null, 5)).toBeNull();
    expect(isUnderYielding(0.1, 1)).toBeNull();
    expect(isUnderYielding(UNDER_YIELD_PCT_THRESHOLD - 0.01, 2)).toBe(true);
    expect(isUnderYielding(UNDER_YIELD_PCT_THRESHOLD, 2)).toBe(false);
  });
  it('isEarly: no order is false, unknown pages is null, below the threshold is early', () => {
    expect(isEarly(false, null)).toBe(false);
    expect(isEarly(true, null)).toBeNull();
    expect(isEarly(true, EARLY_PCT_THRESHOLD - 0.01)).toBe(true);
    expect(isEarly(true, EARLY_PCT_THRESHOLD)).toBe(false);
  });
  it('isStale after 14 days or with no snapshot', () => {
    const now = d('2026-03-15');
    expect(isStale(null, now)).toBe(true);
    expect(isStale(d('2026-03-01'), now)).toBe(false);
    expect(isStale(d('2026-02-28'), now)).toBe(true);
  });
});

describe('computeColourYield with interpolation', () => {
  const pts = [pt('2026-03-27', 33_710), pt('2026-04-26', 35_356), pt('2026-05-30', 42_251)];
  const args = { colour: 'black' as const, stale: false, ratedYield: 28_000, events: [ev(1, '2026-04-02')] };
  it('bases pages since the order on the interpolated meter and flags it', () => {
    const r = computeColourYield({ ...args, points: pts });
    expect(r.pagesSinceLastOrder).toBe(8_212); // 42,251 - 34,039
    expect(r.pagesSinceEstimated).toBe(true);
  });
  it('is not estimated on an exact reading', () => {
    const r = computeColourYield({ ...args, events: [ev(1, '2026-04-26')], points: pts });
    expect(r).toMatchObject({ pagesSinceLastOrder: 42_251 - 35_356, pagesSinceEstimated: false });
  });
  it('is unknown after a meter reset', () => {
    const reset = [pt('2026-03-27', 33_710), pt('2026-04-26', 35_356), pt('2026-05-30', 500)];
    const r = computeColourYield({ ...args, points: reset });
    expect(r).toMatchObject({ pagesSinceLastOrder: null, pagesSinceEstimated: false });
  });
});

describe('computeColourYield', () => {
  const points = [pt('2026-01-01', 0), pt('2026-02-01', 10_000), pt('2026-03-01', 25_000), pt('2026-03-10', 27_000)];
  const base = { colour: 'black' as const, points, stale: false };

  it('no orders: nothing to measure, not early', () => {
    const r = computeColourYield({ ...base, ratedYield: 20_000, events: [] });
    expect(r).toMatchObject({ lastOrderDate: null, pagesSinceLastOrder: null, early: false, avgAchieved: null, underYielding: null, status: 'ok' });
  });
  it('one order: pages since, early when under half a cartridge', () => {
    const r = computeColourYield({ ...base, ratedYield: 20_000, events: [ev(1, '2026-03-01')] });
    expect(r).toMatchObject({ pagesSinceLastOrder: 2_000, pctOfRatedSinceLastOrder: 0.1, early: true, underYielding: null });
  });
  it('not early once half a cartridge or more has printed', () => {
    const r = computeColourYield({ ...base, ratedYield: 20_000, events: [ev(1, '2026-02-01')] });
    expect(r).toMatchObject({ pagesSinceLastOrder: 17_000, early: false });
  });
  it('multiple orders: average and under-yielding', () => {
    const events = [ev(1, '2026-01-01'), ev(2, '2026-02-01'), ev(3, '2026-03-01')];
    const under = computeColourYield({ ...base, ratedYield: 30_000, events });
    expect(under).toMatchObject({ avgAchieved: 12_500, cartridgesCounted: 2, underYielding: true });
    expect(under.avgPctOfRated).toBeCloseTo(12_500 / 30_000);
    expect(computeColourYield({ ...base, ratedYield: 15_000, events }).underYielding).toBe(false);
  });
  it('null rated yield still reports pages but no percentages or flags', () => {
    const r = computeColourYield({ ...base, ratedYield: null, events: [ev(1, '2026-01-01'), ev(2, '2026-02-01'), ev(3, '2026-03-01')] });
    expect(r).toMatchObject({
      status: 'no_rated_yield',
      avgAchieved: 12_500,
      avgPctOfRated: null,
      underYielding: null,
      pagesSinceLastOrder: 2_000,
      pctOfRatedSinceLastOrder: null,
      early: null,
    });
  });
  it('carries the stale flag and still returns figures', () => {
    const r = computeColourYield({ ...base, stale: true, ratedYield: 20_000, events: [ev(1, '2026-03-01')] });
    expect(r).toMatchObject({ stale: true, pagesSinceLastOrder: 2_000 });
  });
  it('missing meter around the last order gives unknown pages', () => {
    const r = computeColourYield({ ...base, ratedYield: 20_000, events: [ev(1, '2025-01-01')] });
    expect(r).toMatchObject({ pagesSinceLastOrder: null, early: null });
  });
});

describe('vantageSnapshots', () => {
  const vp = (iso: string, typeId: number, value: number): VantageMeterPoint => ({ equipmentId: 1, at: d(iso), typeId, value });
  it('groups black and colour readings by time', () => {
    const out = vantageSnapshots([vp('2026-01-01', 1, 100), vp('2026-01-01', 2, 40), vp('2026-02-01', 1, 150), vp('2026-02-01', 3, 9)]);
    expect(out).toEqual([
      { at: d('2026-01-01'), black: 100, colour: 40 },
      { at: d('2026-02-01'), black: 150, colour: null },
    ]);
  });
  it('sums coverage-tier colour meters when there is no plain colour meter', () => {
    const out = vantageSnapshots([vp('2026-01-01', 1, 15295), vp('2026-01-01', 7, 50949), vp('2026-01-01', 9, 32439)]);
    expect(out).toEqual([{ at: d('2026-01-01'), black: 15295, colour: 83388 }]);
  });
  it('yields nothing for a machine with a Black A3 meter (scale not verified)', () => {
    expect(vantageSnapshots([vp('2026-01-01', 1, 100), vp('2026-01-01', 12, 5)])).toEqual([]);
  });
});

describe('mergeSnapshots', () => {
  const sn = (iso: string, black: number, colour: number | null = null): MeterSnapshot => ({ at: new Date(iso), black, colour });
  it('keeps Vantage readings that fill gaps and sorts by time', () => {
    const out = mergeSnapshots([sn('2026-03-01T06:00:00Z', 300), sn('2026-01-01T06:00:00Z', 100)], [sn('2026-02-01T06:00:00Z', 200)]);
    expect(out.map((s) => s.black)).toEqual([100, 200, 300]);
  });
  it('drops a Vantage reading within 36 h of a DRMS snapshot, and prefers DRMS', () => {
    const out = mergeSnapshots([sn('2026-02-01T06:00:00Z', 205)], [sn('2026-01-31T20:00:00Z', 200), sn('2026-02-03T06:00:00Z', 210)]);
    expect(out.map((s) => s.black)).toEqual([205, 210]);
  });
  it('drops a Vantage reading that would run the meter backwards, but never a DRMS one', () => {
    const out = mergeSnapshots(
      [sn('2026-01-01T00:00:00Z', 100), sn('2026-03-01T00:00:00Z', 300), sn('2026-04-01T00:00:00Z', 50)],
      [sn('2026-02-01T00:00:00Z', 350), sn('2026-02-15T00:00:00Z', 120), sn('2026-03-15T00:00:00Z', 280)],
    );
    expect(out.map((s) => s.black)).toEqual([100, 120, 300, 50]);
  });
  it('is a no-op without Vantage readings', () => {
    const drms = [sn('2026-01-01T00:00:00Z', 1), sn('2026-02-01T00:00:00Z', 2)];
    expect(mergeSnapshots(drms, [])).toEqual(drms);
  });
});

// ---------------------------------------------------------------------------------------------

describe('toner yield queries', () => {
  let t: TestDb;
  const NOW = new Date('2026-03-12T00:00:00Z');
  let sn = 0;

  beforeEach(async () => {
    t = await createTestDb();
    sn = 0;
    const [fam] = await t.db
      .insert(cartridgeFamilies)
      .values({ name: 'C300 family', isColour: true, ratedYieldBlack: 20_000, ratedYieldCyan: 20_000 })
      .returning();
    await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub C300i', familyId: fam!.id });
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'col', modelName: 'bizhub C300i', serial: 'S1', isColour: true, customerName: 'Acme', raw: {} },
      { drmsId: 'mono', modelName: 'bizhub 4752', serial: 'S2', isColour: false, customerName: 'Mono Ltd', raw: {} },
      { drmsId: 'unlinked', modelName: 'bizhub C300i', serial: 'S3', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 100, raw: {} },
      { vantageId: 200, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'col', vantageEquipmentId: 100, method: 'serial' },
      { drmsEquipmentId: 'mono', vantageEquipmentId: 200, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  async function snap(drmsId: string, at: string, black: number, colour: number | null) {
    const [s] = await t.db
      .insert(counterSnapshots)
      .values({ drmsEquipmentId: drmsId, counterId: `c${++sn}`, receivedTime: d(at), fetchedAt: d(at), raw: {} })
      .returning();
    const values = [{ snapshotId: s!.id, name: 'Black:Total', value: black }];
    if (colour !== null) values.push({ snapshotId: s!.id, name: 'Full Color:Total', value: colour });
    await t.db.insert(counterValues).values(values);
  }
  let lineSeq = 0;
  async function order(soId: number, iso: string, equipment: number | null, lines: { colour: string; quantity?: string; equipment?: number | null; returned?: boolean }[], deleted = false) {
    await t.db.insert(vantageSalesOrders).values({ vantageId: soId, orderDate: d(iso), vantageEquipmentId: equipment, deletedDate: deleted ? d(iso) : null, raw: {} });
    for (const l of lines) {
      await t.db.insert(vantageSalesOrderLines).values({
        vantageId: ++lineSeq,
        salesOrderId: soId,
        colour: l.colour,
        quantity: l.quantity ?? '1',
        vantageEquipmentId: l.equipment ?? null,
        returnedDate: l.returned ? d(iso) : null,
        raw: {},
      });
    }
  }
  const colourOf = async (id: string, colour: string) => (await getDeviceYield(t.db, id, NOW))!.colours.find((c) => c.colour === colour)!;

  describe('Toner Delivery alarms give the fit date', () => {
    let alarmSeq = 0;
    const delivery = (at: string, description = 'Toner Delivery(K)', status = 'EquipmentDiscovered') =>
      t.db.insert(deviceAlarms).values({ alarmId: `dl${++alarmSeq}`, drmsEquipmentId: 'col', receivedTime: d(at), description, status, category: 'toner', raw: {} });

    it('reads pages since from the Delivery, not the order date', async () => {
      await snap('col', '2026-01-01', 0, 0);
      await snap('col', '2026-02-01', 3000, 0);
      await snap('col', '2026-03-10', 8000, 0);
      await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
      await delivery('2026-02-01'); // fitted a month after ordering
      const c = await colourOf('col', 'black');
      expect(c).toMatchObject({ lastOrderDate: d('2026-01-01'), pagesSinceLastOrder: 5000 });
    });
    it('ignores a Delivery for another colour, or from before the order', async () => {
      await snap('col', '2026-01-01', 0, 0);
      await snap('col', '2026-03-10', 8000, 0);
      await order(1, '2026-02-01', 100, [{ colour: 'black' }]);
      await delivery('2026-01-15');
      await delivery('2026-02-10', 'Toner Delivery(C)');
      expect((await colourOf('col', 'black')).cartridges[0]!.anchor).toEqual(d('2026-02-01'));
    });
    it('does not cross the next order: a Delivery after order 2 is its fit, not order 1', async () => {
      await snap('col', '2026-01-01', 0, 0);
      await snap('col', '2026-03-10', 8000, 0);
      await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
      await order(2, '2026-02-01', 100, [{ colour: 'black' }]);
      await delivery('2026-02-05');
      const cs = (await colourOf('col', 'black')).cartridges;
      expect(cs[0]!.anchor).toEqual(d('2026-01-01'));
      expect(cs[1]!.anchor).toEqual(d('2026-02-05'));
    });
  });

  it('returns null for an unknown device', async () => {
    expect(await getDeviceYield(t.db, 'nope', NOW)).toBeNull();
  });

  it('no orders: every colour has no last order and is not early', async () => {
    await snap('col', '2026-03-10', 1000, 500);
    const y = (await getDeviceYield(t.db, 'col', NOW))!;
    expect(y).toMatchObject({ familyName: 'C300 family', stale: false, vantageEquipmentId: 100 });
    expect(y.colours.map((c) => c.colour)).toEqual(['black', 'cyan', 'magenta', 'yellow', 'waste']);
    for (const c of y.colours) expect(c).toMatchObject({ lastOrderDate: null, early: false, cartridges: [] });
  });

  it('one order, linked via the header: pages since and early', async () => {
    await snap('col', '2026-01-01', 1000, 0);
    await snap('col', '2026-03-10', 4000, 1000); // black pages: (4000+1000) - 1000 = 4000
    await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
    const c = await colourOf('col', 'black');
    expect(c).toMatchObject({ ratedYield: 20_000, pagesSinceLastOrder: 4_000, early: true, status: 'ok' });
    expect(c.pctOfRatedSinceLastOrder).toBeCloseTo(0.2);
    expect(c.cartridges).toHaveLength(1);
  });

  it('links through the line equipment when the header has none, and ignores deleted orders and returned lines', async () => {
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-03-10', 3000, 0);
    await order(1, '2026-01-01', null, [{ colour: 'black', equipment: 100 }]);
    await order(2, '2026-02-01', 100, [{ colour: 'black' }], true); // deleted order
    await order(3, '2026-02-02', 100, [{ colour: 'black', returned: true }]);
    await order(4, '2026-02-03', 999, [{ colour: 'black' }]); // another machine
    const c = await colourOf('col', 'black');
    expect(c.cartridges.map((x) => x.salesOrderId)).toEqual([1]);
  });

  it('multiple orders and quantity 2: pages per cartridge and under-yielding', async () => {
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-02-01', 10_000, 0);
    await snap('col', '2026-03-01', 16_000, 0);
    await snap('col', '2026-03-10', 17_000, 0);
    await order(1, '2026-01-01', 100, [{ colour: 'black', quantity: '2' }]);
    await order(2, '2026-02-01', 100, [{ colour: 'black' }]);
    await order(3, '2026-03-01', 100, [{ colour: 'black' }]);
    const c = await colourOf('col', 'black');
    expect(c.cartridges.map((x) => [x.quantity, x.pagesDone, x.pagesPerCartridge])).toEqual([
      [2, 10_000, 5_000],
      [1, 6_000, 6_000],
      [1, null, null],
    ]);
    // (10000 + 6000) / 3 cartridges = 5333 of 20000
    expect(c.avgAchieved).toBeCloseTo(16_000 / 3);
    expect(c).toMatchObject({ cartridgesCounted: 3, underYielding: true, pagesSinceLastOrder: 1_000, early: true });
  });

  it('not under-yielding when the cartridges did their rated pages', async () => {
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-02-01', 20_000, 0);
    await snap('col', '2026-03-01', 41_000, 0);
    await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
    await order(2, '2026-02-01', 100, [{ colour: 'black' }]);
    await order(3, '2026-03-01', 100, [{ colour: 'black' }]);
    const c = await colourOf('col', 'black');
    // No reading after the last order: pages since are unknown, so early can't be judged.
    expect(c).toMatchObject({ underYielding: false, pagesSinceLastOrder: null, early: null });
    expect(c.avgPctOfRated).toBeGreaterThan(1);
  });

  it('missing meter: no snapshots gives unknown pages and unknown early, flagged stale', async () => {
    await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
    const y = (await getDeviceYield(t.db, 'col', NOW))!;
    expect(y.stale).toBe(true);
    expect(y.latestSnapshotAt).toBeNull();
    expect(y.colours[0]).toMatchObject({ pagesSinceLastOrder: null, early: null, stale: true });
  });

  it('stale device: still returns the figures, flagged', async () => {
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-02-01', 3000, 0); // 39 days before NOW
    await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
    const c = await colourOf('col', 'black');
    expect(c).toMatchObject({ stale: true, pagesSinceLastOrder: 3000 });
  });

  it('null rated yield (family with no waste yield): pages but no percentages', async () => {
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-03-10', 2000, 0);
    await order(1, '2026-01-01', 100, [{ colour: 'waste' }]);
    const c = await colourOf('col', 'waste');
    expect(c).toMatchObject({ status: 'no_rated_yield', ratedYield: null, pagesSinceLastOrder: 2000, pctOfRatedSinceLastOrder: null, early: null });
  });

  it('cyan counts only colour pages; magenta with no family yield too', async () => {
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-03-10', 9000, 1500);
    await order(1, '2026-01-01', 100, [{ colour: 'cyan' }]);
    expect(await colourOf('col', 'cyan')).toMatchObject({ pagesSinceLastOrder: 1500, early: true });
  });

  it('mono device: only black and waste, black counts the black meter', async () => {
    await snap('mono', '2026-01-01', 100, null);
    await snap('mono', '2026-03-10', 5100, null);
    await order(1, '2026-01-01', 200, [{ colour: 'black' }, { colour: 'cyan' }]);
    const y = (await getDeviceYield(t.db, 'mono', NOW))!;
    expect(y.colours.map((c) => c.colour)).toEqual(['black', 'waste']);
    expect(y.colours[0]).toMatchObject({ pagesSinceLastOrder: 5000, ratedYield: null, status: 'no_rated_yield', early: null });
  });

  it('an unlinked device has no orders', async () => {
    await snap('unlinked', '2026-03-10', 100, 0);
    const y = (await getDeviceYield(t.db, 'unlinked', NOW))!;
    expect(y.vantageEquipmentId).toBeNull();
    expect(y.colours[0]).toMatchObject({ lastOrderDate: null, early: false });
  });

  it('getYieldCheckForProposals: early vs not early, skips unknown colour and closed lines', async () => {
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-02-01', 5_000, 4_000);
    await snap('col', '2026-03-10', 30_000, 10_000);
    await order(1, '2026-01-01', 100, [{ colour: 'cyan' }]); // 10000 pages since: 50% -> not early
    await order(2, '2026-03-05', 100, [{ colour: 'black' }]); // black pages since: see below
    const mk = (colour: 'black' | 'cyan' | 'magenta', drms = 'col') =>
      ({ drmsEquipmentId: drms, vantageEquipmentId: 100, colour, trigger: 'threshold' as const, status: 'pending' as const }) as const;
    const ps = await t.db.insert(replenishmentProposals).values([mk('cyan'), mk('black'), mk('magenta')]).returning();
    const [cy, bl, mg] = ps.map((p) => p.id) as [number, number, number];
    const map = await getYieldCheckForProposals(t.db, [cy, bl, mg, 9999], NOW);
    expect(map.size).toBe(3);
    expect(map.get(cy)).toMatchObject({ colour: 'cyan', pagesSinceLastOrder: 10_000, pctOfRated: 0.5, early: false, stale: false, status: 'ok' });
    expect(map.get(cy)!.lastOrderDate).toEqual(d('2026-01-01'));
    // Black meter at 2026-03-05 is interpolated between 02-01 (9000) and 03-10 (40000): 9000 + 31000 * 32/37 = 35811; now 40000.
    expect(map.get(bl)).toMatchObject({ pagesSinceLastOrder: 4_189, early: true });
    expect(map.get(mg)).toMatchObject({ lastOrderDate: null, early: false, status: 'no_rated_yield' });

    // A proposal already closed by its own line does not treat that line as the last order.
    const lineOfSo2 = (await t.db.select().from(vantageSalesOrderLines)).find((l) => l.salesOrderId === 2)!;
    await t.db.update(replenishmentProposals).set({ vantageSalesOrderLineId: lineOfSo2.vantageId, status: 'ordered' }).where(eq(replenishmentProposals.id, bl));
    const after = await getYieldCheckForProposals(t.db, [bl], NOW);
    expect(after.get(bl)!.lastOrderDate).toBeNull();
  });

  it('getYieldCheckForProposals leaves out a CMY proposal on a mono device', async () => {
    const [p] = await t.db
      .insert(replenishmentProposals)
      .values({ drmsEquipmentId: 'mono', vantageEquipmentId: 200, colour: 'cyan', trigger: 'threshold', status: 'pending' })
      .returning();
    expect((await getYieldCheckForProposals(t.db, [p!.id], NOW)).size).toBe(0);
    expect((await getYieldCheckForProposals(t.db, [], NOW)).size).toBe(0);
  });

  it('listUnderYielding returns only flagged device/colours, worst first', async () => {
    // col black: two cartridges at ~25% of rated 20000; col cyan: fine (no rated would be null -> skipped)
    await snap('col', '2026-01-01', 0, 0);
    await snap('col', '2026-02-01', 5_000, 0);
    await snap('col', '2026-03-01', 10_000, 0);
    await snap('col', '2026-03-10', 11_000, 0);
    await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
    await order(2, '2026-02-01', 100, [{ colour: 'black' }]);
    await order(3, '2026-03-01', 100, [{ colour: 'black' }]);
    // mono: same pattern but no rated yield, so never flagged
    await snap('mono', '2026-01-01', 0, null);
    await snap('mono', '2026-02-01', 100, null);
    await snap('mono', '2026-03-01', 200, null);
    await order(4, '2026-01-01', 200, [{ colour: 'black' }]);
    await order(5, '2026-02-01', 200, [{ colour: 'black' }]);
    await order(6, '2026-03-01', 200, [{ colour: 'black' }]);
    const rows = await listUnderYielding(t.db, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      drmsEquipmentId: 'col',
      customerName: 'Acme',
      serial: 'S1',
      model: 'bizhub C300i',
      family: 'C300 family',
      colour: 'black',
      ratedYield: 20_000,
      avgAchieved: 5_000,
      cartridgesCounted: 2,
      stale: false,
    });
    expect(rows[0]!.avgPctOfRated).toBeCloseTo(0.25);
  });

  it('merges Vantage meter readings into the series, adding cartridges the DRMS history cannot measure', async () => {
    // DRMS only starts in March; Vantage has the Jan and Feb readings.
    await snap('col', '2026-03-10', 20_000, 0);
    const reading = (id: number, iso: string, typeId: number, value: number) =>
      t.db.insert(vantageMeterReadings).values({ vantageId: id, vantageEquipmentId: 100, meterTypeId: typeId, readingAt: d(iso), reading: value, raw: {} });
    await reading(1, '2026-01-01', 1, 0);
    await reading(2, '2026-01-01', 2, 0);
    await reading(3, '2026-02-01', 1, 10_000);
    await reading(4, '2026-02-01', 2, 0);
    await reading(5, '2026-03-01', 1, 19_000);
    await reading(6, '2026-03-01', 2, 0);
    await order(1, '2026-01-01', 100, [{ colour: 'black' }]);
    await order(2, '2026-02-01', 100, [{ colour: 'black' }]);
    await order(3, '2026-03-01', 100, [{ colour: 'black' }]);
    const merged = (await getFleetYields(t.db, NOW)).find((y) => y.drmsEquipmentId === 'col')!;
    const withVantage = merged.colours.find((c) => c.colour === 'black')!;
    expect(withVantage.cartridges.map((c) => c.pagesDone)).toEqual([10_000, 9_000, null]);
    const drmsOnly = (await getFleetYields(t.db, NOW, { vantageMeters: false })).find((y) => y.drmsEquipmentId === 'col')!;
    expect(drmsOnly.colours.find((c) => c.colour === 'black')!.cartridges.map((c) => c.pagesDone)).toEqual([null, null, null]);
  });
});
