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

  /**
   * A device that is always reporting, so the fleet is never *entirely* stale and the per-device
   * rule under test is the one being exercised rather than the collection-outage guard. Real
   * fleets have hundreds of devices; without this, a one-device fixture is 100% stale and reads
   * as an outage.
   */
  const ANCHOR = 'ANCHOR';
  async function seedWithAnchor(
    rows: Array<Partial<typeof drmsEquipment.$inferInsert> & { drmsId: string }>,
    anchorReportedAt: Date = hoursAgo(1),
  ) {
    await seedDrms(t.db, [{ drmsId: ANCHOR, lastCounterReceivedTime: anchorReportedAt }, ...rows]);
  }

  /** Keeps the anchor fresh relative to a later `now`. */
  async function anchorReportsAt(at: Date) {
    await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: at }).where(eq(drmsEquipment.drmsId, ANCHOR));
  }

  it('does not alert a device that reported 2h ago', async () => {
    await seedWithAnchor([{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(2) }]);
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 0, skippedDueToOutage: false });
    expect(await t.db.select().from(deviceAlerts)).toHaveLength(0);
  });

  it('opens an alert for a device that reported 30h ago, with lastSeenReportAt set', async () => {
    const lastSeen = hoursAgo(30);
    await seedWithAnchor([{ drmsId: 'D1', lastCounterReceivedTime: lastSeen }]);
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 1, cleared: 0, open: 1, skippedDueToOutage: false });
    const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1'));
    expect(alert).toMatchObject({ type: 'offline', clearedAt: null, details: { thresholdHours: 24 } });
    expect(alert?.firstDetectedAt.toISOString()).toBe(NOW.toISOString());
    expect(alert?.lastSeenReportAt?.toISOString()).toBe(lastSeen.toISOString());
  });

  it('does not open a second alert on a rerun', async () => {
    await seedWithAnchor([{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 1, skippedDueToOutage: false });
    expect(await t.db.select().from(deviceAlerts)).toHaveLength(1);
  });

  it('clears the alert once the device reports again', async () => {
    await seedWithAnchor([{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: NOW }).where(eq(drmsEquipment.drmsId, 'D1'));
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    expect(result).toEqual({ opened: 0, cleared: 1, open: 0, skippedDueToOutage: false });
    const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1'));
    expect(alert?.clearedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('opens a new alert (preserving history) after a later lapse following a clear', async () => {
    await seedWithAnchor([{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: NOW }).where(eq(drmsEquipment.drmsId, 'D1'));
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    const later = new Date(NOW.getTime() + 30 * 3_600_000);
    // Device goes stale again relative to `later`; the anchor keeps collecting, so this is a
    // single quiet device rather than a collection outage.
    await anchorReportsAt(later);
    const result = await evaluateOfflineAlerts(t.db, { now: later, thresholdHours: 24 });

    expect(result).toEqual({ opened: 1, cleared: 0, open: 1, skippedDueToOutage: false });
    const rows = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1')).orderBy(asc(deviceAlerts.id));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.clearedAt).not.toBeNull();
    expect(rows[1]?.clearedAt).toBeNull();
  });

  it('never alerts a device that has not reported', async () => {
    await seedWithAnchor([{ drmsId: 'D1', lastCounterReceivedTime: null }]);
    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 0, skippedDueToOutage: false });
    expect(await t.db.select().from(deviceAlerts)).toHaveLength(0);
  });

  it('keeps an open alert on a device that has gone missing', async () => {
    await seedWithAnchor([{ drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) }]);
    await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

    // Device goes missing, but reports a fresh counter as part of its last snapshot before vanishing.
    await t.db
      .update(drmsEquipment)
      .set({ missingSince: NOW, lastCounterReceivedTime: NOW })
      .where(eq(drmsEquipment.drmsId, 'D1'));

    const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
    expect(result).toEqual({ opened: 0, cleared: 0, open: 1, skippedDueToOutage: false });
    const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D1'));
    expect(alert?.clearedAt).toBeNull();
  });

  describe('fleet-wide collection outage', () => {
    it('opens nothing when every reporting device is stale, and says why', async () => {
      await seedDrms(t.db, [
        { drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) },
        { drmsId: 'D2', lastCounterReceivedTime: hoursAgo(31) },
        { drmsId: 'D3', lastCounterReceivedTime: hoursAgo(48) },
        // Never reported: not evidence either way, and never alerted on.
        { drmsId: 'D4', lastCounterReceivedTime: null },
      ]);

      const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

      expect(result).toEqual({ opened: 0, cleared: 0, open: 0, skippedDueToOutage: true });
      expect(await t.db.select().from(deviceAlerts)).toHaveLength(0);
    });

    it('still opens alerts on a mixed fleet, where collection is demonstrably running', async () => {
      // 2 stale of 10 = 0.2, well under the ratio: the batch clearly reached the other eight, so
      // these two really are individually quiet.
      await seedDrms(t.db, [
        ...Array.from({ length: 8 }, (_, i) => ({ drmsId: `F${i}`, lastCounterReceivedTime: hoursAgo(1) })),
        { drmsId: 'D2', lastCounterReceivedTime: hoursAgo(30) },
        { drmsId: 'D3', lastCounterReceivedTime: hoursAgo(31) },
      ]);

      const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

      expect(result).toEqual({ opened: 2, cleared: 0, open: 2, skippedDueToOutage: false });
    });

    it('opens nothing while collection is only part-way through the fleet', async () => {
      // The live shape on 2026-09-18: collection restarted and delivered 5 of 35 devices. 30/35 =
      // 0.857, so the other 30 are waiting their turn, not offline — the all-or-nothing rule read
      // this as "collection is fine" and opened 30 alerts.
      await seedDrms(t.db, [
        ...Array.from({ length: 5 }, (_, i) => ({ drmsId: `FRESH${i}`, lastCounterReceivedTime: hoursAgo(1) })),
        ...Array.from({ length: 30 }, (_, i) => ({ drmsId: `STALE${i}`, lastCounterReceivedTime: hoursAgo(30) })),
      ]);

      const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

      expect(result).toEqual({ opened: 0, cleared: 0, open: 0, skippedDueToOutage: true });
      expect(await t.db.select().from(deviceAlerts)).toHaveLength(0);
    });

    it('opens the stragglers once collection has caught up with most of the fleet', async () => {
      // Same fleet, collection now through 33 of 35: 2/35 = 0.057, so the two left really are quiet.
      await seedDrms(t.db, [
        ...Array.from({ length: 33 }, (_, i) => ({ drmsId: `FRESH${i}`, lastCounterReceivedTime: hoursAgo(1) })),
        ...Array.from({ length: 2 }, (_, i) => ({ drmsId: `STALE${i}`, lastCounterReceivedTime: hoursAgo(30) })),
      ]);

      const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

      expect(result).toEqual({ opened: 2, cleared: 0, open: 2, skippedDueToOutage: false });
    });

    it('leaves existing open alerts alone during an outage', async () => {
      await seedDrms(t.db, [
        { drmsId: 'D1', lastCounterReceivedTime: hoursAgo(1) },
        { drmsId: 'D2', lastCounterReceivedTime: hoursAgo(30) },
      ]);
      // Normal run first: D2 is genuinely quiet while D1 is reporting.
      expect(await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 })).toMatchObject({ opened: 1 });

      // Collection then stops: D1 goes stale too, so the whole reporting fleet is stale.
      const later = new Date(NOW.getTime() + 48 * 3_600_000);
      const result = await evaluateOfflineAlerts(t.db, { now: later, thresholdHours: 24 });

      expect(result).toEqual({ opened: 0, cleared: 0, open: 1, skippedDueToOutage: true });
      const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D2'));
      expect(alert?.clearedAt).toBeNull();
    });

    it('still clears alerts for devices that report again during an outage', async () => {
      await seedDrms(t.db, [
        { drmsId: 'D1', lastCounterReceivedTime: hoursAgo(1) },
        { drmsId: 'D2', lastCounterReceivedTime: hoursAgo(30) },
      ]);
      await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

      // D2 reports; D1 has now gone quiet, so all-but-D2 is stale. D2 alone is fresh, which by
      // definition is not an outage — but this is the shape of "collection came back for one
      // device": the clear must still happen.
      const later = new Date(NOW.getTime() + 48 * 3_600_000);
      await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: later }).where(eq(drmsEquipment.drmsId, 'D2'));
      const result = await evaluateOfflineAlerts(t.db, { now: later, thresholdHours: 24 });

      expect(result.cleared).toBe(1);
      const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D2'));
      expect(alert?.clearedAt?.toISOString()).toBe(later.toISOString());
    });

    it('opens the genuinely stale devices on the first run after the outage ends', async () => {
      await seedDrms(t.db, [
        { drmsId: 'D1', lastCounterReceivedTime: hoursAgo(30) },
        { drmsId: 'D2', lastCounterReceivedTime: hoursAgo(31) },
      ]);
      // Outage: nothing opens.
      expect(await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 })).toMatchObject({
        opened: 0,
        skippedDueToOutage: true,
      });

      // Collection resumes and D1 reports; D2 stays quiet and is now a real per-device problem.
      await t.db.update(drmsEquipment).set({ lastCounterReceivedTime: NOW }).where(eq(drmsEquipment.drmsId, 'D1'));
      const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });

      expect(result).toEqual({ opened: 1, cleared: 0, open: 1, skippedDueToOutage: false });
      const [alert] = await t.db.select().from(deviceAlerts).where(eq(deviceAlerts.drmsEquipmentId, 'D2'));
      expect(alert?.clearedAt).toBeNull();
    });

    it('is not an outage when no device has ever reported', async () => {
      await seedDrms(t.db, [
        { drmsId: 'D1', lastCounterReceivedTime: null },
        { drmsId: 'D2', lastCounterReceivedTime: null },
      ]);
      const result = await evaluateOfflineAlerts(t.db, { now: NOW, thresholdHours: 24 });
      expect(result).toEqual({ opened: 0, cleared: 0, open: 0, skippedDueToOutage: false });
    });
  });
});
