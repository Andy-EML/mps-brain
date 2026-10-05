import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getReviewDeviceDetail, meterPoints, pagesSinceOrder, type MeterPoint } from './review-detail';

const DAY = 86_400_000;
const d = (iso: string) => new Date(iso);
const pt = (iso: string, value: number): MeterPoint => ({ at: d(iso), value });

describe('pagesSinceOrder', () => {
  const order = d('2026-08-01T10:00:00Z');

  it('counts pages from the nearest reading on or before the order date to the newest reading', () => {
    const points = [pt('2026-07-01T00:00:00Z', 900), pt('2026-07-25T00:00:00Z', 1000), pt('2026-08-01T09:00:00Z', 1010), pt('2026-09-20T00:00:00Z', 1500)];
    expect(pagesSinceOrder(points, order)).toEqual({
      kind: 'pages',
      pages: 490,
      orderDate: order,
      baselineAt: d('2026-08-01T09:00:00Z'),
      currentAt: d('2026-09-20T00:00:00Z'),
    });
  });

  it('accepts a reading up to 45 days before the order, and says so when the nearest is older', () => {
    const within = [pt('2026-06-18T00:00:00Z', 100), pt('2026-09-01T00:00:00Z', 400)];
    expect(pagesSinceOrder(within, order)).toMatchObject({ kind: 'pages', pages: 300 });
    const older = [pt('2026-06-01T00:00:00Z', 100), pt('2026-09-01T00:00:00Z', 400)];
    expect(pagesSinceOrder(older, order)).toEqual({ kind: 'no-reading', orderDate: order });
  });

  it('says no reading when there are none at all, and no order when the colour never went out', () => {
    expect(pagesSinceOrder([], order)).toEqual({ kind: 'no-reading', orderDate: order });
    expect(pagesSinceOrder([pt('2026-09-01T00:00:00Z', 5)], null)).toEqual({ kind: 'no-order' });
  });

  it('never shows a negative count: a lower meter now means the meter was reset', () => {
    const points = [pt('2026-07-30T00:00:00Z', 50_000), pt('2026-09-01T00:00:00Z', 120)];
    expect(pagesSinceOrder(points, order)).toEqual({ kind: 'meter-reset', orderDate: order });
  });

  it('ignores readings after the order when picking the baseline, whatever their input order', () => {
    const points = [pt('2026-09-01T00:00:00Z', 700), pt('2026-08-02T00:00:00Z', 650), pt('2026-07-31T00:00:00Z', 600)];
    expect(pagesSinceOrder(points, order)).toMatchObject({ kind: 'pages', pages: 100, baselineAt: d('2026-07-31T00:00:00Z') });
  });
});

describe('meterPoints', () => {
  const counters = { black: [pt('2026-07-01T00:00:00Z', 1000)], colour: [pt('2026-07-01T00:00:00Z', 300)] };
  const alarms = [{ receivedTime: d('2026-08-01T00:00:00Z'), totalCount: 1500, totalColorCount: 400 }];

  it('reads black from the black meter and colour from the full-colour meter, oldest first', () => {
    expect(meterPoints({ counters, alarms: [], isColour: true, meter: 'black' })).toEqual([pt('2026-07-01T00:00:00Z', 1000)]);
    expect(meterPoints({ counters, alarms: [], isColour: true, meter: 'colour' })).toEqual([pt('2026-07-01T00:00:00Z', 300)]);
  });

  it('uses DRMS alarm page counts as extra readings: total minus colour for black on a colour device', () => {
    expect(meterPoints({ counters, alarms, isColour: true, meter: 'black' })).toEqual([
      pt('2026-07-01T00:00:00Z', 1000),
      pt('2026-08-01T00:00:00Z', 1100),
    ]);
    expect(meterPoints({ counters, alarms, isColour: true, meter: 'colour' })).toEqual([
      pt('2026-07-01T00:00:00Z', 300),
      pt('2026-08-01T00:00:00Z', 400),
    ]);
  });

  it('takes the alarm total as the black count on a mono device and skips alarms without counts', () => {
    const mono = [...alarms, { receivedTime: d('2026-08-05T00:00:00Z'), totalCount: null, totalColorCount: null }];
    expect(meterPoints({ counters, alarms: mono, isColour: false, meter: 'black' })).toEqual([
      pt('2026-07-01T00:00:00Z', 1000),
      pt('2026-08-01T00:00:00Z', 1500),
    ]);
  });
});

describe('getReviewDeviceDetail', () => {
  let t: TestDb;
  // Relative to the real clock: getCounterHistory windows on Date.now().
  const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000);
  const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'col', modelName: 'bizhub C300i', serial: 'S1', isColour: true, raw: {} },
      { drmsId: 'mono', modelName: 'bizhub 301i', serial: 'S2', isColour: false, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 100, raw: {} },
      { vantageId: 101, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'col', vantageEquipmentId: 100, method: 'serial' },
      { drmsEquipmentId: 'mono', vantageEquipmentId: 101, method: 'serial' },
    ]);

    async function snap(drmsId: string, counterId: string, at: Date, values: Record<string, number>) {
      const [s] = await t.db
        .insert(counterSnapshots)
        .values({ drmsEquipmentId: drmsId, counterId, receivedTime: at, fetchedAt: at, raw: {} })
        .returning();
      await t.db.insert(counterValues).values(Object.entries(values).map(([name, value]) => ({ snapshotId: s!.id, name, value })));
    }
    await snap('col', 'c1', ago(40), { 'Black:Total': 10_000, 'Full Color:Total': 5_000, BlackTonerLevel: 60, CyanTonerLevel: 50 });
    await snap('col', 'c2', ago(5), { 'Black:Total': 12_000, 'Full Color:Total': 5_800, BlackTonerLevel: 30, CyanTonerLevel: 2, MagentaTonerLevel: 40, YellowTonerLevel: 70 });
    // A mono device that still reports a stray colour level: the detail must not show it.
    await snap('mono', 'm1', ago(1), { 'Black:Total': 3_000, BlackTonerLevel: 8, CyanTonerLevel: 0 });

    await t.db.insert(vantageSalesOrders).values([
      { vantageId: 1, reference: 'SO1', orderDate: ago(30), completedDate: ago(28), vantageEquipmentId: 100, raw: {} },
      { vantageId: 2, reference: 'SO2', orderDate: ago(20), completedDate: null, vantageEquipmentId: 100, raw: {} },
      { vantageId: 3, reference: 'SO-DEL', orderDate: ago(10), vantageEquipmentId: 100, deletedDate: ago(9), raw: {} },
      { vantageId: 4, reference: 'SO-SERVICE', orderDate: ago(8), vantageEquipmentId: 100, raw: {} },
    ]);
    await t.db.insert(vantageSalesOrderLines).values([
      { vantageId: 11, salesOrderId: 1, vantageEquipmentId: 100, quantity: '1', colour: 'black', raw: {} },
      { vantageId: 21, salesOrderId: 2, vantageEquipmentId: 100, quantity: '2', colour: 'cyan', raw: {} },
      { vantageId: 31, salesOrderId: 3, vantageEquipmentId: 100, quantity: '1', colour: 'black', raw: {} },
      { vantageId: 41, salesOrderId: 4, vantageEquipmentId: 100, quantity: '1', colour: 'unknown', details: 'Engineer visit', raw: {} },
    ]);

    await t.db.insert(deviceAlarms).values([
      { alarmId: 'a1', drmsEquipmentId: 'col', receivedTime: ago(2), description: 'Toner Near Empty(C)', category: 'toner', totalCount: 17_900, totalColorCount: 5_900, raw: {} },
      { alarmId: 'a2', drmsEquipmentId: 'col', receivedTime: ago(3), description: 'Waste toner near full', category: 'waste', raw: {} },
      { alarmId: 'a3', drmsEquipmentId: 'col', receivedTime: ago(4), description: 'Drum near end', category: 'parts', raw: {} },
      { alarmId: 'a4', drmsEquipmentId: 'col', receivedTime: ago(4), description: 'SC-1234', category: 'service', raw: {} },
      { alarmId: 'a5', drmsEquipmentId: 'col', receivedTime: ago(31), description: 'Toner Near Empty(K)', category: 'toner', raw: {} },
    ]);
  });
  afterEach(() => t.close());

  it('returns null for an unknown device', async () => {
    expect(await getReviewDeviceDetail(t.db, 'nope', NOW)).toBeNull();
  });

  it('shows K, C, M, Y and waste on a colour device, with the last reading date', async () => {
    const detail = (await getReviewDeviceDetail(t.db, 'col', NOW))!;
    expect(detail.levels).toEqual([
      { colour: 'black', level: 30 },
      { colour: 'cyan', level: 2 },
      { colour: 'magenta', level: 40 },
      { colour: 'yellow', level: 70 },
      { colour: 'waste', level: null },
    ]);
    expect(detail.lastReadingAt).toEqual(ago(5));
    expect(detail.readingStale).toBe(true);
  });

  it('omits C, M and Y on a mono device, even when DRMS sends a stray level', async () => {
    const detail = (await getReviewDeviceDetail(t.db, 'mono', NOW))!;
    expect(detail.levels.map((l) => l.colour)).toEqual(['black', 'waste']);
    expect(detail.readingStale).toBe(false);
    expect(Object.keys(detail.pagesSince)).toEqual(['black']);
  });

  it('lists sales orders of any kind newest first, without deleted orders', async () => {
    const detail = (await getReviewDeviceDetail(t.db, 'col', NOW))!;
    expect(detail.orders.map((o) => [o.reference, o.open, o.lines])).toEqual([
      ['SO-SERVICE', true, [{ kind: 'other', text: 'Engineer visit', quantity: 1 }]],
      ['SO2', true, [{ kind: 'toner', colour: 'cyan', quantity: 2 }]],
      ['SO1', false, [{ kind: 'toner', colour: 'black', quantity: 1 }]],
    ]);
  });

  it('keeps only the last four orders, with toner, part and empty orders alike', async () => {
    await t.db.insert(vantageSalesOrders).values([
      { vantageId: 5, reference: 'SO-PARTS', orderDate: ago(6), completedDate: ago(5), vantageEquipmentId: 100, raw: {} },
      { vantageId: 6, reference: 'SO-EMPTY', orderDate: ago(3), vantageEquipmentId: 100, raw: {} },
      // Linked only through its line, as Vantage sometimes does.
      { vantageId: 7, reference: 'SO-MIX', orderDate: ago(2), raw: {} },
    ]);
    await t.db.insert(vantageSalesOrderLines).values([
      { vantageId: 51, salesOrderId: 5, vantageEquipmentId: 100, quantity: '1', colour: 'unknown', details: '  Drum unit DR-316  ', itemDescription: 'Drum', raw: {} },
      { vantageId: 52, salesOrderId: 5, vantageEquipmentId: 100, quantity: '2', itemDescription: 'Fuser', raw: {} },
      { vantageId: 53, salesOrderId: 5, vantageEquipmentId: 100, quantity: '1', itemPartNumber: 'A0X5150', raw: {} },
      { vantageId: 54, salesOrderId: 5, vantageEquipmentId: 100, quantity: '1', colour: 'black', returnedDate: ago(4), raw: {} },
      { vantageId: 55, salesOrderId: 5, vantageEquipmentId: 100, quantity: null, raw: {} },
      { vantageId: 71, salesOrderId: 7, vantageEquipmentId: 100, quantity: '1', colour: 'black', raw: {} },
      { vantageId: 72, salesOrderId: 7, vantageEquipmentId: 100, quantity: '1', colour: 'waste', raw: {} },
      { vantageId: 73, salesOrderId: 7, vantageEquipmentId: 100, quantity: '1', details: 'Staples', raw: {} },
    ]);
    const detail = (await getReviewDeviceDetail(t.db, 'col', NOW))!;
    expect(detail.orders.map((o) => [o.reference, o.open, o.lines])).toEqual([
      [
        'SO-MIX',
        true,
        [
          { kind: 'toner', colour: 'black', quantity: 1 },
          { kind: 'toner', colour: 'waste', quantity: 1 },
          { kind: 'other', text: 'Staples', quantity: 1 },
        ],
      ],
      ['SO-EMPTY', true, []],
      [
        'SO-PARTS',
        false,
        // Details first, then the item description, then the part number; returned lines left out.
        [
          { kind: 'other', text: 'Drum unit DR-316', quantity: 1 },
          { kind: 'other', text: 'Fuser', quantity: 2 },
          { kind: 'other', text: 'A0X5150', quantity: 1 },
          { kind: 'other', text: 'Unnamed line', quantity: null },
        ],
      ],
      ['SO-SERVICE', true, [{ kind: 'other', text: 'Engineer visit', quantity: 1 }]],
    ]);
  });

  it('keeps only toner, waste and parts alarms from the last 30 days', async () => {
    const detail = (await getReviewDeviceDetail(t.db, 'col', NOW))!;
    expect(detail.alarms.map((a) => a.alarmId)).toEqual(['a1', 'a2', 'a3']);
    expect(detail.alarms[0]).toMatchObject({ totalCount: 17_900, totalColorCount: 5_900 });
  });

  it('counts pages since each colour last went out, from counters and alarm readings', async () => {
    const detail = (await getReviewDeviceDetail(t.db, 'col', NOW))!;
    // Black last ordered 30 days ago (the deleted SO-DEL does not count); baseline is the 40-day
    // reading (10,000); newest is the alarm two days ago: 17,900 - 5,900 = 12,000.
    expect(detail.pagesSince.black).toMatchObject({ kind: 'pages', pages: 2_000, baselineAt: ago(40), currentAt: ago(2) });
    // Cyan last ordered 20 days ago; colour meter 5,000 then the alarm's 5,900.
    expect(detail.pagesSince.cyan).toMatchObject({ kind: 'pages', pages: 900 });
    expect(detail.pagesSince.magenta).toEqual({ kind: 'no-order' });
  });
});
