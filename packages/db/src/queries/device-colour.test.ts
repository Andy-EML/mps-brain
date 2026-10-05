import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getDeviceIsColourByVantageEquipmentIds } from './device-colour';

describe('getDeviceIsColourByVantageEquipmentIds', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('prefers the linked DRMS device is_colour flag', async () => {
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'd-mono', isColour: false, raw: {} },
      { drmsId: 'd-colour', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      // Description alone would say colour (C…), but the linked DRMS device wins.
      { vantageId: 101, description: 'bizhub C3350i', raw: {} },
      { vantageId: 102, description: 'bizhub 4750i', raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'd-mono', vantageEquipmentId: 101, method: 'serial' },
      { drmsEquipmentId: 'd-colour', vantageEquipmentId: 102, method: 'serial' },
    ]);

    const out = await getDeviceIsColourByVantageEquipmentIds(t.db, [101, 102]);
    expect(out.get(101)).toBe(false);
    expect(out.get(102)).toBe(true);
  });

  it('falls back to isColourModel on the Vantage equipment description when there is no active link', async () => {
    await t.db.insert(vantageEquipment).values([
      { vantageId: 201, description: 'bizhub C3350i', raw: {} },
      { vantageId: 202, description: 'bizhub 4750i', raw: {} },
      { vantageId: 203, description: null, raw: {} },
    ]);

    const out = await getDeviceIsColourByVantageEquipmentIds(t.db, [201, 202, 203]);
    expect(out.get(201)).toBe(true);
    expect(out.get(202)).toBe(false);
    expect(out.get(203)).toBe(false); // no model text: mono is the safe default (isColourModel)
  });

  it('ignores a closed link and falls back to the description', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd-old', isColour: true, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 301, description: 'bizhub 4750i', raw: {} });
    await t.db.insert(deviceLinks).values({
      drmsEquipmentId: 'd-old',
      vantageEquipmentId: 301,
      method: 'serial',
      unlinkedAt: new Date('2026-09-01T00:00:00Z'),
    });

    const out = await getDeviceIsColourByVantageEquipmentIds(t.db, [301]);
    expect(out.get(301)).toBe(false);
  });

  it('returns an empty map for no ids and omits an id that does not exist', async () => {
    expect((await getDeviceIsColourByVantageEquipmentIds(t.db, [])).size).toBe(0);
    expect((await getDeviceIsColourByVantageEquipmentIds(t.db, [999])).has(999)).toBe(false);
  });
});
