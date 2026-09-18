import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { counterNames, counterSnapshots, counterValues, deviceAlerts, drmsEquipment, linkIssues } from '../schema';
import { createTestDb, seedDemoFixture, type DemoFixture, type TestDb } from '../testing';
import { listUsers, listCounterNames, listSyncRuns, getAppStateValue } from './admin';
import { listAlerts } from './alerts';
import { getCounterHistory, getDevice, getLatestCounters } from './device';
import { listDevices } from './devices';
import { getFleetSummary } from './fleet';
import { listIssues, searchVantageEquipment } from './issues';

describe('queries', () => {
  let t: TestDb;
  let f: DemoFixture;
  beforeEach(async () => {
    t = await createTestDb();
    f = await seedDemoFixture(t.db);
  });
  afterEach(() => t.close());

  describe('getFleetSummary', () => {
    it('counts devices, monitored, linked, toner tiers, offline and open issues', async () => {
      const summary = await getFleetSummary(t.db);
      expect(summary.devices).toBe(3);
      expect(summary.monitored).toBe(3);
      expect(summary.linked).toBe(2);
      expect(summary.needsToner).toBe(1);
      expect(summary.criticalToner).toBe(1);
      expect(summary.lowToner).toBe(0);
      expect(summary.offline).toBe(1);
      expect(summary.openIssues).toBe(2);
      expect(summary.lastSyncAt?.getTime()).toBeCloseTo(Date.now() - 3_600_000, -3);
    });

    it('distinguishes low toner (>=5%) from critical toner (<5%) devices', async () => {
      // A dedicated device with only a low (non-critical) toner colour, to test the tier split
      // in isolation from the shared fixture (whose only monitored device with counters, D1, is
      // already critical).
      await t.db.insert(drmsEquipment).values({
        drmsId: 'LOW1',
        serial: 'SNLOW0001',
        status: 'Registered',
        customerName: 'Low Toner Co',
        raw: {},
      });
      const [snap] = await t.db
        .insert(counterSnapshots)
        .values({ drmsEquipmentId: 'LOW1', counterId: 'low-c1', receivedTime: new Date(), raw: {} })
        .returning({ id: counterSnapshots.id });
      await t.db.insert(counterValues).values([
        { snapshotId: snap!.id, name: 'BlackTonerLevel', value: 18 },
        { snapshotId: snap!.id, name: 'CyanTonerLevel', value: 90 },
      ]);

      const summary = await getFleetSummary(t.db);
      // D1 (critical) + LOW1 (low) both need toner; only D1 is critical; LOW1 is the low-only one.
      expect(summary.needsToner).toBe(2);
      expect(summary.criticalToner).toBe(1);
      expect(summary.lowToner).toBe(1);
    });

    it('honours a custom offline threshold', async () => {
      const summary = await getFleetSummary(t.db, { offlineHours: 48 });
      expect(summary.offline).toBe(0);
    });
  });

  describe('listDevices', () => {
    it('returns toner and meter values on the right device', async () => {
      const { rows } = await listDevices(t.db);
      expect(rows).toHaveLength(3);
      const d1 = rows.find((r) => r.drmsId === f.drms.online);
      expect(d1?.toner).toEqual({ black: 3, cyan: 15, magenta: 60, yellow: 70 });
      expect(d1?.meters).toEqual({ black: 15000, colour: 4200, scan: 3000 });
      expect(d1?.vantageEquipmentId).toBe(f.vantage.linkedToOnline);
      expect(d1?.vantageCustomerName).toBe('Acme Ltd (Vantage)');
      expect(d1?.offline).toBe(false);

      const d3 = rows.find((r) => r.drmsId === f.drms.unlinked);
      expect(d3?.toner).toEqual({ black: null, cyan: null, magenta: null, yellow: null });
      expect(d3?.vantageEquipmentId).toBeNull();
    });

    it('filters by needs-toner, offline and unlinked, each returning only the matching device', async () => {
      const needsToner = await listDevices(t.db, { filter: 'needs-toner' });
      expect(needsToner.rows.map((r) => r.drmsId)).toEqual([f.drms.online]);

      const offline = await listDevices(t.db, { filter: 'offline' });
      expect(offline.rows.map((r) => r.drmsId)).toEqual([f.drms.offline]);

      const unlinked = await listDevices(t.db, { filter: 'unlinked' });
      expect(unlinked.rows.map((r) => r.drmsId)).toEqual([f.drms.unlinked]);
    });

    it('searches by serial and by customer name (DRMS or Vantage), case-insensitively', async () => {
      const bySerial = await listDevices(t.db, { search: 'sn0000002' });
      expect(bySerial.rows.map((r) => r.drmsId)).toEqual([f.drms.offline]);

      const byVantageCustomer = await listDevices(t.db, { search: 'acme ltd (vantage)' });
      expect(byVantageCustomer.rows.map((r) => r.drmsId)).toEqual([f.drms.online]);
    });

    it('returns the unfiltered-by-paging total count', async () => {
      const { rows, total } = await listDevices(t.db, { limit: 1 });
      expect(rows).toHaveLength(1);
      expect(total).toBe(3);
    });
  });

  describe('getDevice / getLatestCounters / getCounterHistory', () => {
    it('getDevice returns the joined detail for a linked device', async () => {
      const detail = await getDevice(t.db, f.drms.online);
      expect(detail).not.toBeNull();
      expect(detail?.device.serial).toBe('SN0000001');
      expect(detail?.device.vantageEquipmentId).toBe(f.vantage.linkedToOnline);
      expect(detail?.device.toner.black).toBe(3);
      expect(detail?.latestSnapshotAt?.getTime()).toBeCloseTo(Date.now() - 2 * 3_600_000, -3);
      expect(detail?.drmsRaw).toEqual({});
      expect(detail?.vantageRaw).toEqual({});
    });

    it('getDevice returns null for an unknown drms id', async () => {
      expect(await getDevice(t.db, 'does-not-exist')).toBeNull();
    });

    it('getLatestCounters returns names with categories from the latest snapshot', async () => {
      const counters = await getLatestCounters(t.db, f.drms.online);
      const byName = Object.fromEntries(counters.map((c) => [c.name, c]));
      expect(byName['BlackTonerLevel']).toMatchObject({ value: 3, category: 'supply' });
      expect(byName['Black:Total']).toMatchObject({ value: 15000, category: 'meter' });
      // Values are from the latest snapshot only, not the older one.
      expect(counters.find((c) => c.name === 'BlackTonerLevel')?.value).not.toBe(10);
    });

    it('getCounterHistory returns points in ascending date order for the requested names', async () => {
      const history = await getCounterHistory(t.db, f.drms.online, ['BlackTonerLevel', 'Black:Total']);
      expect(history['BlackTonerLevel']).toHaveLength(2);
      expect(history['BlackTonerLevel']![0]!.value).toBe(10);
      expect(history['BlackTonerLevel']![1]!.value).toBe(3);
      expect(history['BlackTonerLevel']![0]!.at.getTime()).toBeLessThan(history['BlackTonerLevel']![1]!.at.getTime());
      expect(history['Black:Total']).toHaveLength(2);
    });
  });

  describe('listIssues / searchVantageEquipment', () => {
    it('returns rows with joined names plus countsByType', async () => {
      const { rows, total, countsByType } = await listIssues(t.db);
      expect(total).toBe(2);
      expect(countsByType).toEqual({ unlinked_drms: 1, conflicting_customer: 1 });
      const unlinked = rows.find((r) => r.type === 'unlinked_drms');
      expect(unlinked?.drmsId).toBe(f.drms.unlinked);
      expect(unlinked?.drmsSerial).toBe('SN0000003');
      const conflicting = rows.find((r) => r.type === 'conflicting_customer');
      expect(conflicting?.drmsSerial).toBe('SN0000002');
      expect(conflicting?.vantageSerial).toBe('SN0000002');
      expect(conflicting?.vantageCustomerName).toBe('Beta Co (Vantage)');
    });

    it('filters by type and status', async () => {
      const { rows, total } = await listIssues(t.db, { type: 'unlinked_drms' });
      expect(total).toBe(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe('unlinked_drms');

      const resolved = await listIssues(t.db, { status: 'resolved' });
      expect(resolved.total).toBe(0);
    });

    it('searchVantageEquipment finds by serial and marks an already-linked record', async () => {
      const found = await searchVantageEquipment(t.db, 'SN0000001');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ vantageId: f.vantage.linkedToOnline, linkedToDrmsId: f.drms.online });
    });
  });

  describe('listAlerts', () => {
    it('returns only open alerts by default, with the device name', async () => {
      const alerts = await listAlerts(t.db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ drmsId: f.drms.offline, type: 'SC-541', acknowledgedAt: null });
      expect(alerts[0]?.deviceName).toBe('Beta Branch MFP');
    });

    it('includeCleared adds cleared alerts, with the acknowledging user name', async () => {
      const alerts = await listAlerts(t.db, { includeCleared: true });
      expect(alerts).toHaveLength(2);
      const cleared = alerts.find((a) => a.type === 'toner-low');
      expect(cleared?.acknowledgedByName).toBe(f.user.username);
    });
  });

  describe('admin queries', () => {
    it('listUsers returns the seeded user', async () => {
      const rows = await listUsers(t.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ username: f.user.username, role: 'admin', active: true });
    });

    it('listCounterNames returns the seeded counter names', async () => {
      const rows = await listCounterNames(t.db);
      const names = rows.map((r) => r.name);
      expect(names).toContain('BlackTonerLevel');
      expect(names).toContain('Black:Total');
    });

    it('listSyncRuns returns the seeded runs', async () => {
      const rows = await listSyncRuns(t.db);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.job).sort()).toEqual(['drms-pull', 'vantage-pull']);
    });

    it('getAppStateValue re-exports getAppState behaviour', async () => {
      expect(await getAppStateValue(t.db, 'missing-key')).toBeNull();
    });
  });

  it('sanity: fixture rows exist and are wired the way the tests above assume', async () => {
    const openDeviceAlerts = await t.db.select().from(deviceAlerts).where(isNull(deviceAlerts.clearedAt));
    expect(openDeviceAlerts).toHaveLength(1);
    const openIssues = await t.db.select().from(linkIssues).where(and(eq(linkIssues.status, 'open')));
    expect(openIssues).toHaveLength(2);
    const names = await t.db.select().from(counterNames);
    expect(names.length).toBeGreaterThanOrEqual(4);
  });
});
