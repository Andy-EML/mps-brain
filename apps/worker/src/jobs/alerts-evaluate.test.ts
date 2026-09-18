import { deviceAlerts, drmsEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms } from '../test-helpers';
import { evaluateOfflineAlerts } from './alerts-evaluate';

describe('evaluateOfflineAlerts', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const NOW = new Date('2026-09-18T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

  it('does not alert a device that reported 2h ago', async () => {
    await seedDrms(t.db, [{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(2) }]);
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 0 });
    expect(await t.db.select().from(deviceAlerts)).toHaveLength(0);
  });

  it('opens an alert for a device that reported 30h ago, with lastSeenReportAt set', async () => {
    const lastSeen = hoursAgo(30);
    await seedDrms(t.db, [{ drmsId: 'D1', lastCounterReceivedTime: lastSeen }]);
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 1, cleared: 0, open: 1 });
    const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1'));
    expect(alert).toMatchObject({ type: 'offline', clearedAt: null, details: { thresholdHours: 24 } });
    expect(alert?.firstDetectedAt.toISOString()).toBe(NOW.toISOString());
    expect(alert?.lastSeenReportAt?.toISOString()).toBe(lastSeen.toISOString());
  });

  it('does not open a second alert on a rerun', async () => {
    await seedDrms(t.db, [{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 1 });
    expect(await t.db.select().from(deviceAlerts)).toHaveLength(1);
  });

  it('clears the alert once the device reports again', async () => {
    await seedDrms(t.db, [{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: NOW }).where(eq(drmsEquipment.drmsId, 'D1'));
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    expect(result).toEqual({ opened: 0, cleared: 1, open: 0 });
    const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1'));
    expect(alert?.clearedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('opens a new alert (preserving history) after a later lapse following a clear', async () => {
    await seedDrms(t.db, [{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: NOW }).where(eq(drmsEquipment.drmsId, 'D1'));
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    const later = new Date(NOW.getTime() + 30 * 3_600_000);
    // Device goes stale again relative to `later`.
    const result = await evaluateOfflineAlerts(t.db, { now: later, thresholdHours: 24 });

    expect(result).toEqual({ opened: 1, cleared: 0, open: 1 });
    const rows = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1')).orderBy(asc(deviceAlerts.id));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.clearedAt).not.toBeNull();
    expect(rows[1]?.clearedAt).toBeNull();
  });

  it('never alerts a device that has not reported', async () => {
    await seedDrms(t.db, [{ drmsId: 'D1', lastCounterReceivedTime: null }]);
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 0 });
    expect(await t.db.select().from(deviceAlerts)).toHaveLength(0);
  });

  it('keeps an open alert on a device that has gone missing', async () => {
    await seedDrms(t.db, [{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    // Device goes missing, but reports a fresh counter as part of its last snapshot before vanishing.
    await t.db
      .update(drmsEquipment)
      .set({ missingSince: NOW, lastCounterReceivedTime: NOW })
      .where(eq(drmsEquipment.drmsId, 'D1'));

    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 1 });
    const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1'));
    expect(alert?.clearedAt).toBeNull();
  });
});
