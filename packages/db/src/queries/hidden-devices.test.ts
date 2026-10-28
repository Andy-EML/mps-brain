import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, deviceAlerts, deviceLinks, drmsEquipment, hiddenDevices, replenishmentProposals, siteStockShelves, cartridgeFamilies, vantageEquipment } from '../schema';
import { createTestDb, seedDemoFixture, type DemoFixture, type TestDb } from '../testing';
import { resolveDeviceSelection } from './device-selection';
import { listDeviceFilterOptions, listDevices } from './devices';
import { getCollectionStatus, getCustomerCount, getFleetSummary, getTonerHealth } from './fleet';
import {
  countHiddenDevices,
  getHiddenDevice,
  hideDevices,
  HIDDEN_NOTE,
  HideError,
  listHiddenDevices,
  supersedeHiddenProposals,
  unhideDevices,
} from './hidden-devices';
import { getIssueCounts, listIssues } from './issues';
import { getReconnectCounts, listReconnect } from './reconnect';

// Same frozen clock as queries.test.ts: the fixture and the offline cut-off both read Date.now().
const FIXED_NOW = new Date('2026-09-18T12:00:00Z');

describe('hidden devices', () => {
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

  const hide = (drmsIds: string[], reason?: string) => hideDevices(t.db, { drmsIds, userId: f.user.id, reason, now: FIXED_NOW });

  describe('hideDevices / unhideDevices', () => {
    it('hides with who, when and why, and writes one audit row', async () => {
      const r = await hide([f.drms.offline], '  Out of contract  ');
      expect(r).toMatchObject({ hidden: 1, alertsCleared: 1 });
      expect(await getHiddenDevice(t.db, f.drms.offline)).toEqual({
        hiddenAt: FIXED_NOW,
        hiddenBy: f.user.username,
        reason: 'Out of contract',
      });
      expect(await getHiddenDevice(t.db, f.drms.online)).toBeNull();
      const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, 'device.hide'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ userId: f.user.id, entity: 'device', entityIds: [f.drms.offline] });
      expect(audit[0]?.details).toMatchObject({ reason: 'Out of contract' });
    });

    it('keeps the first hide when a device is hidden again, and audits nothing new', async () => {
      await hide([f.drms.offline], 'first');
      const again = await hideDevices(t.db, { drmsIds: [f.drms.offline], userId: f.user.id, reason: 'second' });
      expect(again).toEqual({ hidden: 0, superseded: 0, alertsCleared: 0 });
      expect((await getHiddenDevice(t.db, f.drms.offline))?.reason).toBe('first');
      expect(await t.db.select().from(auditLog).where(eq(auditLog.action, 'device.hide'))).toHaveLength(1);
    });

    it('stores no reason when none is given, and ignores unknown ids', async () => {
      const r = await hide([f.drms.online, 'NOPE', f.drms.online]);
      expect(r.hidden).toBe(1);
      expect((await getHiddenDevice(t.db, f.drms.online))?.reason).toBeNull();
    });

    it('refuses an empty selection, only unknown ids and an over-long reason', async () => {
      await expect(hide([])).rejects.toBeInstanceOf(HideError);
      await expect(hide(['NOPE'])).rejects.toMatchObject({ code: 'no_devices' });
      await expect(hide([f.drms.online], 'x'.repeat(501))).rejects.toMatchObject({ code: 'reason_too_long' });
      expect(await countHiddenDevices(t.db)).toBe(0);
    });

    it('unhides, auditing who had hidden it and why; ids that are not hidden are ignored', async () => {
      await hide([f.drms.offline, f.drms.online], 'gone');
      const r = await unhideDevices(t.db, { drmsIds: [f.drms.offline, f.drms.unlinked], userId: f.user.id, now: FIXED_NOW });
      expect(r).toEqual({ unhidden: 1 });
      expect(await getHiddenDevice(t.db, f.drms.offline)).toBeNull();
      expect(await countHiddenDevices(t.db)).toBe(1);
      const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'device.unhide'));
      expect(audit?.entityIds).toEqual([f.drms.offline]);
      expect(audit?.details).toMatchObject({ was: [{ drmsId: f.drms.offline, hiddenBy: f.user.id, reason: 'gone' }] });
    });
  });

  describe('proposals and alerts', () => {
    async function proposal(values: Partial<typeof replenishmentProposals.$inferInsert>) {
      const [row] = await t.db
        .insert(replenishmentProposals)
        .values({ drmsEquipmentId: f.drms.offline, colour: 'black', trigger: 'threshold', status: 'pending', ...values })
        .returning({ id: replenishmentProposals.id });
      return row!.id;
    }
    const statusOf = async (id: number) =>
      (await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, id)))[0];

    it("supersedes the device's own pending proposals, leaving approved ones, top-ups and other devices alone", async () => {
      const [family] = await t.db.insert(cartridgeFamilies).values({ name: 'F', isColour: true }).returning();
      const [shelf] = await t.db
        .insert(siteStockShelves)
        .values({ vantageCustomerId: 2, familyId: family!.id, countingFrom: FIXED_NOW })
        .returning();
      const pending = await proposal({ colour: 'black' });
      const approved = await proposal({ colour: 'cyan', status: 'approved' });
      const topUp = await proposal({ colour: 'magenta', trigger: 'site_stock', shelfId: shelf!.id });
      const otherDevice = await proposal({ drmsEquipmentId: f.drms.online });

      const r = await hide([f.drms.offline]);
      expect(r.superseded).toBe(1);
      expect(await statusOf(pending)).toMatchObject({ status: 'superseded', note: HIDDEN_NOTE, decidedAt: FIXED_NOW });
      expect((await statusOf(approved))?.status).toBe('approved');
      expect((await statusOf(topUp))?.status).toBe('pending');
      expect((await statusOf(otherDevice))?.status).toBe('pending');
    });

    it('supersedeHiddenProposals catches a pending proposal raised after the hide', async () => {
      await hide([f.drms.offline]);
      const late = await proposal({ colour: 'yellow' });
      const visible = await proposal({ drmsEquipmentId: f.drms.online });
      expect(await supersedeHiddenProposals(t.db, FIXED_NOW)).toBe(1);
      expect((await statusOf(late))?.status).toBe('superseded');
      expect((await statusOf(visible))?.status).toBe('pending');
    });

    it('clears the open alerts with a reason, leaving cleared ones as they were', async () => {
      await hide([f.drms.offline, f.drms.online]);
      const [open] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.id, f.alerts.open));
      expect(open?.clearedAt).toEqual(FIXED_NOW);
      expect(open?.details).toMatchObject({ clearedReason: 'device hidden' });
      const [cleared] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.id, f.alerts.cleared));
      expect(cleared?.details).toEqual({});
    });
  });

  describe('lists and counts', () => {
    it('leaves a hidden device out of every devices tab and the bulk selection', async () => {
      await hide([f.drms.offline]);
      for (const filter of ['all', 'offline', 'needs-toner', 'manual', 'unlinked'] as const) {
        const { rows, total } = await listDevices(t.db, { filter });
        expect(rows.map((r) => r.drmsId)).not.toContain(f.drms.offline);
        expect(total).toBe(rows.length);
      }
      expect((await listDevices(t.db, { search: 'Beta' })).total).toBe(0);
      expect((await resolveDeviceSelection(t.db, {})).drmsIds).toEqual(
        (await listDevices(t.db, { limit: 100 })).rows.map((r) => r.drmsId),
      );
      expect((await listDeviceFilterOptions(t.db)).customers).not.toContain('Beta Co (Vantage)');
    });

    it('lists hidden devices on their own tab, searchable, with the hide details', async () => {
      await hide([f.drms.offline], 'Contract ended');
      const { rows, total } = await listHiddenDevices(t.db);
      expect(total).toBe(1);
      expect(rows[0]).toMatchObject({
        drmsId: f.drms.offline,
        serial: 'SN0000002',
        customerName: 'Beta Co (Vantage)',
        hiddenBy: f.user.username,
        reason: 'Contract ended',
      });
      expect((await listHiddenDevices(t.db, { search: 'beta' })).total).toBe(1);
      expect((await listHiddenDevices(t.db, { search: 'acme' })).total).toBe(0);
    });

    it('drops a hidden device from the Fleet overview headline counts', async () => {
      const before = await getFleetSummary(t.db);
      await hide([f.drms.offline]);
      const after = await getFleetSummary(t.db);
      expect(after.devices).toBe(before.devices - 1);
      expect(after.monitored).toBe(before.monitored - 1);
      expect(after.linked).toBe(before.linked - 1);
      expect(after.offline).toBe(before.offline - 1);
      // D2's `conflicting_customer` issue no longer counts; D3's still does.
      expect(after.openIssues).toBe(before.openIssues - 1);
      expect(await getCustomerCount(t.db)).toBe(2);
    });

    it('drops a hidden device from toner health, needs toner and the collection status', async () => {
      const before = await getTonerHealth(t.db);
      expect(before.devices).toBe(1);
      const summaryBefore = await getFleetSummary(t.db);
      expect(summaryBefore.needsToner).toBe(1);
      const collectionBefore = await getCollectionStatus(t.db);
      await hide([f.drms.online]);
      expect(await getTonerHealth(t.db)).toMatchObject({ devices: 0, cartridges: 0, critical: 0 });
      expect((await getFleetSummary(t.db)).needsToner).toBe(0);
      expect((await getCollectionStatus(t.db)).devicesExpectingReadings).toBe(collectionBefore.devicesExpectingReadings - 1);
    });

    it('leaves link issues about a hidden device out of the queue and its counts', async () => {
      await hide([f.drms.offline]);
      const { rows, total, countsByType } = await listIssues(t.db, { status: 'open' });
      expect(rows.map((r) => r.drmsId)).toEqual([f.drms.unlinked]);
      expect(total).toBe(1);
      expect(countsByType).toEqual({ unlinked_drms: 1 });
      expect(await getIssueCounts(t.db, { status: 'open' })).toEqual({ unlinked_drms: 1 });
    });

    it('leaves a hidden device out of Needs reconnecting', async () => {
      // A linked device last heard from 20 days ago: silent.
      await t.db.insert(drmsEquipment).values({
        drmsId: 'QUIET',
        status: 'Registered',
        lastCounterReceivedTime: new Date(FIXED_NOW.getTime() - 20 * 86_400_000),
        raw: {},
      });
      await t.db.insert(vantageEquipment).values({ vantageId: 2001, raw: {} });
      await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'QUIET', vantageEquipmentId: 2001, method: 'serial' });
      expect((await getReconnectCounts(t.db, { now: FIXED_NOW })).silent).toBe(1);

      await hide(['QUIET']);
      expect(await getReconnectCounts(t.db, { now: FIXED_NOW })).toMatchObject({ silent: 0, newlySilent: 0 });
      expect((await listReconnect(t.db, { now: FIXED_NOW })).total).toBe(0);

      await unhideDevices(t.db, { drmsIds: ['QUIET'], userId: f.user.id });
      expect((await getReconnectCounts(t.db, { now: FIXED_NOW })).silent).toBe(1);
    });

    it('brings a device back everywhere on unhide', async () => {
      const before = await listDevices(t.db);
      await hide([f.drms.offline]);
      await unhideDevices(t.db, { drmsIds: [f.drms.offline], userId: f.user.id });
      expect(await listDevices(t.db)).toEqual(before);
      expect(await t.db.select().from(hiddenDevices).where(and(eq(hiddenDevices.drmsEquipmentId, f.drms.offline)))).toEqual([]);
    });
  });
});
