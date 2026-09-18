import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceAlerts, drmsEquipment, users } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { acknowledgeAlert } from './alert-actions';

const NOW = new Date('2026-09-18T12:00:00Z');
const LATER = new Date('2026-09-18T15:30:00Z');
/** When the device last reported counters, i.e. what the alert is about. */
const LAST_REPORT = new Date('2026-09-14T03:00:00Z');

describe('acknowledgeAlert', () => {
  let t: TestDb;
  let alice: number;
  let bob: number;
  let alertId: number;
  let otherAlertId: number;

  beforeEach(async () => {
    t = await createTestDb();

    const inserted = await t.db
      .insert(users)
      .values([
        { username: 'alice', passwordHash: 'x', role: 'operator' },
        { username: 'bob', passwordHash: 'x', role: 'operator' },
      ])
      .returning({ id: users.id });
    alice = inserted[0]!.id;
    bob = inserted[1]!.id;

    await t.db.insert(drmsEquipment).values([
      { drmsId: 'D1', serial: 'SN0000001', serialNorm: 'sn0000001', status: 'Registered', raw: {} },
      { drmsId: 'D2', serial: 'SN0000002', serialNorm: 'sn0000002', status: 'Registered', raw: {} },
    ]);

    const alerts = await t.db
      .insert(deviceAlerts)
      .values([
        {
          drmsEquipmentId: 'D1',
          type: 'offline',
          firstDetectedAt: NOW,
          lastSeenReportAt: LAST_REPORT,
          details: { thresholdHours: 24 },
        },
        {
          drmsEquipmentId: 'D2',
          type: 'offline',
          firstDetectedAt: NOW,
          lastSeenReportAt: LAST_REPORT,
          details: { thresholdHours: 24 },
        },
      ])
      .returning({ id: deviceAlerts.id });
    alertId = alerts[0]!.id;
    otherAlertId = alerts[1]!.id;
  });

  afterEach(() => t.close());

  const row = (id: number) =>
    t.db
      .select()
      .from(deviceAlerts)
      .where(eq(deviceAlerts.id, id))
      .then((rows) => rows[0]!);

  it('stamps who acknowledged the alert and when', async () => {
    await acknowledgeAlert(t.db, { alertId, userId: alice, now: NOW });

    const alert = await row(alertId);
    expect(alert.acknowledgedBy).toBe(alice);
    expect(alert.acknowledgedAt?.getTime()).toBe(NOW.getTime());
  });

  it('does not clear the alert — only the device reporting again does that', async () => {
    await acknowledgeAlert(t.db, { alertId, userId: alice, now: NOW });

    const alert = await row(alertId);
    expect(alert.clearedAt).toBeNull();
    // Nothing else about the alert moves either: it is still the same open offline alert.
    expect(alert.type).toBe('offline');
    expect(alert.firstDetectedAt.getTime()).toBe(NOW.getTime());
    expect(alert.lastSeenReportAt?.getTime()).toBe(LAST_REPORT.getTime());
  });

  it('is harmless to acknowledge twice — the first acknowledgement stands', async () => {
    await acknowledgeAlert(t.db, { alertId, userId: alice, now: NOW });
    await acknowledgeAlert(t.db, { alertId, userId: bob, now: LATER });

    const alert = await row(alertId);
    expect(alert.acknowledgedBy).toBe(alice);
    expect(alert.acknowledgedAt?.getTime()).toBe(NOW.getTime());
    expect(alert.clearedAt).toBeNull();
  });

  it('touches only the alert it is given', async () => {
    await acknowledgeAlert(t.db, { alertId, userId: alice, now: NOW });

    const other = await row(otherAlertId);
    expect(other.acknowledgedBy).toBeNull();
    expect(other.acknowledgedAt).toBeNull();
  });

  it('is a no-op for an alert id that does not exist', async () => {
    await expect(acknowledgeAlert(t.db, { alertId: 99_999, userId: alice, now: NOW })).resolves.toBeUndefined();

    const alert = await row(alertId);
    expect(alert.acknowledgedAt).toBeNull();
  });

  it('defaults `now` to the current time', async () => {
    const before = Date.now();
    await acknowledgeAlert(t.db, { alertId, userId: alice });
    const after = Date.now();

    const alert = await row(alertId);
    const at = alert.acknowledgedAt!.getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });
});
