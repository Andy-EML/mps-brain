import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  cartridgeFamilies,
  cartridgeFamilyModels,
  counterSnapshots,
  counterValues,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  vantageEquipment,
  vantageMeterReadings,
  users,
  vantageWorkVisits,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getDeviceParts } from './device-parts';
import { setFamilyPartLives } from './pm-queries';
import { listFamilies } from './site-stock';

const d = (iso: string) => new Date(`${iso}T09:00:00Z`);
const NOW = d('2026-11-26');

describe('getDeviceParts', () => {
  let t: TestDb;
  let wid = 0;
  let rid = 0;
  let aid = 0;
  let famId: number;

  const visit = (iso: string, parts: [string, string][], over: { type?: string } = {}) =>
    t.db.insert(vantageWorkVisits).values({
      workUnitId: ++wid,
      workId: wid,
      vantageEquipmentId: 1,
      categoryId: 1,
      categoryName: 'Break/fix',
      categoryType: over.type ?? 'Field',
      loggedAt: d(iso),
      workStart: d(iso),
      workHours: 1,
      raw: {
        WorkItems: parts.map(([description, partNumber]) => ({ Status: 'Used', Quantity: 1, Item: { Description: description, PartNumber: partNumber } })),
      },
    });
  const reading = (iso: string, black: number, colour?: number) => {
    const rows = [{ vantageId: ++rid, vantageEquipmentId: 1, meterTypeId: 1, readingAt: d(iso), reading: black, raw: {} }];
    if (colour !== undefined) rows.push({ vantageId: ++rid, vantageEquipmentId: 1, meterTypeId: 2, readingAt: d(iso), reading: colour, raw: {} });
    return t.db.insert(vantageMeterReadings).values(rows);
  };
  const alarm = (iso: string, description: string, category = 'parts') =>
    t.db.insert(deviceAlarms).values({ alarmId: `a${++aid}`, drmsEquipmentId: 'dr1', receivedTime: d(iso), description, category, raw: {} });

  beforeEach(async () => {
    t = await createTestDb();
    wid = rid = aid = 0;
    await t.db.insert(vantageEquipment).values({ vantageId: 1, customerName: 'Acme', serial: 'S1', raw: {} });
    await t.db.insert(drmsEquipment).values({ drmsId: 'dr1', modelName: 'bizhub C3350i', serial: 'S1', isColour: true, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dr1', vantageEquipmentId: 1, method: 'serial' });
    const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'C3350', isColour: true }).returning();
    famId = fam!.id;
    await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub C3350i', familyId: famId });
  });
  afterEach(() => t.close());

  it('reads toner levels and the page meter from the latest DRMS counters, by either id', async () => {
    const [s] = await t.db.insert(counterSnapshots).values({ drmsEquipmentId: 'dr1', counterId: 'c1', receivedTime: d('2026-11-25'), fetchedAt: d('2026-11-25'), raw: {} }).returning();
    await t.db.insert(counterValues).values([
      { snapshotId: s!.id, name: 'BlackTonerLevel', value: 40 },
      { snapshotId: s!.id, name: 'CyanTonerLevel', value: 70 },
      { snapshotId: s!.id, name: 'Black:Total', value: 3000 },
      { snapshotId: s!.id, name: 'Full Color:Total', value: 1000 },
    ]);
    const byDrms = await getDeviceParts(t.db, { drmsEquipmentId: 'dr1' }, NOW);
    const byVantage = await getDeviceParts(t.db, { vantageEquipmentId: 1 }, NOW);
    expect(byDrms.vantageEquipmentId).toBe(1);
    expect(byVantage.drmsEquipmentId).toBe('dr1');
    expect(byDrms.toner).toMatchObject({ black: 40, cyan: 70, magenta: null, yellow: null });
    expect(byDrms.toner.readAt).toEqual(d('2026-11-25'));
    expect(byDrms.pagesNow).toBe(4000);
    expect(byDrms.familyName).toBe('C3350');
    expect(byDrms.isColour).toBe(true);
  });

  it('gives drum rows per colour, plus belt and fuser, for a colour machine with no developer evidence', async () => {
    const r = await getDeviceParts(t.db, { vantageEquipmentId: 1 }, NOW);
    expect(r.parts.map((p) => `${p.part}${p.colour ? `:${p.colour}` : ''}`)).toEqual([
      'drum:K', 'drum:C', 'drum:M', 'drum:Y',
      'transfer_belt', 'fuser',
    ]);
    expect(r.parts.every((p) => p.state === 'ok' && p.lastFitted === null && p.pagesSince === null)).toBe(true);
  });

  it('shows developer rows for every colour once there is a developer fit, alarm or rated life', async () => {
    const names = async () =>
      (await getDeviceParts(t.db, { vantageEquipmentId: 1 }, NOW)).parts.filter((p) => p.part === 'developer').map((p) => p.colour);
    expect(await names()).toEqual([]);
    await setFamilyPartLives(t.db, famId, { developerCmy: 80_000 });
    expect(await names()).toEqual(['K', 'C', 'M', 'Y']);
    await setFamilyPartLives(t.db, famId, { developerCmy: null });
    expect(await names()).toEqual([]);
    await alarm('2026-10-09', 'PartsLife(DC_C) 2nd Call');
    expect(await names()).toEqual(['K', 'C', 'M', 'Y']);
  });

  it('takes the latest alarm as the current state, so a later 1st call or prediction after an end means it was replaced', async () => {
    await alarm('2026-09-01', 'PartsLife(IU_K) 2nd Call');
    let r = await getDeviceParts(t.db, { drmsEquipmentId: 'dr1' }, NOW);
    expect(r.parts.find((p) => p.part === 'drum' && p.colour === 'K')!.state).toBe('end');
    // No fit was logged, but a later prediction shows the life cycle restarted.
    await alarm('2026-11-01', 'PartsLifePrediction(IU_K) 1st Call');
    r = await getDeviceParts(t.db, { drmsEquipmentId: 'dr1' }, NOW);
    expect(r.parts.find((p) => p.part === 'drum' && p.colour === 'K')).toMatchObject({
      state: 'predicted',
      alarm: { level: 'predicted', receivedAt: d('2026-11-01') },
    });
  });

  it('uses a reading after the fit when the one before is too old', async () => {
    await setFamilyPartLives(t.db, famId, { drumK: 100_000 });
    await reading('2026-01-01', 1_000, 0);
    await reading('2026-11-25', 31_000, 0);
    await reading('2026-11-26', 31_000, 0);
    await visit('2026-11-20', [['IUP35K - Black IU C3350i', 'IUP35K']]);
    // Before: 2026-01-01 is far away; after: 2026-11-25, 5 days from the fit, interpolation span too long.
    const drum = (await getDeviceParts(t.db, { vantageEquipmentId: 1 }, NOW)).parts.find((p) => p.part === 'drum' && p.colour === 'K')!;
    expect(drum.pagesSince).toBe(0);
    expect(drum.pagesSinceEstimated).toBe(true);
  });

  it('works out last fitted, pages since and estimated life left from visits, meters and rated life', async () => {
    await setFamilyPartLives(t.db, famId, { drumK: 100_000, drumCmy: 50_000, fuser: 200_000 });
    await reading('2026-06-01', 10_000, 10_000);
    await reading('2026-11-20', 40_000, 20_000);
    await visit('2026-06-01', [
      ['IUP35K - Black IU C3350i', 'IUP35K'],
      ['Katun CMY Drum Unit', 'X'],
      ['Pick up roller', 'P'],
      ['IU Chip Black', 'CHIP'],
    ]);
    const r = await getDeviceParts(t.db, { vantageEquipmentId: 1 }, NOW);
    const row = (part: string, colour: string | null) => r.parts.find((p) => p.part === part && p.colour === colour)!;
    // black drum: combined meter 20,000 at the fit, 60,000 now
    expect(row('drum', 'K')).toMatchObject({ pagesSince: 40_000, ratedLife: 100_000, lastFitted: { day: '2026-06-01' } });
    expect(row('drum', 'K').pctLeft).toBeCloseTo(0.6);
    // colour drums count colour pages: 10,000 at the fit, 20,000 now
    expect(row('drum', 'C')).toMatchObject({ pagesSince: 10_000, ratedLife: 50_000 });
    expect(row('drum', 'C').pctLeft).toBeCloseTo(0.8);
    expect(r.parts.some((p) => p.part === 'developer')).toBe(false); // no developer evidence
    expect(row('fuser', null)).toMatchObject({ lastFitted: null, ratedLife: 200_000, pctLeft: null });
    expect(r.pagesNow).toBe(60_000);
  });

  it('clamps estimated life left at zero, and gives no pages when there is no meter near the fit', async () => {
    await setFamilyPartLives(t.db, famId, { drumK: 10_000, developerK: 10_000 });
    await reading('2026-11-20', 40_000, 20_000);
    await reading('2026-11-25', 50_000, 20_000);
    await visit('2026-11-20', [['IUP35K - Black IU C3350i', 'IUP35K']]);
    await visit('2025-01-10', [['Konica C3350i Black Developing Unit', 'DV']]);
    const r = await getDeviceParts(t.db, { vantageEquipmentId: 1 }, NOW);
    const drum = r.parts.find((p) => p.part === 'drum' && p.colour === 'K')!;
    expect(drum.pagesSince).toBe(10_000);
    expect(drum.pctLeft).toBe(0);
    const dev = r.parts.find((p) => p.part === 'developer' && p.colour === 'K')!;
    expect(dev.lastFitted?.day).toBe('2025-01-10');
    expect(dev.pagesSince).toBeNull();
    expect(dev.pctLeft).toBeNull();
  });

  it('ranks alarms end > near end > predicted, and clears them once the part is fitted on or after the alarm day', async () => {
    await alarm('2026-10-01', 'PartsLifePrediction(IU_K) 1st Call');
    await alarm('2026-10-05', 'PartsLife(IU_K) 1st Call');
    await alarm('2026-10-09', 'PartsLife(DC_C) 2nd Call');
    await alarm('2026-10-09', 'PartsLife(Transfer belt unit) 1st Call');
    await alarm('2026-10-10', 'PartsLife(IU_Y) 2nd Call');
    await visit('2026-10-10', [['Yellow Drum Unit C3350i', 'Y']]);
    await alarm('2026-10-12', 'TZ-04 Missing:(Parts Missing Drum (K))');
    let r = await getDeviceParts(t.db, { drmsEquipmentId: 'dr1' }, NOW);
    const find = (part: string, colour: string | null) => r.parts.find((p) => p.part === part && p.colour === colour)!;
    expect(find('drum', 'K')).toMatchObject({ state: 'near_end', alarm: { level: 'near_end', receivedAt: d('2026-10-05') } });
    expect(find('developer', 'C').state).toBe('end');
    expect(find('transfer_belt', null).state).toBe('near_end');
    expect(find('drum', 'Y').state).toBe('cleared'); // fitted the same day
    expect(find('drum', 'M').state).toBe('ok');

    // A later alarm after the fit shows again.
    await alarm('2026-11-01', 'PartsLifePrediction(IU_Y) 1st Call');
    r = await getDeviceParts(t.db, { drmsEquipmentId: 'dr1' }, NOW);
    expect(find('drum', 'Y').state).toBe('predicted');
  });

  it('flags a PM Count warning until a field visit on or after it', async () => {
    await alarm('2026-11-10', 'PM Warning(PM Count)', 'other');
    let r = await getDeviceParts(t.db, { drmsEquipmentId: 'dr1' }, NOW);
    expect(r.pmCountWarning).toEqual({ receivedAt: d('2026-11-10') });
    await visit('2026-11-12', []);
    r = await getDeviceParts(t.db, { drmsEquipmentId: 'dr1' }, NOW);
    expect(r.pmCountWarning).toBeNull();
    expect(r.lastVisit).toMatchObject({ day: '2026-11-12' });
  });

  it('is black only on a mono machine, and works with no Vantage link', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'mono1', modelName: 'bizhub 4050i', serial: 'M1', isColour: false, raw: {} });
    const r = await getDeviceParts(t.db, { drmsEquipmentId: 'mono1' }, NOW);
    expect(r.vantageEquipmentId).toBeNull();
    expect(r.isColour).toBe(false);
    expect(r.parts.map((p) => `${p.part}${p.colour ? `:${p.colour}` : ''}`)).toEqual(['drum:K', 'developer:K', 'fuser']);
  });

  it('saves rated lives per family and rejects bad values', async () => {
    await setFamilyPartLives(t.db, famId, { drumK: 100_000, transferBelt: 300_000 });
    await setFamilyPartLives(t.db, famId, { drumK: null });
    const fam = (await listFamilies(t.db)).find((f) => f.id === famId)!;
    expect(fam.partLives).toEqual({
      drumK: null, drumCmy: null, developerK: null, developerCmy: null, transferBelt: 300_000, transferRoller: null, fuser: null,
    });
    await expect(setFamilyPartLives(t.db, famId, { fuser: 0 })).rejects.toThrow();
  });

  it('writes an audit entry when a user saves part lives, and none for an empty change', async () => {
    const [u] = await t.db.insert(users).values({ username: 'a', passwordHash: 'x' }).returning();
    await setFamilyPartLives(t.db, famId, {}, u!.id);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    await setFamilyPartLives(t.db, famId, { drumK: 100_000, fuser: null }, u!.id);
    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: u!.id,
      action: 'family.part_lives',
      entity: 'cartridge_family',
      entityIds: [famId],
      details: { lives: { drumK: 100_000, fuser: null } },
    });
  });
});
