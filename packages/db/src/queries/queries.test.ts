import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  counterNames,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceAlerts,
  deviceLinks,
  drmsEquipment,
  linkIssues,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { createTestDb, seedDemoFixture, type DemoFixture, type TestDb } from '../testing';
import { listUsers, listCounterNames, listSyncRuns, getAppStateValue } from './admin';
import { countAlerts, listAlerts } from './alerts';
import { getCounterHistory, getDevice, getLatestCounters, listDeviceAlarms, listDeviceOrders } from './device';
import { listDevices } from './devices';
import { getCollectionStatus, getConsumableWarnings, getCustomerCount, getFleetSummary, getTonerHealth } from './fleet';
import { getIssueCounts, listIssues, searchVantageEquipment } from './issues';

// Frozen "now" for the whole suite: seedDemoFixture's hoursAgo()/daysAgo() helpers and the query
// layer's own Date.now() calls (offlineCutoff, etc.) both read this, so every timestamp
// relationship is exact and doesn't depend on real wall-clock time. Only Date is faked (not
// setTimeout/setInterval/microtasks), so PGlite's own async plumbing is unaffected.
const FIXED_NOW = new Date('2026-09-18T12:00:00Z');

describe('queries', () => {
  let t: TestDb;
  let f: DemoFixture;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    t = await createTestDb();
    f = await seedDemoFixture(t.db);
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

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
      expect(summary.lastSyncAt?.getTime()).toBe(FIXED_NOW.getTime() - 3_600_000);
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

  describe('getCollectionStatus', () => {
    it('reports the newest reading, the reporting fleet and the stale part of it', async () => {
      // Fixture: D1 reported 2h ago, D2 30h ago, D3 has never reported.
      const status = await getCollectionStatus(t.db);
      expect(status.newestReadingAt?.getTime()).toBe(FIXED_NOW.getTime() - 2 * 3_600_000);
      expect(status.devicesExpectingReadings).toBe(2);
      expect(status.devicesStale).toBe(1);
      expect(status.outage).toBe(false);
    });

    it('flags an outage once every reporting device is stale', async () => {
      const staleAt = new Date(FIXED_NOW.getTime() - 26 * 3_600_000);
      await t.db
        .update(drmsEquipment)
        .set({ lastCounterReceivedTime: staleAt })
        .where(eq(drmsEquipment.drmsId, f.drms.online));

      const status = await getCollectionStatus(t.db);
      expect(status).toEqual({
        newestReadingAt: staleAt,
        devicesExpectingReadings: 2,
        devicesStale: 2,
        outage: true,
      });
    });

    it('is not an outage when no device has ever reported', async () => {
      await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: null });
      expect(await getCollectionStatus(t.db)).toEqual({
        newestReadingAt: null,
        devicesExpectingReadings: 0,
        devicesStale: 0,
        outage: false,
      });
    });

    it('ignores devices DRMS no longer expects to hear from', async () => {
      // D2 (the stale one) goes missing, so only the fresh D1 is still expected: not an outage,
      // and D2 must not be counted on either side of the tally.
      await t.db
        .update(drmsEquipment)
        .set({ missingSince: FIXED_NOW })
        .where(eq(drmsEquipment.drmsId, f.drms.offline));

      const status = await getCollectionStatus(t.db);
      expect(status.devicesExpectingReadings).toBe(1);
      expect(status.devicesStale).toBe(0);
      expect(status.outage).toBe(false);
    });

    it('honours a custom staleness threshold', async () => {
      const status = await getCollectionStatus(t.db, { staleHours: 48 });
      expect(status.devicesStale).toBe(0);
      expect(status.outage).toBe(false);
    });
  });

  describe('getTonerHealth', () => {
    it('tallies cartridges (not devices) by threshold from the latest snapshot, in SQL', async () => {
      // Only D1 has any counter snapshot: black=3 (critical), cyan=15 (low), magenta=60 (ok),
      // yellow=70 (ok). D2/D3 have no snapshot at all, so they contribute nothing.
      const health = await getTonerHealth(t.db);
      expect(health).toEqual({ healthy: 2, low: 1, critical: 1, cartridges: 4, devices: 1 });
    });

    it('counts a device once even when several of its channels are low/critical', async () => {
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
        { snapshotId: snap!.id, name: 'BlackTonerLevel', value: 2 },
        { snapshotId: snap!.id, name: 'CyanTonerLevel', value: 4 },
      ]);

      const health = await getTonerHealth(t.db);
      // D1's 4 cartridges + LOW1's 2 (both critical) = 6 cartridges across 2 devices.
      expect(health).toEqual({ healthy: 2, low: 1, critical: 3, cartridges: 6, devices: 2 });
    });
  });

  describe('getCustomerCount', () => {
    it('counts every device, preferring the linked Vantage customer name and falling back to the DRMS one when unlinked', async () => {
      // D1 -> "Acme Ltd (Vantage)", D2 -> "Beta Co (Vantage)", D3 is unlinked -> falls back to its
      // DRMS customerName "Gamma Inc" — matching the old page's `vantageCustomerName ?? customerName`.
      expect(await getCustomerCount(t.db)).toBe(3);
    });

    it('counts a shared customer name once', async () => {
      await t.db
        .update(vantageEquipment)
        .set({ customerName: 'Acme Ltd (Vantage)' })
        .where(eq(vantageEquipment.vantageId, f.vantage.linkedToOffline));
      // D1 and D2 now share a name; D3's DRMS fallback is still distinct.
      expect(await getCustomerCount(t.db)).toBe(2);
    });

    it('a linked device with no Vantage customer name falls back to its DRMS name too', async () => {
      await t.db
        .update(vantageEquipment)
        .set({ customerName: null })
        .where(eq(vantageEquipment.vantageId, f.vantage.linkedToOnline));
      // D1 now surfaces its DRMS customerName ("Acme Ltd") instead of contributing nothing.
      const count = await getCustomerCount(t.db);
      expect(count).toBe(3);
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

    it('sort: "urgent" orders critical toner, then low, then offline, then unlinked, in SQL', async () => {
      // A healthy, linked, online device whose id sorts alphabetically before every fixture id, so
      // the default (drmsId) order and the urgent order disagree — proving the ordering really
      // happens in SQL rather than by accident matching insertion order.
      await t.db.insert(drmsEquipment).values({
        drmsId: 'A0-HEALTHY',
        serial: 'SNHEALTHY1',
        status: 'Registered',
        customerName: 'Healthy Co',
        lastCounterReceivedTime: new Date(),
        raw: {},
      });
      const [snap] = await t.db
        .insert(counterSnapshots)
        .values({ drmsEquipmentId: 'A0-HEALTHY', counterId: 'healthy-c1', receivedTime: new Date(), raw: {} })
        .returning({ id: counterSnapshots.id });
      await t.db.insert(counterValues).values([
        { snapshotId: snap!.id, name: 'BlackTonerLevel', value: 80 },
        { snapshotId: snap!.id, name: 'CyanTonerLevel', value: 80 },
        { snapshotId: snap!.id, name: 'MagentaTonerLevel', value: 80 },
        { snapshotId: snap!.id, name: 'YellowTonerLevel', value: 80 },
      ]);
      await t.db.insert(vantageEquipment).values({
        vantageId: 1003,
        serial: 'SNHEALTHY1',
        serialNorm: 'snhealthy1',
        customerName: 'Healthy Co (Vantage)',
        raw: {},
      });
      await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'A0-HEALTHY', vantageEquipmentId: 1003, method: 'serial' });

      // D1 has critical toner (black=3%); D2 is offline with no counters; D3 has no counters and no
      // link; A0-HEALTHY is fine on every count, so it ranks last despite sorting first by id.
      const { rows } = await listDevices(t.db, { sort: 'urgent' });
      expect(rows.map((r) => r.drmsId)).toEqual([f.drms.online, f.drms.offline, f.drms.unlinked, 'A0-HEALTHY']);

      // Without the option, the existing drmsId ordering is unaffected.
      const unsorted = await listDevices(t.db);
      expect(unsorted.rows.map((r) => r.drmsId)).toEqual(['A0-HEALTHY', f.drms.online, f.drms.offline, f.drms.unlinked]);
    });

    describe('lastAlarmAt', () => {
      it('is the newest alarm per device, and null for a device with none', async () => {
        const newest = new Date(FIXED_NOW.getTime() - 40 * 60_000);
        await t.db.insert(deviceAlarms).values([
          {
            alarmId: 'a-old',
            drmsEquipmentId: f.drms.offline,
            receivedTime: new Date(FIXED_NOW.getTime() - 5 * 86_400_000),
            category: 'toner',
            raw: {},
          },
          { alarmId: 'a-new', drmsEquipmentId: f.drms.offline, receivedTime: newest, category: 'toner', raw: {} },
          {
            alarmId: 'a-other',
            drmsEquipmentId: f.drms.online,
            receivedTime: new Date(FIXED_NOW.getTime() - 3 * 86_400_000),
            category: 'jam',
            raw: {},
          },
        ]);

        const { rows } = await listDevices(t.db);
        const byId = new Map(rows.map((r) => [r.drmsId, r]));
        // The device with no meter reading is still talking to CSRC — an alarm arrived 40 min ago.
        expect(byId.get(f.drms.offline)?.lastAlarmAt?.getTime()).toBe(newest.getTime());
        expect(byId.get(f.drms.online)?.lastAlarmAt?.getTime()).toBe(FIXED_NOW.getTime() - 3 * 86_400_000);
        expect(byId.get(f.drms.unlinked)?.lastAlarmAt).toBeNull();
      });

      it('does not multiply rows when a device has several alarms', async () => {
        await t.db.insert(deviceAlarms).values(
          [1, 2, 3].map((i) => ({
            alarmId: `dup-${i}`,
            drmsEquipmentId: f.drms.online,
            receivedTime: new Date(FIXED_NOW.getTime() - i * 3_600_000),
            category: 'toner',
            raw: {},
          })),
        );

        const { rows, total } = await listDevices(t.db);
        expect(rows).toHaveLength(3);
        expect(total).toBe(3);
      });
    });
  });

  describe('getDevice / getLatestCounters / getCounterHistory', () => {
    it('getDevice returns the joined detail for a linked device', async () => {
      const detail = await getDevice(t.db, f.drms.online);
      expect(detail).not.toBeNull();
      expect(detail?.device.serial).toBe('SN0000001');
      expect(detail?.device.vantageEquipmentId).toBe(f.vantage.linkedToOnline);
      expect(detail?.device.toner.black).toBe(3);
      expect(detail?.latestSnapshotAt?.getTime()).toBe(FIXED_NOW.getTime() - 2 * 3_600_000);
      expect(detail?.drmsRaw).toEqual({});
      expect(detail?.vantageRaw).toEqual({});
    });

    it('getDevice carries lastAlarmAt, the second signal that a device is reaching CSRC', async () => {
      const newest = new Date(FIXED_NOW.getTime() - 27 * 60_000);
      await t.db.insert(deviceAlarms).values([
        {
          alarmId: 'det-old',
          drmsEquipmentId: f.drms.offline,
          receivedTime: new Date(FIXED_NOW.getTime() - 2 * 86_400_000),
          category: 'toner',
          raw: {},
        },
        { alarmId: 'det-new', drmsEquipmentId: f.drms.offline, receivedTime: newest, category: 'toner', raw: {} },
      ]);

      const detail = await getDevice(t.db, f.drms.offline);
      expect(detail?.device.lastAlarmAt?.getTime()).toBe(newest.getTime());
      // And null where a device has never raised one.
      expect((await getDevice(t.db, f.drms.unlinked))?.device.lastAlarmAt).toBeNull();
    });

    it('getDevice returns null for an unknown drms id', async () => {
      expect(await getDevice(t.db, 'does-not-exist')).toBeNull();
    });

    it('getDevice returns the DRMS record and the active link for the detail page', async () => {
      const detail = await getDevice(t.db, f.drms.online);
      expect(detail?.record).toMatchObject({ erpId: 'E1', customerErpId: 'C1' });
      expect(detail?.link).toMatchObject({
        vantageEquipmentId: f.vantage.linkedToOnline,
        assetNumber: 'AST-1',
        customerName: 'Acme Ltd (Vantage)',
        method: 'serial',
      });
      expect(detail?.link.linkedAt?.getTime()).toBe(FIXED_NOW.getTime() - 100 * 86_400_000);
      // Ruled out until a contracts source exists — the page renders an em dash for it.
      expect(detail?.contractRef).toBeNull();
    });

    it('getDevice leaves the link block empty for an unlinked device', async () => {
      const detail = await getDevice(t.db, f.drms.unlinked);
      expect(detail?.link).toEqual({
        vantageEquipmentId: null,
        assetNumber: null,
        description: null,
        location: null,
        customerName: null,
        method: null,
        linkedAt: null,
      });
      expect(detail?.record.erpId).toBe('E3');
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

    it('excludes types from the rows but still counts them', async () => {
      const { rows, total, countsByType } = await listIssues(t.db, { excludeTypes: ['unlinked_drms'] });
      expect(total).toBe(1);
      expect(rows.map((r) => r.type)).toEqual(['conflicting_customer']);
      // The hidden type keeps its count, so its own tab can still say how many rows are behind it.
      expect(countsByType).toEqual({ unlinked_drms: 1, conflicting_customer: 1 });
    });

    it('reports the device’s live link, for the Unlink action', async () => {
      const { rows } = await listIssues(t.db);
      // D2 is actively linked to 1002; D3 has no link at all.
      expect(rows.find((r) => r.drmsId === f.drms.offline)?.linkedVantageId).toBe(f.vantage.linkedToOffline);
      expect(rows.find((r) => r.drmsId === f.drms.unlinked)?.linkedVantageId).toBeNull();

      await t.db
        .update(deviceLinks)
        .set({ unlinkedAt: new Date(), unlinkedReason: 'manual_unlink' })
        .where(eq(deviceLinks.drmsEquipmentId, f.drms.offline));
      const after = await listIssues(t.db);
      expect(after.rows.find((r) => r.drmsId === f.drms.offline)?.linkedVantageId).toBeNull();
    });

    it('searchVantageEquipment finds by serial and marks an already-linked record', async () => {
      const found = await searchVantageEquipment(t.db, 'SN0000001');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ vantageId: f.vantage.linkedToOnline, linkedToDrmsId: f.drms.online });
    });
  });

  describe('getIssueCounts', () => {
    it('matches listIssues’ countsByType without fetching any issue rows', async () => {
      expect(await getIssueCounts(t.db, { status: 'open' })).toEqual({
        unlinked_drms: 1,
        conflicting_customer: 1,
      });
    });

    it('honours the status filter, same as listIssues', async () => {
      expect(await getIssueCounts(t.db, { status: 'resolved' })).toEqual({});
    });
  });

  describe('listAlerts', () => {
    it('returns only open alerts by default, with the device name', async () => {
      const alerts = await listAlerts(t.db);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ drmsId: f.drms.offline, type: 'SC-541', acknowledgedAt: null });
      expect(alerts[0]?.deviceName).toBe('Beta Branch MFP');
    });

    it('drmsId narrows to one device, as the device detail page needs', async () => {
      expect(await listAlerts(t.db, { drmsId: f.drms.offline })).toHaveLength(1);
      // The online device's only alert is cleared, so it is absent unless asked for.
      expect(await listAlerts(t.db, { drmsId: f.drms.online })).toHaveLength(0);
      expect(await listAlerts(t.db, { drmsId: f.drms.online, includeCleared: true })).toHaveLength(1);
    });

    it('includeCleared adds cleared alerts, with the acknowledging user name', async () => {
      const alerts = await listAlerts(t.db, { includeCleared: true });
      expect(alerts).toHaveLength(2);
      const cleared = alerts.find((a) => a.type === 'toner-low');
      expect(cleared?.acknowledgedByName).toBe(f.user.username);
      expect(cleared?.clearedAt).toBeInstanceOf(Date);
    });

    describe('status, as the /alerts tabs use it', () => {
      // An alert somebody has taken on, but which the device has not answered by reporting again.
      beforeEach(async () => {
        await t.db
          .update(deviceAlerts)
          .set({ acknowledgedBy: f.user.id, acknowledgedAt: FIXED_NOW })
          .where(eq(deviceAlerts.id, f.alerts.open));
      });

      it('splits uncleared alerts into open and acknowledged', async () => {
        expect(await listAlerts(t.db, { status: 'open' })).toHaveLength(0);

        const acknowledged = await listAlerts(t.db, { status: 'acknowledged' });
        expect(acknowledged).toHaveLength(1);
        expect(acknowledged[0]).toMatchObject({ id: f.alerts.open, clearedAt: null });
        expect(acknowledged[0]?.acknowledgedByName).toBe(f.user.username);
      });

      it('cleared returns the cleared alert, acknowledged or not', async () => {
        const cleared = await listAlerts(t.db, { status: 'cleared' });
        expect(cleared).toHaveLength(1);
        expect(cleared[0]?.id).toBe(f.alerts.cleared);
      });

      it('countAlerts counts all three states in one pass', async () => {
        expect(await countAlerts(t.db)).toEqual({ open: 0, acknowledged: 1, cleared: 1 });
        expect(await countAlerts(t.db, { drmsId: f.drms.online })).toEqual({ open: 0, acknowledged: 0, cleared: 1 });
      });
    });
  });

  describe('listDeviceAlarms / getConsumableWarnings', () => {
    const daysAgo = (d: number) => new Date(FIXED_NOW.getTime() - d * 86_400_000);
    const hoursAgo = (h: number) => new Date(FIXED_NOW.getTime() - h * 3_600_000);

    beforeEach(async () => {
      await t.db.insert(deviceAlarms).values([
        {
          alarmId: 'al-toner',
          drmsEquipmentId: f.drms.online,
          receivedTime: hoursAgo(2),
          fcCode: 'TN-00',
          description: 'Toner near empty',
          status: 'EquipmentDiscovered',
          category: 'toner',
          raw: {},
        },
        {
          alarmId: 'al-waste',
          drmsEquipmentId: f.drms.online,
          receivedTime: hoursAgo(1),
          fcCode: 'TO-00',
          description: 'Waste toner almost full',
          status: 'ReadyForErpDelivery',
          category: 'waste',
          raw: {},
        },
        {
          alarmId: 'al-parts-old',
          drmsEquipmentId: f.drms.online,
          receivedTime: daysAgo(40),
          fcCode: 'TP-00',
          description: 'PartsLife(IU_C) 1st Call',
          status: 'EquipmentDiscovered',
          category: 'parts',
          raw: {},
        },
        {
          alarmId: 'al-parts-d2',
          drmsEquipmentId: f.drms.offline,
          receivedTime: daysAgo(5),
          fcCode: 'TP-01',
          description: 'PartsLife(IU_M) 2nd Call',
          status: 'EquipmentDiscovered',
          category: 'parts',
          raw: {},
        },
      ]);
    });

    it('listDeviceAlarms returns a devicealarms newest first', async () => {
      const alarms = await listDeviceAlarms(t.db, f.drms.online);
      expect(alarms.map((a) => a.alarmId)).toEqual(['al-waste', 'al-toner', 'al-parts-old']);
    });

    it('listDeviceAlarms filters by category and respects limit', async () => {
      const waste = await listDeviceAlarms(t.db, f.drms.online, { categories: ['waste'] });
      expect(waste.map((a) => a.alarmId)).toEqual(['al-waste']);

      const limited = await listDeviceAlarms(t.db, f.drms.online, { limit: 1 });
      expect(limited).toHaveLength(1);
      expect(limited[0]?.alarmId).toBe('al-waste');
    });

    it('returns no rows for a device with no alarms', async () => {
      expect(await listDeviceAlarms(t.db, f.drms.unlinked)).toEqual([]);
    });

    it('getConsumableWarnings returns the latest waste/parts alarm per device within 30 days, excluding toner and stale alarms', async () => {
      const warnings = await getConsumableWarnings(t.db);
      const byDevice = Object.fromEntries(warnings.map((w) => [`${w.drmsId}:${w.category}`, w]));
      expect(Object.keys(byDevice).sort()).toEqual([`${f.drms.online}:waste`, `${f.drms.offline}:parts`].sort());
      expect(byDevice[`${f.drms.online}:waste`]?.fcCode).toBe('TO-00');
      expect(byDevice[`${f.drms.offline}:parts`]?.fcCode).toBe('TP-01');
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

  describe('listDeviceOrders', () => {
    const daysAgo = (d: number) => new Date(FIXED_NOW.getTime() - d * 86_400_000);
    /** The Vantage equipment linked to the online device; `other` belongs to the offline one. */
    let eq1: number;
    let other: number;

    beforeEach(async () => {
      eq1 = f.vantage.linkedToOnline;
      other = f.vantage.linkedToOffline;

      await t.db.insert(vantageSalesOrders).values([
        // Newest. Header names the device; open, and raised by this app.
        {
          vantageId: 500,
          reference: 'SO2609-0214',
          orderDate: daysAgo(3),
          completedDate: null,
          isOnHold: false,
          typeId: 1,
          typeName: 'Consumable order',
          createdByMps: true,
          vantageEquipmentId: eq1,
          raw: {},
        },
        // Header points at another device; only its line names this one. Completed.
        {
          vantageId: 501,
          reference: 'SO2608-0100',
          orderDate: daysAgo(20),
          completedDate: daysAgo(18),
          isOnHold: false,
          typeName: 'Consumable order',
          vantageEquipmentId: other,
          raw: {},
        },
        // Oldest, header-linked, on hold. Its black line was returned.
        {
          vantageId: 502,
          reference: 'SO2604-0001',
          orderDate: daysAgo(150),
          completedDate: daysAgo(140),
          isOnHold: true,
          typeName: 'Consumable order',
          vantageEquipmentId: eq1,
          raw: {},
        },
        // Belongs to a different device entirely, and must never appear.
        {
          vantageId: 503,
          reference: 'SO2609-9999',
          orderDate: daysAgo(1),
          vantageEquipmentId: other,
          raw: {},
        },
        // Soft-deleted, header-linked: excluded like every other vantage_* read.
        {
          vantageId: 504,
          reference: 'SO2609-DEL',
          orderDate: daysAgo(2),
          vantageEquipmentId: eq1,
          deletedDate: daysAgo(1),
          raw: {},
        },
      ]);

      await t.db.insert(vantageSalesOrderLines).values([
        {
          vantageId: 5000,
          salesOrderId: 500,
          itemPartNumber: 'MISC',
          itemDescription: 'Miscellaneous',
          details: 'Xerox B310 Black Toner',
          quantity: '2',
          colour: 'black',
          colourSource: 'details',
          raw: {},
        },
        {
          vantageId: 5001,
          salesOrderId: 500,
          itemPartNumber: 'MIN90014',
          details: 'Konica Minolta C3351i Waste Toner',
          quantity: '1',
          colour: 'waste',
          colourSource: 'details',
          raw: {},
        },
        // The only thing tying order 501 to this device.
        {
          vantageId: 5010,
          salesOrderId: 501,
          vantageEquipmentId: eq1,
          itemPartNumber: 'B1168',
          details: 'Olivetti MF304 Magenta Toner',
          quantity: '1',
          colour: 'magenta',
          colourSource: 'details',
          raw: {},
        },
        // Returned: never counts as "last sent".
        {
          vantageId: 5020,
          salesOrderId: 502,
          itemPartNumber: 'TN328K',
          details: 'Black Toner',
          quantity: '1',
          returnedDate: daysAgo(130),
          colour: 'black',
          colourSource: 'details',
          raw: {},
        },
        {
          vantageId: 5021,
          salesOrderId: 502,
          itemPartNumber: 'MISC',
          details: 'Callout charge',
          quantity: '1',
          colour: 'unknown',
          colourSource: 'none',
          raw: {},
        },
        { vantageId: 5030, salesOrderId: 503, details: 'Cyan Toner', colour: 'cyan', colourSource: 'details', raw: {} },
        { vantageId: 5040, salesOrderId: 504, details: 'Yellow Toner', colour: 'yellow', colourSource: 'details', raw: {} },
      ]);
    });

    it('returns the device orders newest first, by header link or by line link', async () => {
      const { orders } = await listDeviceOrders(t.db, eq1);
      expect(orders.map((o) => o.vantageId)).toEqual([500, 501, 502]);
      expect(orders.map((o) => o.reference)).toEqual(['SO2609-0214', 'SO2608-0100', 'SO2604-0001']);
    });

    it('excludes soft-deleted orders and other devices orders', async () => {
      const refs = (await listDeviceOrders(t.db, eq1)).orders.map((o) => o.reference);
      expect(refs).not.toContain('SO2609-DEL');
      expect(refs).not.toContain('SO2609-9999');
    });

    it('attaches each order lines in line order, with Details and quantity', async () => {
      const { orders } = await listDeviceOrders(t.db, eq1);
      const [newest] = orders;
      expect(newest?.lines.map((l) => l.vantageId)).toEqual([5000, 5001]);
      expect(newest?.lines[0]).toMatchObject({
        details: 'Xerox B310 Black Toner',
        itemPartNumber: 'MISC',
        quantity: 2,
        colour: 'black',
        returnedDate: null,
      });
    });

    it('derives open/completed/on-hold and carries createdByMps', async () => {
      const byId = new Map((await listDeviceOrders(t.db, eq1)).orders.map((o) => [o.vantageId, o]));
      expect(byId.get(500)).toMatchObject({ open: true, isOnHold: false, createdByMps: true });
      expect(byId.get(501)).toMatchObject({ open: false, createdByMps: false });
      expect(byId.get(502)).toMatchObject({ open: false, isOnHold: true });
      expect(byId.get(501)?.completedDate?.toISOString()).toBe(daysAgo(18).toISOString());
    });

    it('reports the most recent non-returned line per colour, including waste', async () => {
      const { lastByColour } = await listDeviceOrders(t.db, eq1);
      expect(Object.keys(lastByColour).sort()).toEqual(['black', 'cyan', 'magenta', 'waste', 'yellow']);

      expect(lastByColour.black).toMatchObject({
        partNumber: 'MISC',
        description: 'Xerox B310 Black Toner',
        quantity: 2,
        reference: 'SO2609-0214',
        orderOpen: true,
      });
      expect(lastByColour.waste).toMatchObject({ reference: 'SO2609-0214', quantity: 1, orderOpen: true });
      expect(lastByColour.magenta).toMatchObject({ reference: 'SO2608-0100', orderOpen: false });
      // Cyan and yellow only appear on the excluded orders.
      expect(lastByColour.cyan).toBeNull();
      expect(lastByColour.yellow).toBeNull();
    });

    it('limits the orders it returns but still looks further back for the per-colour summary', async () => {
      const { orders, lastByColour } = await listDeviceOrders(t.db, eq1, { limit: 1 });
      expect(orders.map((o) => o.vantageId)).toEqual([500]);
      // Magenta last went out on order 501, which the limit cut from the table.
      expect(lastByColour.magenta?.reference).toBe('SO2608-0100');
    });

    it('returns nothing for a device with no orders', async () => {
      const result = await listDeviceOrders(t.db, 999_999);
      expect(result.orders).toEqual([]);
      expect(result.lastByColour.black).toBeNull();
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
