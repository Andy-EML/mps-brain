import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isColourModel } from '@mps/core';
import { inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppState, setAppState } from './app-state';
import { migrationsFolder } from './migrate';
import {
  counterSnapshots,
  deviceAlarms,
  deviceAlerts,
  deviceLinks,
  drmsEquipment,
  linkIssues,
  replenishmentProposals,
  replenishmentSettings,
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

  it("backfills is_colour for rows that predate the column, agreeing with the helper's rule", async () => {
    // The 0006 migration carries a one-off UPDATE for the 836 devices that were already in the
    // table when the column arrived. Tests always migrate an empty database, so that statement
    // would otherwise never be exercised at all: here we run the shipped SQL itself over rows that
    // look like the live fleet and check it reaches the same verdict as `isColourModel`, which owns
    // the rule for every write after the migration.
    const models = [
      'bizhub C3350i',
      'bizhub C 258',
      'C458',
      'ineo+308',
      'A-Plan (Southampton) MF3303',
      'bizhub 301i',
      'bizhub 4050i',
      'bizhub 4701i',
      'Konica Minolta bizhub 751i',
      '287',
      null,
    ];
    const ids = models.map((_, i) => `backfill-${i}`);
    await t.db
      .insert(drmsEquipment)
      .values(models.map((modelName, i) => ({ drmsId: ids[i]!, modelName, raw: {} })));

    const sqlFile = readFileSync(join(migrationsFolder, '0006_equipment_is_colour.sql'), 'utf8');
    const backfill = sqlFile
      .split('--> statement-breakpoint')
      // Anchored on the statement itself rather than a bare `includes('UPDATE')`: the word could
      // turn up in a comment, or a later edit could add a second UPDATE, and this test would then
      // fuzz the wrong statement while still passing.
      .find((statement) => /^\s*UPDATE\s+"drms_equipment"/m.test(statement));
    if (!backfill) throw new Error('0006 migration no longer contains the backfill UPDATE');
    await t.db.execute(sql.raw(backfill));

    const rows = await t.db
      .select({ modelName: drmsEquipment.modelName, isColour: drmsEquipment.isColour })
      .from(drmsEquipment)
      .where(inArray(drmsEquipment.drmsId, ids));

    expect(rows).toHaveLength(models.length);
    for (const row of rows) expect([row.modelName, row.isColour]).toEqual([row.modelName, isColourModel(row.modelName)]);
    // Guard against a statement that flags everything (or nothing) and still "agrees" by accident.
    expect(rows.filter((r) => r.isColour)).toHaveLength(5);
  });

  it('stores and overwrites app state', async () => {
    expect(await getAppState(t.db, 'x')).toBeNull();
    await setAppState(t.db, 'x', { a: 1 });
    await setAppState(t.db, 'x', { a: 2 });
    expect(await getAppState<{ a: number }>(t.db, 'x')).toEqual({ a: 2 });
  });
});

describe('replenishment schema', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('seeds exactly one default settings row with the agreed defaults', async () => {
    const rows = await t.db.select().from(replenishmentSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scope: 'default', thresholdBlack: 15, thresholdCyan: 10, thresholdMagenta: 10, thresholdYellow: 10,
      autoReplenish: true, alertsEnabled: true, drmsEquipmentId: null, vantageCustomerId: null,
    });
  });

  it('allows one settings row per device and per customer', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd1', raw: {} });
    await t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'd1', thresholdBlack: 20 });
    await expect(
      t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'd1', thresholdBlack: 30 }),
    ).rejects.toThrow();
    await t.db.insert(replenishmentSettings).values({ scope: 'customer', vantageCustomerId: 7, autoReplenish: false });
    await expect(t.db.insert(replenishmentSettings).values({ scope: 'customer', vantageCustomerId: 7 })).rejects.toThrow();
    await expect(t.db.insert(replenishmentSettings).values({ scope: 'default' })).rejects.toThrow();
  });

  it('rejects a device row without a device id and a threshold outside 0-100', async () => {
    await expect(t.db.insert(replenishmentSettings).values({ scope: 'device' })).rejects.toThrow();
    await t.db.insert(drmsEquipment).values({ drmsId: 'd2', raw: {} });
    await expect(
      t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'd2', thresholdCyan: 101 }),
    ).rejects.toThrow();
  });

  it('allows only one live proposal per device and colour', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd3', raw: {} });
    const base = { drmsEquipmentId: 'd3', colour: 'cyan', trigger: 'threshold' } as const;
    await t.db.insert(replenishmentProposals).values({ ...base, status: 'pending' });
    await expect(t.db.insert(replenishmentProposals).values({ ...base, status: 'approved' })).rejects.toThrow();
    await t.db.insert(replenishmentProposals).values({ ...base, status: 'rejected' });
    await t.db.insert(replenishmentProposals).values({ ...base, colour: 'black', status: 'pending' });
  });
});
