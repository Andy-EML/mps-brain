import { auditLog, cartridgeFamilies, cartridgeFamilyModels } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSeedFile, planSeed, seedCartridgeFamilies } from './seed-cartridge-families';

describe('parseSeedFile', () => {
  it('accepts a valid list and rejects malformed entries', () => {
    expect(parseSeedFile([{ name: ' A ', isColour: true, models: ['x', 'x'] }])).toEqual([{ name: 'A', isColour: true, models: ['x'] }]);
    expect(() => parseSeedFile({})).toThrow(/array/);
    expect(() => parseSeedFile([{ name: 'A', isColour: 'yes', models: [] }])).toThrow(/isColour/);
  });
});

describe('planSeed', () => {
  it('skips existing families and models already owned elsewhere', () => {
    const plan = planSeed(
      [
        { name: 'C250i / C300i', isColour: true, models: ['bizhub C250i', 'bizhub C300i'] },
        { name: '450i', isColour: false, models: ['bizhub 450i', 'bizhub C300i'] },
      ],
      ['c250i / c300i'],
      [],
    );
    expect(plan.existing).toEqual(['C250i / C300i']);
    expect(plan.create).toEqual([{ name: '450i', isColour: false, models: ['bizhub 450i', 'bizhub C300i'] }]);
  });
});

describe('seedCartridgeFamilies', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const wanted = [{ name: 'C250i / C300i', isColour: true, models: ['bizhub C250i', 'bizhub C300i'] }];

  it('writes nothing on a dry run', async () => {
    const plan = await seedCartridgeFamilies(t.db, wanted, { apply: false });
    expect(plan.create).toHaveLength(1);
    expect(await t.db.select().from(cartridgeFamilies)).toHaveLength(0);
  });

  it('inserts missing families with an audit row, and a second run changes nothing', async () => {
    await seedCartridgeFamilies(t.db, wanted, { apply: true });
    expect(await t.db.select().from(cartridgeFamilies)).toHaveLength(1);
    expect(await t.db.select().from(cartridgeFamilyModels)).toHaveLength(2);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBeNull();

    const again = await seedCartridgeFamilies(t.db, wanted, { apply: true });
    expect(again.create).toHaveLength(0);
    expect(await t.db.select().from(cartridgeFamilies)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });
});
