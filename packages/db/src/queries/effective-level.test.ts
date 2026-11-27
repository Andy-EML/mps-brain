import { effectiveTonerLevel } from '@mps/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceAlarms, deviceLinks, drmsEquipment, counterSnapshots, counterValues, vantageEquipment } from '../schema';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../testing';
import { getDevice } from './device';
import { listDevices } from './devices';
import { getFleetSummary } from './fleet';
import { deliveryAlarmSql, effectiveLevelSql } from './shared';

const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('effectiveLevelSql mirrors effectiveTonerLevel', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const cases: { level: number | null; readAt: Date | null; deliveryAt: Date | null }[] = [
    { level: 8, readAt: d('2026-11-20'), deliveryAt: d('2026-11-21') },
    { level: 8, readAt: d('2026-11-22'), deliveryAt: d('2026-11-21') },
    { level: 8, readAt: d('2026-11-21'), deliveryAt: d('2026-11-21') },
    { level: 8, readAt: d('2026-11-21'), deliveryAt: null },
    { level: null, readAt: null, deliveryAt: d('2026-11-21') },
    { level: null, readAt: null, deliveryAt: null },
    { level: 55, readAt: null, deliveryAt: d('2026-11-21') },
  ];
  for (const c of cases) {
    it(`agrees for ${JSON.stringify(c)}`, async () => {
      const lvl = sql`${c.level}::double precision`;
      const read = sql`${c.readAt ? c.readAt.toISOString() : null}::timestamptz`;
      const del = sql`${c.deliveryAt ? c.deliveryAt.toISOString() : null}::timestamptz`;
      const res = await t.db.execute(sql`select ${effectiveLevelSql(lvl, read, del)} as v`);
      const v = (res.rows[0] as { v: number | null }).v;
      expect(v === null ? null : Number(v)).toBe(effectiveTonerLevel(c).level);
    });
  }
});

describe('effective toner level in the queries', () => {
  let t: TestDb;
  let seq = 0;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'a', modelName: 'bizhub C300i', serial: 'S1', isColour: true, raw: {} },
      { drmsId: 'm', modelName: 'bizhub 4752', serial: 'S2', isColour: false, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([{ vantageId: 100, raw: {} }]);
    await t.db.insert(deviceLinks).values([{ drmsEquipmentId: 'a', vantageEquipmentId: 100, method: 'serial' }]);
  });
  afterEach(() => t.close());

  async function reading(drmsId: string, at: string, levels: Record<string, number>) {
    const [s] = await t.db
      .insert(counterSnapshots)
      .values({ drmsEquipmentId: drmsId, counterId: `c${++seq}`, receivedTime: new Date(at), fetchedAt: new Date(at), raw: {} })
      .returning();
    await t.db.insert(counterValues).values(Object.entries(levels).map(([name, value]) => ({ snapshotId: s!.id, name, value })));
  }
  const delivery = (drmsId: string, at: string, description: string) =>
    t.db.insert(deviceAlarms).values({ alarmId: `e${++seq}`, drmsEquipmentId: drmsId, receivedTime: new Date(at), description, status: 'EquipmentDiscovered', category: 'toner', raw: {} });

  it('shows 100% (with the date) when the Delivery is newer than the reading, and the reading otherwise', async () => {
    await reading('a', '2026-11-20T02:00:00Z', { BlackTonerLevel: 6, CyanTonerLevel: 6, MagentaTonerLevel: 6, YellowTonerLevel: 6 });
    await delivery('a', '2026-11-21T09:00:00Z', 'Toner Delivery(BK)');
    await delivery('a', '2026-11-19T09:00:00Z', 'Toner Delivery(C)'); // older than the reading: ignored
    const dev = (await getDevice(t.db, 'a'))!.device;
    expect(dev.toner).toEqual({ black: 100, cyan: 6, magenta: 6, yellow: 6 });
    expect(dev.tonerNew).toEqual({ black: new Date('2026-11-21T09:00:00Z') });
    const { rows } = await listDevices(t.db, {});
    expect(rows.find((r) => r.drmsId === 'a')!.toner.black).toBe(100);
  });

  it('a newer reading wins over an older Delivery', async () => {
    await delivery('a', '2026-11-19T09:00:00Z', 'Toner Delivery(BK)');
    await reading('a', '2026-11-20T02:00:00Z', { BlackTonerLevel: 90 });
    expect((await getDevice(t.db, 'a'))!.device.toner.black).toBe(90);
  });

  it('a snapshot with no received_time is read at its fetched_at, so an older Delivery does not win', async () => {
    const [s] = await t.db
      .insert(counterSnapshots)
      .values({ drmsEquipmentId: 'a', counterId: `c${++seq}`, receivedTime: null, fetchedAt: new Date('2026-11-20T02:00:00Z'), raw: {} })
      .returning();
    await t.db.insert(counterValues).values({ snapshotId: s!.id, name: 'BlackTonerLevel', value: 90 });
    await delivery('a', '2026-11-19T09:00:00Z', 'Toner Delivery(BK)');
    expect((await getDevice(t.db, 'a'))!.device.toner.black).toBe(90);
    expect((await listDevices(t.db, {})).rows.find((r) => r.drmsId === 'a')!.toner.black).toBe(90);
    await delivery('a', '2026-11-21T09:00:00Z', 'Toner Delivery(BK)');
    expect((await getDevice(t.db, 'a'))!.device.toner.black).toBe(100);
  });

  it('the needs-toner count and filter use the effective level', async () => {
    await reading('a', '2026-11-20T02:00:00Z', { BlackTonerLevel: 6, CyanTonerLevel: 60, MagentaTonerLevel: 60, YellowTonerLevel: 60 });
    expect((await getFleetSummary(t.db)).needsToner).toBe(1);
    await delivery('a', '2026-11-21T09:00:00Z', 'Toner Delivery(K)');
    expect((await getFleetSummary(t.db)).needsToner).toBe(0);
    expect((await listDevices(t.db, { filter: 'needs-toner' })).rows).toHaveLength(0);
  });

  it('a colour Delivery on a mono device is ignored', async () => {
    await reading('m', '2026-11-20T02:00:00Z', { BlackTonerLevel: 50, CyanTonerLevel: 0 });
    await delivery('m', '2026-11-21T09:00:00Z', 'Toner Delivery(C)');
    const row = (await listDevices(t.db, {})).rows.find((r) => r.drmsId === 'm')!;
    expect(row.toner.cyan).toBeNull();
  });
});

describe('deliveryAlarmSql', () => {
  it('matches the partial index predicate, so the planner can use device_alarms_delivery_idx', async () => {
    const t = await createTestDb();
    try {
      const q = t.db.select({ id: deviceAlarms.alarmId }).from(deviceAlarms).where(deliveryAlarmSql()).toSQL();
      expect(q.params).toEqual([]);
      await t.db.execute(sql`set enable_seqscan = off`);
      const plan = await t.db.execute(sql.raw(`explain ${q.sql}`));
      expect(JSON.stringify(plan.rows)).toContain('device_alarms_delivery_idx');
    } finally {
      await t.close();
    }
  });
});
