import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppState, setAppState } from './app-state';
import {
  counterSnapshots,
  deviceAlarms,
  deviceAlerts,
  deviceLinks,
  drmsEquipment,
  linkIssues,
  vantageEquipment,
} from './schema';
import { createTestDb, type TestDb } from './testing';

describe('schema', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'd1', raw: {} },
      { drmsId: 'd2', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 10, raw: {} },
      { vantageId: 11, raw: {} },
    ]);
  });
  afterEach(() => t.close());

  it('allows only one active link per DRMS device, but keeps history', async () => {
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial', unlinkedAt: new Date() });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial' });
    await expect(
      t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 11, method: 'serial' }),
    ).rejects.toThrow();
  });

  it('allows only one active link per Vantage equipment', async () => {
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'erp_id' });
    await expect(
      t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd2', vantageEquipmentId: 10, method: 'serial' }),
    ).rejects.toThrow();
  });

  it('dedupes snapshots per device + CounterId', async () => {
    const row = { drmsEquipmentId: 'd1', counterId: 'c-1', raw: {} };
    await t.db.insert(counterSnapshots).values(row);
    const again = await t.db.insert(counterSnapshots).values(row).onConflictDoNothing().returning();
    expect(again).toHaveLength(0);
  });

  it('enforces a unique issue key', async () => {
    const row = { issueKey: 'no_match_drms|d1|', type: 'no_match_drms', drmsEquipmentId: 'd1' };
    await t.db.insert(linkIssues).values(row);
    await expect(t.db.insert(linkIssues).values(row)).rejects.toThrow();
  });

  it('allows one open alert per device and type, but history after clearing', async () => {
    await t.db.insert(deviceAlerts).values({ drmsEquipmentId: 'd1', type: 'offline', firstDetectedAt: new Date(), clearedAt: new Date() });
    await t.db.insert(deviceAlerts).values({ drmsEquipmentId: 'd1', type: 'offline', firstDetectedAt: new Date() });
    await expect(
      t.db.insert(deviceAlerts).values({ drmsEquipmentId: 'd1', type: 'offline', firstDetectedAt: new Date() }),
    ).rejects.toThrow();
  });

  it('dedupes alarms by alarmId (natural DRMS key)', async () => {
    const row = {
      alarmId: 'guid-1',
      drmsEquipmentId: 'd1',
      receivedTime: new Date('2026-09-17T02:00:00Z'),
      fcCode: 'TN-00',
      category: 'toner',
      raw: {},
    };
    await t.db.insert(deviceAlarms).values(row);
    const again = await t.db.insert(deviceAlarms).values(row).onConflictDoNothing().returning();
    expect(again).toHaveLength(0);
    expect(await t.db.select().from(deviceAlarms)).toHaveLength(1);
  });

  it('stores and overwrites app state', async () => {
    expect(await getAppState(t.db, 'x')).toBeNull();
    await setAppState(t.db, 'x', { a: 1 });
    await setAppState(t.db, 'x', { a: 2 });
    expect(await getAppState<{ a: number }>(t.db, 'x')).toEqual({ a: 2 });
  });
});
