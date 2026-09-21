import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, deviceLinks, drmsEquipment, replenishmentSettings, users, vantageCustomers, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import {
  SettingsError,
  effectiveSettingsSubquery,
  getDefaultSettings,
  getDeviceSettings,
  listCustomerSettings,
  updateCustomerSettings,
  updateDefaultSettings,
  updateDeviceSettings,
} from './settings';

describe('replenishment settings', () => {
  let t: TestDb;
  let userId: number;
  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(vantageCustomers).values({ vantageId: 7, name: 'Acme', raw: {} });
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'linked', raw: {} },
      { drmsId: 'other', raw: {} },
      { drmsId: 'unlinked', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 100, vantageCustomerId: 7, customerName: 'Acme', raw: {} },
      { vantageId: 101, vantageCustomerId: 7, customerName: 'Acme', raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'linked', vantageEquipmentId: 100, method: 'serial' },
      { drmsEquipmentId: 'other', vantageEquipmentId: 101, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  async function effective() {
    const eff = effectiveSettingsSubquery(t.db);
    const rows = await t.db.select().from(eff);
    return Object.fromEntries(rows.map((r) => [r.drmsId, r]));
  }

  it('gives every device the defaults, sourced from default', async () => {
    const e = await effective();
    expect(e.unlinked).toMatchObject({
      thresholdBlack: 15, thresholdBlackSource: 'default', thresholdCyan: 10, autoReplenish: true,
      alertsEnabled: true, vantageCustomerId: null,
    });
    expect(e.linked).toMatchObject({ vantageEquipmentId: 100, vantageCustomerId: 7 });
  });

  it('cascades device over customer over default, per field', async () => {
    await updateCustomerSettings(t.db, { vantageCustomerId: 7, patch: { thresholdCyan: 25, autoReplenish: false }, userId });
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdCyan: 30 }, userId });
    const e = await effective();
    expect(e.linked).toMatchObject({ thresholdCyan: 30, thresholdCyanSource: 'device', autoReplenish: false, autoReplenishSource: 'customer', thresholdBlackSource: 'default' });
    expect(e.other).toMatchObject({ thresholdCyan: 25, thresholdCyanSource: 'customer' });
    expect(e.unlinked).toMatchObject({ thresholdCyan: 10, autoReplenish: true });
  });

  it('null resets a device field to inherited and deletes an all-null device row', async () => {
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: 40, alertsEnabled: false }, userId });
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: null }, userId });
    let e = await effective();
    expect(e.linked).toMatchObject({ thresholdBlack: 15, thresholdBlackSource: 'default', alertsEnabled: false });
    await updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { alertsEnabled: null }, userId });
    const rows = await t.db.select().from(replenishmentSettings).where(eq(replenishmentSettings.scope, 'device'));
    expect(rows).toEqual([]);
    e = await effective();
    expect(e.linked?.alertsEnabledSource).toBe('default');
  });

  it('writes a bulk edit in one transaction with one audit row', async () => {
    const res = await updateDeviceSettings(t.db, { drmsIds: ['linked', 'other', 'unlinked'], patch: { thresholdYellow: 12 }, userId });
    expect(res.updated).toBe(3);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'settings.update', entity: 'device', userId, details: { patch: { thresholdYellow: 12 } } });
    expect(audits[0]!.entityIds).toEqual(['linked', 'other', 'unlinked']);
  });

  it('leaves nothing behind when one device in a bulk edit is invalid', async () => {
    await expect(
      updateDeviceSettings(t.db, { drmsIds: ['linked', 'missing-device'], patch: { thresholdBlack: 20 }, userId }),
    ).rejects.toThrow();
    expect(await t.db.select().from(replenishmentSettings).where(eq(replenishmentSettings.scope, 'device'))).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('validates thresholds and patches', async () => {
    await expect(updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: 101 }, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: { thresholdBlack: 1.5 }, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDeviceSettings(t.db, { drmsIds: ['linked'], patch: {}, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDeviceSettings(t.db, { drmsIds: [], patch: { thresholdBlack: 5 }, userId })).rejects.toBeInstanceOf(SettingsError);
    await expect(updateDefaultSettings(t.db, { patch: { thresholdBlack: null }, userId })).rejects.toBeInstanceOf(SettingsError);
  });

  it('updates the default row', async () => {
    await updateDefaultSettings(t.db, { patch: { thresholdBlack: 12 }, userId });
    expect((await effective()).unlinked?.thresholdBlack).toBe(12);
  });

  it('reads one device with row metadata', async () => {
    await updateCustomerSettings(t.db, { vantageCustomerId: 7, patch: { thresholdCyan: 25 }, userId, now: new Date('2026-09-21T10:00:00Z') });
    const s = await getDeviceSettings(t.db, 'linked');
    expect(s?.thresholds.cyan).toEqual({ value: 25, source: 'customer' });
    expect(s?.customerRow).toEqual({ updatedAt: new Date('2026-09-21T10:00:00Z'), updatedBy: 'op' });
    expect(s?.deviceRow).toBeNull();
    expect(await getDeviceSettings(t.db, 'nope')).toBeNull();
  });

  it('lists customer overrides with their device counts', async () => {
    await updateCustomerSettings(t.db, { vantageCustomerId: 7, patch: { autoReplenish: false }, userId });
    const rows = await listCustomerSettings(t.db);
    expect(rows).toEqual([expect.objectContaining({ vantageCustomerId: 7, customerName: 'Acme', deviceCount: 2, autoReplenish: false, updatedBy: 'op' })]);
  });

  it('reads the default row with its latest change from the audit log', async () => {
    let d = await getDefaultSettings(t.db);
    expect(d).toEqual({
      thresholdBlack: 15, thresholdCyan: 10, thresholdMagenta: 10, thresholdYellow: 10,
      autoReplenish: true, alertsEnabled: true, lastChange: null,
    });
    await updateDefaultSettings(t.db, { patch: { thresholdBlack: 12 }, userId, now: new Date('2026-09-20T09:00:00Z') });
    // A customer write is newer, but it is not a change to the defaults.
    await updateCustomerSettings(t.db, { vantageCustomerId: 7, patch: { thresholdCyan: 25 }, userId, now: new Date('2026-09-21T09:00:00Z') });
    d = await getDefaultSettings(t.db);
    expect(d.thresholdBlack).toBe(12);
    expect(d.lastChange).toEqual({ at: new Date('2026-09-20T09:00:00Z'), by: 'op' });
  });
});
