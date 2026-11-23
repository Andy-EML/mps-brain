import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  counterSnapshots,
  counterValues,
  deviceAlerts,
  deviceLinks,
  drmsEquipment,
  drmsRegistrations,
  hiddenDevices,
  linkIssues,
  vantageEquipment,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { ALERT_SORT_KEYS, listAlerts, listAlertsPage } from './alerts';
import { DEVICE_SORT_KEYS, listDevices } from './devices';
import { HIDDEN_SORT_KEYS, listHiddenDevices } from './hidden-devices';
import { ISSUE_SORT_KEYS, listIssues } from './issues';
import { RECONNECT_SORT_KEYS, listReconnect } from './reconnect';
import { REGISTRATION_SORT_KEYS, listRegistrations } from './registrations';

const NOW = new Date('2026-09-18T12:00:00Z');
const d = (iso: string) => new Date(iso);

/**
 * Four-row fixtures per list: three rows with distinct values in every sortable column, one with
 * nulls in them. For each key, asc and desc must reverse the three and keep the null row last in
 * both directions.
 */
async function expectSortable<K extends string>(
  keys: readonly K[],
  run: (key: K, dir: 'asc' | 'desc') => Promise<string[]>,
  nullRow: string,
  skip: readonly K[] = [],
) {
  for (const key of keys) {
    if (skip.includes(key)) continue;
    const asc = await run(key, 'asc');
    const desc = await run(key, 'desc');
    expect(asc.at(-1), `${key} asc: null row last`).toBe(nullRow);
    expect(desc.at(-1), `${key} desc: null row last`).toBe(nullRow);
    expect(desc.slice(0, -1), `${key}: desc reverses asc`).toEqual(asc.slice(0, -1).reverse());
    expect(new Set(asc).size).toBe(asc.length);
  }
}

describe('sortable list queries', () => {
  let t: TestDb;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    t = await createTestDb();
    // X1..X3 have distinct values everywhere; X4 has nothing; X5 shares X2's customer.
    await t.db.insert(drmsEquipment).values([
      // Inserted first (before X2, its customer twin) so only the id tiebreak puts X2 ahead of X5.
      { drmsId: 'X5', serial: 'S5', modelName: 'bizhub E', productName: 'Pe', status: 'Registered', customerName: 'amy', raw: {} },
      { drmsId: 'X1', serial: 'S3', modelName: 'bizhub B', productName: 'Pb', status: 'Registered', customerName: 'Zed', initialConnectionTime: d('2026-03-02T00:00:00Z'), lastCounterReceivedTime: d('2026-07-01T00:00:00Z'), raw: { LastAlarmReceivedTime: '2026-01-03 00:00:00' } },
      { drmsId: 'X2', serial: 'S1', modelName: 'bizhub A', productName: 'Pa', status: 'PreRegistered', customerName: 'amy', initialConnectionTime: d('2026-03-01T00:00:00Z'), lastCounterReceivedTime: d('2026-08-01T00:00:00Z'), raw: { LastAlarmReceivedTime: '2026-01-01 00:00:00' } },
      { drmsId: 'X3', serial: 'S2', modelName: 'bizhub C', productName: 'Pc', status: 'Discovered', isColour: true, customerName: 'Mid', initialConnectionTime: d('2026-03-03T00:00:00Z'), lastCounterReceivedTime: d('2026-06-01T00:00:00Z'), raw: { LastAlarmReceivedTime: '2026-01-02 00:00:00' } },
      { drmsId: 'X4', serial: null, modelName: null, productName: null, status: null, customerName: null, initialConnectionTime: null, lastCounterReceivedTime: null, raw: {} },
    ]);
    const snap = async (drmsId: string, black: number, cyan?: number) => {
      const [s] = await t.db
        .insert(counterSnapshots)
        .values({ drmsEquipmentId: drmsId, counterId: `c-${drmsId}`, receivedTime: d('2026-09-18T10:00:00Z'), raw: {} })
        .returning({ id: counterSnapshots.id });
      await t.db.insert(counterValues).values([
        { snapshotId: s!.id, name: 'BlackTonerLevel', value: black },
        ...(cyan === undefined ? [] : [{ snapshotId: s!.id, name: 'CyanTonerLevel', value: cyan }]),
      ]);
    };
    await snap('X1', 50);
    await snap('X2', 10);
    // X3 is a colour device whose cyan (5) is far below its black (90): `least` must pick cyan.
    // X1 and X2 are mono (black only).
    await snap('X3', 90, 5);
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  describe('listDevices', () => {
    const ids = async (o: Parameters<typeof listDevices>[1]) => (await listDevices(t.db, o)).rows.map((r) => r.drmsId);

    it('sorts by every key, both directions, nulls last', async () => {
      await t.db.delete(counterSnapshots).where(eq(counterSnapshots.drmsEquipmentId, 'X5'));
      await t.db.delete(drmsEquipment).where(eq(drmsEquipment.drmsId, 'X5')); // keep the 4-row shape
      // `device` falls back to the DRMS id for an empty row, so it is not a null: checked below.
      await expectSortable(DEVICE_SORT_KEYS, (key, dir) => ids({ sort: { key, dir } }), 'X4', ['device']);
    });

    it('orders by the lowest toner level and by model', async () => {
      expect((await ids({ sort: { key: 'toner', dir: 'asc' } })).slice(0, 3)).toEqual(['X3', 'X2', 'X1']);
      expect((await ids({ sort: { key: 'toner', dir: 'desc' } })).slice(0, 3)).toEqual(['X1', 'X2', 'X3']);
      expect((await ids({ sort: { key: 'model', dir: 'asc' } })).slice(0, 3)).toEqual(['X2', 'X1', 'X3']);
    });

    it('sorts by the displayed name (customer + model when DRMS has no Name)', async () => {
      expect(await ids({ sort: { key: 'device', dir: 'asc' } })).toEqual(['X2', 'X5', 'X3', 'X4', 'X1']);
      expect(await ids({ sort: { key: 'device', dir: 'desc' } })).toEqual(['X1', 'X4', 'X3', 'X5', 'X2']);
    });

    it('is case-insensitive on text and ties break on the id', async () => {
      // 'amy' (lower case) sorts before 'Mid' and 'Zed'; X2 and X5 tie and fall back to the id.
      expect((await ids({ sort: { key: 'customer', dir: 'asc' } })).slice(0, 3)).toEqual(['X2', 'X5', 'X3']);
    });

    it('no sort keeps the default order; an unknown key falls back to it', async () => {
      const base = await ids({});
      expect(await ids({ sort: undefined })).toEqual(base);
      expect(await ids({ sort: { key: '__proto__' as never, dir: 'asc' } })).toEqual(base);
    });

    it('sorting keeps the filter and the total (one customer, model desc)', async () => {
      const r = await listDevices(t.db, { customer: 'amy', sort: { key: 'model', dir: 'desc' } });
      expect(r.rows.map((x) => x.drmsId)).toEqual(['X5', 'X2']);
      expect(r.total).toBe(2);
      const page2 = await listDevices(t.db, { customer: 'amy', sort: { key: 'model', dir: 'desc' }, limit: 1, offset: 1 });
      expect(page2.rows.map((x) => x.drmsId)).toEqual(['X2']);
      expect(page2.total).toBe(2);
    });
  });

  describe('listHiddenDevices', () => {
    beforeEach(async () => {
      await t.db.insert(hiddenDevices).values([
        { drmsEquipmentId: 'X1', hiddenAt: d('2026-09-01T00:00:00Z'), reason: 'b' },
        { drmsEquipmentId: 'X2', hiddenAt: d('2026-09-02T00:00:00Z'), reason: 'a' },
        { drmsEquipmentId: 'X3', hiddenAt: d('2026-09-03T00:00:00Z'), reason: 'C' },
        { drmsEquipmentId: 'X4', hiddenAt: d('2026-09-04T00:00:00Z'), reason: null },
      ]);
    });
    const ids = async (o: Parameters<typeof listHiddenDevices>[1]) => (await listHiddenDevices(t.db, o)).rows.map((r) => r.drmsId);
    it('default is newest hide first', async () => {
      expect(await ids({})).toEqual(['X4', 'X3', 'X2', 'X1']);
    });
    it('reason: both directions, null last, case-insensitive', async () => {
      await expectSortable(['reason'] as const, (key, dir) => ids({ sort: { key, dir } }), 'X4');
      expect(await ids({ sort: { key: 'reason', dir: 'asc' } })).toEqual(['X2', 'X1', 'X3', 'X4']);
    });
    it('device: by displayed name', async () => {
      expect(await ids({ sort: { key: 'device', dir: 'asc' } })).toEqual(['X2', 'X3', 'X4', 'X1']);
      expect(await ids({ sort: { key: 'device', dir: 'desc' } })).toEqual(['X1', 'X4', 'X3', 'X2']);
    });
    it('hidden: oldest first asc, with total and paging', async () => {
      const r = await listHiddenDevices(t.db, { sort: { key: 'hidden', dir: 'asc' }, limit: 2, offset: 1 });
      expect(r.rows.map((x) => x.drmsId)).toEqual(['X2', 'X3']);
      expect(r.total).toBe(4);
      expect(HIDDEN_SORT_KEYS).toEqual(['device', 'hidden', 'reason']);
    });
  });

  describe('listReconnect', () => {
    beforeEach(async () => {
      await t.db.insert(vantageEquipment).values([
        { vantageId: 1, serial: 'S3', customerName: 'Zed Ltd', location: 'Leeds', raw: {} },
        { vantageId: 2, serial: 'S1', customerName: 'amy plc', location: 'bath', raw: {} },
        { vantageId: 3, serial: 'S2', customerName: 'Mid Co', location: 'York', raw: {} },
        { vantageId: 4, serial: null, customerName: null, location: null, raw: {} },
      ]);
      const link = (drms: string, vantage: number) => ({ drmsEquipmentId: drms, vantageEquipmentId: vantage, method: 'serial' as const, linkedAt: d('2026-01-01T00:00:00Z') });
      await t.db.insert(deviceLinks).values([link('X1', 1), link('X2', 2), link('X3', 3), link('X4', 4)]);
      // X4 has no reading yet (unmonitored); give it an old one so all four are silent in one list.
      await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: d('2026-02-01T00:00:00Z') }).where(eq(drmsEquipment.drmsId, 'X4'));
    });
    const ids = async (o: Parameters<typeof listReconnect>[1]) => (await listReconnect(t.db, { now: NOW, ...o })).rows.map((r) => r.drmsId);
    it('every key, both directions, nulls last', async () => {
      // lastContact has no null here (X4's reading is the oldest, a real value): checked below.
      await expectSortable(RECONNECT_SORT_KEYS, (key, dir) => ids({ sort: { key, dir } }), 'X4', ['lastContact', 'device']);
    });
    it('device: by displayed name', async () => {
      expect(await ids({ sort: { key: 'device', dir: 'asc' } })).toEqual(['X2', 'X3', 'X4', 'X1']);
    });
    it('lastContact: oldest first asc, newest first desc', async () => {
      expect(await ids({ sort: { key: 'lastContact', dir: 'asc' } })).toEqual(['X4', 'X3', 'X1', 'X2']);
      expect(await ids({ sort: { key: 'lastContact', dir: 'desc' } })).toEqual(['X2', 'X1', 'X3', 'X4']);
    });
    it('keeps filter, total and paging', async () => {
      const r = await listReconnect(t.db, { now: NOW, sort: { key: 'customer', dir: 'asc' }, limit: 2, offset: 1 });
      expect(r.total).toBe(4);
      expect(r.rows.map((x) => x.drmsId)).toEqual(['X3', 'X1']);
    });
    it('no sort keeps the default (most recently silent first)', async () => {
      expect(await ids({})).toEqual(['X2', 'X1', 'X3', 'X4']);
    });
  });

  describe('listRegistrations', () => {
    beforeEach(async () => {
      const base = { status: 'registered' as const };
      await t.db.insert(drmsRegistrations).values([
        { ...base, drmsEquipmentId: 'X1', deviceName: 'Bravo', drmsCustomerName: 'Zed', createdAt: d('2026-09-01T00:00:00Z'), finishedAt: d('2026-09-05T00:00:00Z'), decidedAt: d('2026-09-02T00:00:00Z') },
        { ...base, drmsEquipmentId: 'X2', deviceName: 'alpha', drmsCustomerName: 'amy', createdAt: d('2026-09-02T00:00:00Z'), finishedAt: d('2026-09-06T00:00:00Z'), decidedAt: d('2026-09-03T00:00:00Z') },
        { ...base, drmsEquipmentId: 'X3', deviceName: 'Charlie', drmsCustomerName: 'Mid', createdAt: d('2026-09-03T00:00:00Z'), finishedAt: d('2026-09-07T00:00:00Z'), decidedAt: d('2026-09-04T00:00:00Z') },
        { ...base, drmsEquipmentId: 'X4', deviceName: null, drmsCustomerName: null, createdAt: d('2026-09-04T00:00:00Z'), finishedAt: null, decidedAt: null },
      ]);
    });
    const run = async (key: (typeof REGISTRATION_SORT_KEYS)[number], dir: 'asc' | 'desc') =>
      (await listRegistrations(t.db, { tab: 'registered', sort: { key, dir } })).rows.map((r) => r.drmsId);
    it('customer, finished, decided: both directions, null last', async () => {
      await expectSortable(['customer', 'finished', 'decided'] as const, run, 'X4');
    });
    it('machine and created reverse', async () => {
      // X4 has no name or model, so it shows (and sorts as) its DRMS id.
      expect(await run('machine', 'asc')).toEqual(['X2', 'X1', 'X3', 'X4']);
      expect(await run('machine', 'desc')).toEqual(['X4', 'X3', 'X1', 'X2']);
      expect(await run('created', 'asc')).toEqual(['X1', 'X2', 'X3', 'X4']);
      expect(await run('created', 'desc')).toEqual(['X4', 'X3', 'X2', 'X1']);
    });
    it('default tab order when no sort; total and paging kept', async () => {
      expect((await listRegistrations(t.db, { tab: 'registered' })).rows.map((r) => r.drmsId)).toEqual(['X3', 'X2', 'X1', 'X4']);
      const r = await listRegistrations(t.db, { tab: 'registered', sort: { key: 'created', dir: 'asc' }, limit: 2, offset: 2 });
      expect(r.rows.map((x) => x.drmsId)).toEqual(['X3', 'X4']);
      expect(r.total).toBe(4);
    });
  });

  describe('listIssues', () => {
    beforeEach(async () => {
      await t.db.insert(vantageEquipment).values([
        { vantageId: 1, serial: 'V3', raw: {} },
        { vantageId: 2, serial: 'V1', raw: {} },
        { vantageId: 3, serial: 'V2', raw: {} },
      ]);
      await t.db.insert(linkIssues).values([
        { issueKey: 'k1', type: 'b_type', drmsEquipmentId: 'X1', vantageEquipmentId: 1, lastSeen: d('2026-09-01T00:00:00Z') },
        { issueKey: 'k2', type: 'a_type', drmsEquipmentId: 'X2', vantageEquipmentId: 2, lastSeen: d('2026-09-02T00:00:00Z') },
        { issueKey: 'k3', type: 'c_type', drmsEquipmentId: 'X3', vantageEquipmentId: 3, lastSeen: d('2026-09-03T00:00:00Z') },
        { issueKey: 'k4', type: 'd_type', drmsEquipmentId: null, vantageEquipmentId: null, lastSeen: d('2026-09-04T00:00:00Z') },
      ]);
    });
    const types = async (o: Parameters<typeof listIssues>[1]) => (await listIssues(t.db, o)).rows.map((r) => r.type);
    it('default is newest lastSeen first', async () => {
      expect(await types({})).toEqual(['d_type', 'c_type', 'a_type', 'b_type']);
    });
    it('device and vantage: both directions, null last', async () => {
      const run = async (key: (typeof ISSUE_SORT_KEYS)[number], dir: 'asc' | 'desc') => (await types({ sort: { key, dir } }));
      await expectSortable(['vantage', 'device'] as const, run, 'd_type');
    });
    it('issue and seen reverse; total and paging kept', async () => {
      expect(await types({ sort: { key: 'issue', dir: 'asc' } })).toEqual(['a_type', 'b_type', 'c_type', 'd_type']);
      expect(await types({ sort: { key: 'issue', dir: 'desc' } })).toEqual(['d_type', 'c_type', 'b_type', 'a_type']);
      expect(await types({ sort: { key: 'seen', dir: 'asc' } })).toEqual(['b_type', 'a_type', 'c_type', 'd_type']);
      const r = await listIssues(t.db, { sort: { key: 'issue', dir: 'asc' }, limit: 2, offset: 2 });
      expect(r.rows.map((x) => x.type)).toEqual(['c_type', 'd_type']);
      expect(r.total).toBe(4);
    });
  });

  describe('listAlertsPage', () => {
    beforeEach(async () => {
      await t.db.insert(deviceAlerts).values([
        { drmsEquipmentId: 'X1', type: 'b_alert', firstDetectedAt: d('2026-09-01T00:00:00Z') },
        { drmsEquipmentId: 'X2', type: 'a_alert', firstDetectedAt: d('2026-09-02T00:00:00Z') },
        { drmsEquipmentId: 'X3', type: 'c_alert', firstDetectedAt: d('2026-09-03T00:00:00Z') },
        { drmsEquipmentId: 'X4', type: 'd_alert', firstDetectedAt: d('2026-09-04T00:00:00Z') },
      ]);
    });
    const page = (o: Partial<Parameters<typeof listAlertsPage>[1]> = {}) => listAlertsPage(t.db, { limit: 10, offset: 0, ...o });
    it('default newest first, same as listAlerts; offset and total', async () => {
      const all = await listAlerts(t.db, { limit: 10 });
      const p = await page({ limit: 2, offset: 1 });
      expect(p.rows.map((r) => r.id)).toEqual(all.slice(1, 3).map((r) => r.id));
      expect(p.total).toBe(4);
      expect((await page({ limit: 2, offset: 3 })).rows).toHaveLength(1);
    });
    it('the status filter shapes the total', async () => {
      expect((await page({ status: 'cleared' })).total).toBe(0);
      expect((await page({ status: 'open' })).total).toBe(4);
    });
    it('customer: both directions, null last', async () => {
      await expectSortable(ALERT_SORT_KEYS, async (key, dir) => (await page({ sort: { key, dir } })).rows.map((r) => r.drmsId), 'X4', ['device', 'alert', 'detected']);
    });
    it('alert, detected and device order', async () => {
      const col = async (key: (typeof ALERT_SORT_KEYS)[number], dir: 'asc' | 'desc') => (await page({ sort: { key, dir } })).rows;
      expect((await col('alert', 'asc')).map((r) => r.type)).toEqual(['a_alert', 'b_alert', 'c_alert', 'd_alert']);
      expect((await col('alert', 'desc')).map((r) => r.type)).toEqual(['d_alert', 'c_alert', 'b_alert', 'a_alert']);
      expect((await col('detected', 'asc')).map((r) => r.drmsId)).toEqual(['X1', 'X2', 'X3', 'X4']);
      expect((await col('device', 'asc')).map((r) => r.drmsId)).toEqual(['X2', 'X1', 'X3', 'X4']);
    });
  });
});
