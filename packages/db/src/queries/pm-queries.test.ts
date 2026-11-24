import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  counterSnapshots,
  counterValues,
  deviceLinks,
  drmsEquipment,
  hiddenDevices,
  postcodeDistricts,
  vantageCustomers,
  vantageEquipment,
  vantageEquipmentContracts,
  vantageMeterReadings,
  vantageWorkVisits,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { loadCombinedMeters } from './meter-history';
import { DEFAULT_PM_SETTINGS, type PmStatus } from './pm-due';
import { SettingsError } from './settings';
import { setOtherDealer } from './other-dealer';
import { dismissPm, markPmBooked, undoPmAction } from './pm-actions';
import { addToPlan, setPriority, setWhenInArea } from './pm-plan';
import { pmActions, users } from '../schema';
import { getEquipmentPm, getPmSettings, inPmView, listPmDue, listPmForEquipment, listWorkCategories, savePmSettings, setFamilyPmInterval, type PmRow } from './pm-queries';

const d = (iso: string) => new Date(`${iso}T09:00:00Z`);
const NOW = d('2026-11-18');

describe('inPmView', () => {
  const row = (status: PmStatus, over: Partial<PmRow> = {}): PmRow => ({
    vantageEquipmentId: 1,
    drmsEquipmentId: null,
    customerName: 'Acme',
    town: null,
    customerId: null,
    district: null,
    county: null,
    areaCounty: null,
    familyId: null,
    otherDealer: { dealer: null, source: null, region: null },
    plan: { whenInArea: false, priority: false, boardColumn: null },
    serial: 'A1',
    model: 'C300i',
    family: null,
    intervalPages: 100000,
    intervalSource: 'global',
    action: null,
    bookedOverdue: false,
    view: 'due',
    result: {
      status,
      reason: null,
      lastQualifying: null,
      pagesSince: null,
      pagesSinceIsLowerBound: false,
      pctUsed: null,
      pagesPerDay: null,
      estDueDate: null,
      timeCapDate: null,
      clockStart: null,
      clockSource: null,
      bookedFor: null,
      frequentVisits: 0,
      holdUntil: null,
      visits: [],
    },
    ...over,
  });

  it('puts due rows in Due only when they need PM or a booking went unseen', () => {
    expect(inPmView(row('overdue'), 'due', NOW)).toBe(true);
    expect(inPmView(row('ok'), 'due', NOW)).toBe(false);
    expect(inPmView(row('ok', { bookedOverdue: true }), 'due', NOW)).toBe(true);
    expect(inPmView(row('overdue', { view: 'dismissed' }), 'due', NOW)).toBe(false);
  });

  it('matches Booked and Dismissed on the row view, and All takes everything', () => {
    expect(inPmView(row('booked', { view: 'booked' }), 'booked', NOW)).toBe(true);
    expect(inPmView(row('overdue'), 'booked', NOW)).toBe(false);
    expect(inPmView(row('overdue', { view: 'dismissed' }), 'dismissed', NOW)).toBe(true);
    expect(inPmView(row('ok', { view: 'dismissed' }), 'all', NOW)).toBe(true);
  });
});

describe('pm queries', () => {
  let t: TestDb;
  let rid = 0;
  let wid = 0;

  const machine = (id: number, customer = `Cust ${id}`) => t.db.insert(vantageEquipment).values({ vantageId: id, customerName: customer, serial: `SER${id}`, raw: { Item: { IsMetered: true, NominalCode: '4000' } } });
  const contract = (id: number, isActive = true) =>
    t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: id, contractId: id * 10, contractReference: `C${id}`, isActive });
  const reading = (id: number, iso: string, value: number, typeId = 1) =>
    t.db.insert(vantageMeterReadings).values({ vantageId: ++rid, vantageEquipmentId: id, meterTypeId: typeId, readingAt: d(iso), reading: value, raw: {} });
  const visit = (id: number, iso: string, o: { hours?: number; categoryId?: number; categoryName?: string; type?: string; scheduled?: string; completed?: string | null; action?: string; raw?: unknown } = {}) =>
    t.db.insert(vantageWorkVisits).values({
      workUnitId: ++wid,
      workId: wid,
      vantageEquipmentId: id,
      categoryId: o.categoryId ?? 1,
      categoryName: o.categoryName ?? (o.type === 'Office' ? 'Office' : 'Break/fix'),
      categoryType: o.type ?? 'Field',
      loggedAt: d(iso),
      workStart: d(iso),
      workHours: o.hours ?? 1,
      scheduledStart: o.scheduled ? d(o.scheduled) : null,
      completedAt: o.completed === undefined || o.completed === null ? null : d(o.completed),
      actionDetails: o.action ?? null,
      raw: o.raw ?? {},
    });

  beforeEach(async () => {
    t = await createTestDb();
    rid = 0;
    wid = 0;
  });
  afterEach(() => t.close());

  it('lists only real machines: unmetered items and 4013 software/support contracts are excluded', async () => {
    const item = (id: number, raw: unknown) =>
      t.db.insert(vantageEquipment).values({ vantageId: id, customerName: `Cust ${id}`, serial: `SER${id}`, raw });
    await item(1, { Item: { IsMetered: true, NominalCode: '4000' } });
    await item(2, { Item: { IsMetered: true, NominalCode: '4013' } });
    await item(3, { Item: { IsMetered: false, NominalCode: '4000' } });
    await item(4, {});
    for (const id of [1, 2, 3, 4]) await contract(id);
    const rows = await listPmDue(t.db, NOW);
    expect(rows.map((r) => r.vantageEquipmentId)).toEqual([1]);
    expect(await getEquipmentPm(t.db, 2, NOW)).toBeNull();
    expect(await getEquipmentPm(t.db, 3, NOW)).toBeNull();
    expect(await getEquipmentPm(t.db, 1, NOW)).not.toBeNull();
  });

  it('sorts the filtered rows by the chosen key, ties on the equipment id, and no sort keeps the default', async () => {
    for (const id of [1, 2, 3]) {
      await machine(id, id === 2 ? 'same' : 'Same');
      await contract(id);
    }
    const ids = async (sort?: { key: 'customer' | 'serial'; dir: 'asc' | 'desc' }) =>
      (await listPmDue(t.db, NOW, sort ? { sort } : {})).map((r) => r.vantageEquipmentId);
    expect(await ids({ key: 'serial', dir: 'desc' })).toEqual([3, 2, 1]);
    expect(await ids({ key: 'serial', dir: 'asc' })).toEqual([1, 2, 3]);
    // All three customers tie case-insensitively, so the id decides in both directions.
    expect(await ids({ key: 'customer', dir: 'desc' })).toEqual([1, 2, 3]);
    expect(await ids()).toEqual([1, 2, 3]);
  });

  it('Vantage-only machine (no DRMS link) gets a series and a status', async () => {
    await machine(1);
    await contract(1);
    await reading(1, '2026-01-05', 1000);
    await reading(1, '2026-11-10', 50_000);
    await visit(1, '2026-01-10');
    const rows = await listPmDue(t.db, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vantageEquipmentId: 1, drmsEquipmentId: null, customerName: 'Cust 1', serial: 'SER1', intervalPages: 100_000, intervalSource: 'global' });
    expect(rows[0]!.result.status).toBe('ok');
    expect(rows[0]!.result.pagesSince).toBe(49_000);
    const series = await loadCombinedMeters(t.db, [1]);
    expect(series.get(1)!.map((p) => p.value)).toEqual([1000, 50_000]);
  });

  it('combines black and colour, and merges DRMS snapshots of the linked device', async () => {
    await machine(1);
    await t.db.insert(drmsEquipment).values({ drmsId: 'dr1', modelName: 'bizhub C300i', serial: 'SER1', isColour: true, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dr1', vantageEquipmentId: 1, method: 'serial' });
    await reading(1, '2026-01-05', 1000, 1);
    await reading(1, '2026-01-05', 500, 2);
    const [s] = await t.db.insert(counterSnapshots).values({ drmsEquipmentId: 'dr1', counterId: 'c1', receivedTime: d('2026-06-01'), fetchedAt: d('2026-06-01'), raw: {} }).returning();
    await t.db.insert(counterValues).values([
      { snapshotId: s!.id, name: 'Black:Total', value: 3000 },
      { snapshotId: s!.id, name: 'Full Color:Total', value: 1000 },
    ]);
    const series = (await loadCombinedMeters(t.db, [1])).get(1)!;
    expect(series.map((p) => p.value)).toEqual([1500, 4000]);
  });

  it('inactive-contract machine is excluded', async () => {
    await machine(1);
    await contract(1, false);
    await machine(2);
    await contract(2);
    await machine(3); // no contract rows at all
    const rows = await listPmDue(t.db, NOW);
    expect(rows.map((r) => r.vantageEquipmentId)).toEqual([2]);
    expect(await getEquipmentPm(t.db, 1, NOW)).toBeNull();
  });

  it('hidden device excluded', async () => {
    await machine(1);
    await contract(1);
    await machine(2);
    await contract(2);
    await t.db.insert(drmsEquipment).values({ drmsId: 'dr1', modelName: 'bizhub 4752', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dr1', vantageEquipmentId: 1, method: 'serial' });
    await t.db.insert(hiddenDevices).values({ drmsEquipmentId: 'dr1' });
    expect((await listPmDue(t.db, NOW)).map((r) => r.vantageEquipmentId)).toEqual([2]);
  });

  it('family pm_interval_pages overrides the global 100000', async () => {
    await machine(1);
    await contract(1);
    await t.db.insert(drmsEquipment).values({ drmsId: 'dr1', modelName: 'bizhub C300i', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dr1', vantageEquipmentId: 1, method: 'serial' });
    const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'C300', isColour: true }).returning();
    await t.db.insert(cartridgeFamilyModels).values({ model: 'bizhub C300i', familyId: fam!.id });
    await reading(1, '2026-01-05', 1000);
    await reading(1, '2026-11-10', 50_000);
    await visit(1, '2026-01-10');
    expect((await getEquipmentPm(t.db, 1, NOW))!.intervalSource).toBe('global');
    await setFamilyPmInterval(t.db, fam!.id, 30_000);
    const row = (await getEquipmentPm(t.db, 1, NOW))!;
    expect(row).toMatchObject({ intervalPages: 30_000, intervalSource: 'family', family: 'C300' });
    expect(row.result).toMatchObject({ status: 'overdue', reason: 'pages' });
    await setFamilyPmInterval(t.db, fam!.id, null);
    expect((await getEquipmentPm(t.db, 1, NOW))!.intervalPages).toBe(100_000);
  });

  it('listPmDue uses install_date', async () => {
    await t.db.insert(vantageEquipment).values({ vantageId: 1, customerName: 'New', serial: 'S1', installDate: d('2026-08-18'), raw: { Item: { IsMetered: true, NominalCode: '4000' } } });
    await contract(1);
    const [row] = await listPmDue(t.db, NOW);
    expect(row!.result.clockSource).toBe('install');
    expect(row!.result.status).toBe('unknown');
    expect(row!.result.reason).toBe('no_meter');
  });

  it("carries each visit unit's action text", async () => {
    await machine(1);
    await contract(1);
    await reading(1, '2026-01-05', 1000);
    await reading(1, '2026-11-10', 50_000);
    await visit(1, '2026-10-01', { action: 'Replaced fuser unit' });
    await visit(1, '2026-09-01');
    const units = (await getEquipmentPm(t.db, 1, NOW))!.result.visits.map((v) => v.visit.units[0]!.actionDetails);
    expect(units).toEqual(['Replaced fuser unit', null]);
  });

  it('loads the customer town from the Vantage customer, and the search matches it', async () => {
    await t.db.insert(vantageCustomers).values([
      { vantageId: 7, name: 'Acme', raw: { Town: 'Leeds', PostCode: 'LS1 1AA' } },
      { vantageId: 8, name: 'Beta', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 1, customerName: 'Acme', vantageCustomerId: 7, serial: 'S1', raw: { Item: { IsMetered: true, NominalCode: '4000' } } },
      { vantageId: 2, customerName: 'Beta', vantageCustomerId: 8, serial: 'S2', raw: { Item: { IsMetered: true, NominalCode: '4000' } } },
      { vantageId: 3, customerName: 'Gamma', serial: 'S3', raw: { Item: { IsMetered: true, NominalCode: '4000' } } },
    ]);
    await contract(1);
    await contract(2);
    await contract(3);
    const rows = await listPmDue(t.db, NOW, { view: 'all' });
    expect(rows.map((r) => [r.vantageEquipmentId, r.town])).toEqual([[1, 'Leeds'], [2, null], [3, null]]);
    expect((await listPmDue(t.db, NOW, { view: 'all', q: 'leeds' })).map((r) => r.vantageEquipmentId)).toEqual([1]);
  });

  describe('other dealer', () => {
    // 1: English site, 2: Irish site (Eircode), 3: no customer
    async function seed() {
      await t.db.insert(vantageCustomers).values([
        { vantageId: 7, name: 'Farnborough Ltd', raw: { Town: 'Farnborough', PostCode: 'gu14 7pr', County: 'Hampshire' } },
        { vantageId: 8, name: 'Dublin Ltd', raw: { PostCode: 'D04 EK2K' } },
      ]);
      await t.db.insert(vantageEquipment).values([
        { vantageId: 1, customerName: 'Farnborough Ltd', vantageCustomerId: 7, serial: 'S1', raw: { Item: { IsMetered: true, NominalCode: '4000' } } },
        { vantageId: 2, customerName: 'Dublin Ltd', vantageCustomerId: 8, serial: 'S2', raw: { Item: { IsMetered: true, NominalCode: '4000' } } },
        { vantageId: 3, customerName: 'Loose', serial: 'S3', raw: { Item: { IsMetered: true, NominalCode: '4000' } } },
      ]);
      for (const id of [1, 2, 3]) await contract(id);
    }
    const ids = (rows: { vantageEquipmentId: number }[]) => rows.map((r) => r.vantageEquipmentId);

    it('carries the customer id, district, county and the region-rule dealer on each row', async () => {
      await seed();
      const rows = await listPmDue(t.db, NOW, { dealer: 'all' });
      const by = Object.fromEntries(rows.map((r) => [r.vantageEquipmentId, r]));
      expect(by[1]).toMatchObject({ customerId: 7, district: 'GU14', county: 'Hampshire', otherDealer: { dealer: null, source: null, region: null }, plan: { whenInArea: false, priority: false } });
      expect(by[2]).toMatchObject({ customerId: 8, district: null, county: null, otherDealer: { dealer: 'MJ Flood', source: 'region', region: 'ireland' } });
      expect(by[3]).toMatchObject({ customerId: null, district: null, otherDealer: { dealer: null } });
    });

    it('areaCounty comes from the district cache', async () => {
      await t.db.insert(vantageCustomers).values({ vantageId: 7, name: 'Newbury Ltd', raw: { PostCode: 'RG20 8AA' } });
      await t.db.insert(vantageEquipment).values({ vantageId: 1, customerName: 'Newbury Ltd', vantageCustomerId: 7, serial: 'S1', raw: { Item: { IsMetered: true, NominalCode: '4000' } } });
      await contract(1);
      await t.db.insert(postcodeDistricts).values({ district: 'RG20', county: 'Berkshire', status: 'ok' });
      const rows = await listPmDue(t.db, NOW, { dealer: 'all' });
      expect(rows[0]!.areaCounty).toBe('Berkshire');
    });

    it('areaCounty null without cached district', async () => {
      await seed();
      await t.db.insert(postcodeDistricts).values({ district: 'D04', county: 'Dublin', status: 'not_found' });
      const rows = await listPmDue(t.db, NOW, { dealer: 'all' });
      expect(rows.map((r) => r.areaCounty)).toEqual([null, null, null]);
    });

    it('the default list drops an other-dealer site; other keeps only it; all keeps both', async () => {
      await seed();
      expect(ids(await listPmDue(t.db, NOW))).toEqual([1, 3]);
      expect(ids(await listPmDue(t.db, NOW, { dealer: 'ours' }))).toEqual([1, 3]);
      const other = await listPmDue(t.db, NOW, { dealer: 'other' });
      expect(ids(other)).toEqual([2]);
      expect(other[0]!.otherDealer.dealer).toBe('MJ Flood');
      expect(ids(await listPmDue(t.db, NOW, { dealer: 'all' }))).toEqual([1, 2, 3]);
      expect(ids(await listPmDue(t.db, NOW, { status: 'default' }))).toEqual([1, 3]);
    });

    it('a site flagged ours is back in the default list; a flagged dealer leaves it', async () => {
      await seed();
      await t.db.insert(users).values({ username: 'op', passwordHash: 'x' });
      const [u] = await t.db.select({ id: users.id }).from(users);
      await setOtherDealer(t.db, { vantageCustomerId: 8, mode: 'ours', userId: u!.id });
      await setOtherDealer(t.db, { vantageCustomerId: 7, mode: 'dealer', name: 'Acme Print', userId: u!.id });
      expect(ids(await listPmDue(t.db, NOW))).toEqual([2, 3]);
      const other = await listPmDue(t.db, NOW, { dealer: 'other' });
      expect(ids(other)).toEqual([1]);
      expect(other[0]!.otherDealer).toEqual({ dealer: 'Acme Print', source: 'site', region: null });
    });

    it('getEquipmentPm and listPmForEquipment still return an other-dealer machine, with its dealer', async () => {
      await seed();
      expect((await getEquipmentPm(t.db, 2, NOW))?.otherDealer.dealer).toBe('MJ Flood');
      expect((await listPmForEquipment(t.db, [2], NOW)).get(2)?.otherDealer.dealer).toBe('MJ Flood');
    });
  });

  it('default filter drops ok and booked', async () => {
    await savePmSettings(t.db, { ...DEFAULT_PM_SETTINGS, pmCategoryIds: [7] }, null);
    for (const id of [1, 2, 3, 4]) {
      await machine(id);
      await contract(id);
    }
    // 1: ok (49k pages since a recent visit)
    await reading(1, '2026-01-05', 1000);
    await reading(1, '2026-11-10', 50_000);
    await visit(1, '2026-01-10');
    // 2: booked (future PM-category unit)
    await visit(2, '2026-11-25', { categoryId: 7, type: 'Office', scheduled: '2026-11-25', completed: null });
    // 3: overdue (no visit at all)
    // 4: due soon (90k of 100k)
    await reading(4, '2026-01-05', 1000);
    await reading(4, '2026-11-10', 91_000);
    await visit(4, '2026-01-10');

    const all = await listPmDue(t.db, NOW);
    expect(Object.fromEntries(all.map((r) => [r.vantageEquipmentId, r.result.status]))).toEqual({ 1: 'ok', 2: 'booked', 3: 'overdue', 4: 'due_soon' });
    const def = await listPmDue(t.db, NOW, { status: 'default' });
    expect(def.map((r) => r.vantageEquipmentId)).toEqual([3, 4]);
    expect((await listPmDue(t.db, NOW, { status: ['booked'] })).map((r) => r.vantageEquipmentId)).toEqual([2]);
    expect((await listPmDue(t.db, NOW, { customer: 'cust 4' })).map((r) => r.vantageEquipmentId)).toEqual([4]);
    expect((await listPmDue(t.db, NOW, { q: 'ser1' })).map((r) => r.vantageEquipmentId)).toEqual([1]);
  });

  it('getPmSettings returns defaults when unset and saved values after savePmSettings', async () => {
    expect(await getPmSettings(t.db)).toEqual(DEFAULT_PM_SETTINGS);
    const next = { ...DEFAULT_PM_SETTINGS, intervalPages: 80_000, dueSoonPct: 0.9, pmCategoryIds: [3, 4] };
    await savePmSettings(t.db, next, null);
    expect(await getPmSettings(t.db)).toEqual(next);
    await expect(savePmSettings(t.db, { ...next, intervalPages: 0 }, null)).rejects.toBeInstanceOf(SettingsError);
    await expect(savePmSettings(t.db, { ...next, dueSoonPct: 0.2 }, null)).rejects.toBeInstanceOf(SettingsError);
    await expect(savePmSettings(t.db, { ...next, holdDays: 1.5 }, null)).rejects.toBeInstanceOf(SettingsError);
    expect(await getPmSettings(t.db)).toEqual(next);
  });

  it('getPmSettings with no saved row picks Planned maintenance as PM category', async () => {
    await machine(1);
    await visit(1, '2026-01-10', { categoryId: 1 });
    await visit(1, '2026-02-10', { categoryId: 5, categoryName: 'Planned maintenance', type: 'Planned maintenance' });
    expect((await getPmSettings(t.db)).pmCategoryIds).toEqual([5]);
  });

  it('getPmSettings with a saved [] stays []', async () => {
    await machine(1);
    await visit(1, '2026-02-10', { categoryId: 5, categoryName: 'Planned maintenance', type: 'Planned maintenance' });
    await savePmSettings(t.db, { ...DEFAULT_PM_SETTINGS, pmCategoryIds: [] }, null);
    expect((await getPmSettings(t.db)).pmCategoryIds).toEqual([]);
  });

  it('recent Planned maintenance visit with no saved settings counts as PM and resets the clock', async () => {
    await machine(1);
    await contract(1);
    await reading(1, '2026-01-05', 1000);
    await reading(1, '2026-11-12', 149_000);
    await reading(1, '2026-11-17', 150_000);
    await visit(1, '2026-01-10');
    await visit(1, '2026-11-13', { categoryId: 5, categoryName: 'Planned maintenance', type: 'Planned maintenance', hours: 0.2 });
    const r = (await getEquipmentPm(t.db, 1, NOW))!.result;
    expect(r.visits[0]!.verdict).toBe('counted_pm');
    expect(r.clockSource).toBe('visit');
    expect(r.clockStart).toEqual(d('2026-11-13'));
    expect(r.status).not.toBe('overdue');
  });

  it('reads used parts from the raw WorkItems, ignoring other statuses, and counts a fuser visit', async () => {
    await machine(1);
    await contract(1);
    await reading(1, '2026-01-05', 1000);
    await reading(1, '2026-11-17', 150_000);
    await visit(1, '2026-01-10');
    const wi = (status: string, description: string, q = 1) => ({ Status: status, Quantity: q, Item: { PartNumber: 'PN', Description: description } });
    await visit(1, '2026-11-13', {
      type: 'Office',
      hours: 0.3,
      raw: { WorkItems: [wi('Used', 'C250i Fuser Unit'), wi('Allocated', 'C250i Transfer Belt'), wi('used', 'Pickup Roller', 2)] },
    });
    const r = (await getEquipmentPm(t.db, 1, NOW))!.result;
    expect(r.visits[0]!.visit.units[0]!.parts).toEqual([
      { partNumber: 'PN', description: 'C250i Fuser Unit', quantity: 1 },
      { partNumber: 'PN', description: 'Pickup Roller', quantity: 2 },
    ]);
    expect(r.visits[0]!.verdict).toBe('counted_parts');
    expect(r.visits[0]!.visit.matchedParts).toEqual(['C250i Fuser Unit']);
  });

  it('a saved row without pmPartKeywords gets the default keywords; savePmSettings validates them', async () => {
    await savePmSettings(t.db, { ...DEFAULT_PM_SETTINGS, pmPartKeywords: ['fuser'] }, null);
    expect((await getPmSettings(t.db)).pmPartKeywords).toEqual(['fuser']);
    await expect(savePmSettings(t.db, { ...DEFAULT_PM_SETTINGS, pmPartKeywords: [''] }, null)).rejects.toBeInstanceOf(SettingsError);
    await expect(savePmSettings(t.db, { ...DEFAULT_PM_SETTINGS, pmPartKeywords: ['x'.repeat(51)] }, null)).rejects.toBeInstanceOf(SettingsError);
    await expect(savePmSettings(t.db, { ...DEFAULT_PM_SETTINGS, pmPartKeywords: Array.from({ length: 31 }, (_, i) => `k${i}`) }, null)).rejects.toBeInstanceOf(SettingsError);
  });

  it('Black A3 machine has no series (unknown, still time-capped)', async () => {
    for (const id of [1, 2]) {
      await machine(id);
      await contract(id);
      await reading(id, '2026-01-05', 1000, 1);
      await reading(id, '2026-11-10', 90_000, 1);
      await reading(id, '2026-11-10', 5000, 12);
    }
    await visit(1, '2026-06-01'); // recent: pages unusable
    await visit(2, '2025-06-01'); // older than the 12 month cap
    expect((await loadCombinedMeters(t.db, [1, 2])).size).toBe(0);
    const rows = await listPmDue(t.db, NOW);
    const byId = Object.fromEntries(rows.map((r) => [r.vantageEquipmentId, r.result]));
    expect(byId[1]).toMatchObject({ status: 'unknown', reason: 'no_meter' });
    expect(byId[2]).toMatchObject({ status: 'overdue', reason: 'time_cap' });
  });

  it('does not emit a black-only point where a colour machine lacks the colour reading', async () => {
    await machine(1);
    await reading(1, '2026-01-05', 1000, 1);
    await reading(1, '2026-01-05', 500, 2);
    await reading(1, '2026-02-05', 2000, 1); // colour missing at this time
    await reading(1, '2026-03-05', 3000, 1);
    await reading(1, '2026-03-05', 600, 2);
    const values = (await loadCombinedMeters(t.db, [1], NOW)).get(1)!.map((p) => p.value);
    expect(values).toEqual([1500, 2500, 3600]);
    // A colour reading missing before any colour was ever seen is skipped, not emitted as black only.
    await machine(2);
    await reading(2, '2026-01-05', 1000, 1);
    await reading(2, '2026-02-05', 1200, 1);
    await reading(2, '2026-02-05', 300, 2);
    expect((await loadCombinedMeters(t.db, [2], NOW)).get(2)!.map((p) => p.value)).toEqual([1500]);
  });

  it('default view keeps held machines past the page interval or the time cap, drops other held ones', async () => {
    for (const id of [5, 6, 7]) {
      await machine(id);
      await contract(id);
      // three short Field callouts in the last month: frequent, so held (too short to count as a PM)
      for (const day of ['2026-11-01', '2026-11-05', '2026-11-10']) await visit(id, day, { hours: 0.1 });
    }
    // 5: last qualifying visit in January, 119k pages since
    await visit(5, '2026-01-10');
    await reading(5, '2026-01-05', 1000);
    await reading(5, '2026-11-10', 120_000);
    // 6: last qualifying visit older than the 12 month cap, little paper since
    await visit(6, '2025-06-01');
    await reading(6, '2025-05-20', 1000);
    await reading(6, '2026-11-10', 5000);
    // 7: recent qualifying visit, few pages
    await visit(7, '2026-10-01');
    await reading(7, '2026-09-20', 1000);
    await reading(7, '2026-11-10', 5000);
    const all = await listPmDue(t.db, NOW);
    expect(all.every((r) => r.result.status === 'held')).toBe(true);
    expect((await listPmDue(t.db, NOW, { status: 'default' })).map((r) => r.vantageEquipmentId).sort()).toEqual([5, 6]);
  });

  it('family filter keeps only that family', async () => {
    const [famA] = await t.db.insert(cartridgeFamilies).values({ name: 'A', isColour: true }).returning();
    const [famB] = await t.db.insert(cartridgeFamilies).values({ name: 'B', isColour: false }).returning();
    await t.db.insert(cartridgeFamilyModels).values([
      { model: 'modelA', familyId: famA!.id },
      { model: 'modelB', familyId: famB!.id },
    ]);
    for (const [id, model] of [[1, 'modelA'], [2, 'modelB'], [3, 'modelA']] as const) {
      await machine(id);
      await contract(id);
      await t.db.insert(drmsEquipment).values({ drmsId: `dr${id}`, modelName: model, raw: {} });
      await t.db.insert(deviceLinks).values({ drmsEquipmentId: `dr${id}`, vantageEquipmentId: id, method: 'serial' });
    }
    expect((await listPmDue(t.db, NOW, { family: famA!.id })).map((r) => r.vantageEquipmentId).sort()).toEqual([1, 3]);
    expect((await listPmDue(t.db, NOW, { family: famB!.id })).map((r) => r.vantageEquipmentId)).toEqual([2]);
  });

  it('sorts overdue first, then by pct used', async () => {
    for (const id of [1, 2, 3]) {
      await machine(id);
      await contract(id);
    }
    for (const [id, last] of [[1, 60_000], [2, 70_000]] as const) {
      await reading(id, '2026-01-05', 1000);
      await reading(id, '2026-11-10', last);
      await visit(id, '2026-01-10');
    }
    // 3 has no visit: overdue, no pct
    expect((await listPmDue(t.db, NOW)).map((r) => r.vantageEquipmentId)).toEqual([3, 2, 1]);
  });

  describe('plan flags', () => {
    let userId: number;
    beforeEach(async () => {
      const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
      userId = u!.id;
    });

    it('rows carry their pm_plan flags and board column; machines with no row get the empty plan', async () => {
      for (const id of [1, 2, 3]) {
        await machine(id);
        await contract(id);
      }
      await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
      await setWhenInArea(t.db, { vantageEquipmentId: 2, on: true, userId, now: NOW });
      const by = Object.fromEntries((await listPmDue(t.db, NOW)).map((r) => [r.vantageEquipmentId, r.plan]));
      expect(by[1]).toEqual({ whenInArea: false, priority: true, boardColumn: 'to_plan' });
      expect(by[2]).toEqual({ whenInArea: true, priority: false, boardColumn: null });
      expect(by[3]).toEqual({ whenInArea: false, priority: false, boardColumn: null });
      await addToPlan(t.db, { vantageEquipmentIds: [3], userId, now: NOW });
      expect((await getEquipmentPm(t.db, 3, NOW))!.plan).toEqual({ whenInArea: false, priority: false, boardColumn: 'to_plan' });
    });

    it('the default order puts a priority machine first; an explicit sort ignores priority', async () => {
      for (const id of [1, 2, 3]) {
        await machine(id, `Cust ${id}`);
        await contract(id);
      }
      for (const [id, last] of [[1, 60_000], [2, 70_000]] as const) {
        await reading(id, '2026-01-05', 1000);
        await reading(id, '2026-11-10', last);
        await visit(id, '2026-01-10');
      }
      // 3 is overdue (no visit); 1 is the least used of the three.
      expect((await listPmDue(t.db, NOW)).map((r) => r.vantageEquipmentId)).toEqual([3, 2, 1]);
      await setPriority(t.db, { vantageEquipmentId: 1, on: true, userId, now: NOW });
      expect((await listPmDue(t.db, NOW)).map((r) => r.vantageEquipmentId)).toEqual([1, 3, 2]);
      expect((await listPmDue(t.db, NOW, { sort: { key: 'customer', dir: 'asc' } })).map((r) => r.vantageEquipmentId)).toEqual([1, 2, 3]);
      expect((await listPmDue(t.db, NOW, { sort: { key: 'customer', dir: 'desc' } })).map((r) => r.vantageEquipmentId)).toEqual([3, 2, 1]);
    });
  });

  it('listPmForEquipment returns the same PmRow as getEquipmentPm for each id and omits ids with no active contract', async () => {
    await machine(1);
    await contract(1);
    await machine(2);
    await contract(2);
    await machine(3); // no contract
    await reading(2, '2026-11-10', 5000);
    const map = await listPmForEquipment(t.db, [1, 2, 3, 99], NOW);
    expect([...map.keys()].sort()).toEqual([1, 2]);
    expect(map.get(1)).toEqual(await getEquipmentPm(t.db, 1, NOW));
    expect(map.get(2)).toEqual(await getEquipmentPm(t.db, 2, NOW));
    expect((await listPmForEquipment(t.db, [], NOW)).size).toBe(0);
  });

  it('listWorkCategories counts visits per category', async () => {
    await machine(1);
    await visit(1, '2026-01-10', { categoryId: 1 });
    await visit(1, '2026-02-10', { categoryId: 1 });
    await visit(1, '2026-03-10', { categoryId: 7, type: 'Office' });
    expect(await listWorkCategories(t.db)).toEqual([
      { id: 1, name: 'Break/fix', type: 'Field', visits: 2 },
      { id: 7, name: 'Office', type: 'Office', visits: 1 },
    ]);
  });

  describe('pm actions', () => {
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const plusDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
    const ids = (rows: { vantageEquipmentId: number }[]) => rows.map((r) => r.vantageEquipmentId);

    it('booked machine in booked view, out of due', async () => {
      await machine(1);
      await contract(1);
      await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: day('2026-12-01'), reference: 'W1', userId: null, now: NOW });
      expect(ids(await listPmDue(t.db, NOW, { view: 'booked' }))).toEqual([1]);
      expect(ids(await listPmDue(t.db, NOW, { view: 'due' }))).toEqual([]);
      expect(ids(await listPmDue(t.db, NOW, { status: 'default' }))).toEqual([]);
      const row = await getEquipmentPm(t.db, 1, NOW);
      expect(row).toMatchObject({ view: 'booked', bookedOverdue: false });
      expect(row!.action).toMatchObject({ kind: 'booked', reference: 'W1' });
    });

    it('booked + later counted visit clears the action as visit_seen and the row is back in due/ok', async () => {
      await machine(1);
      await contract(1);
      await reading(1, '2026-01-05', 1000);
      await reading(1, '2026-11-30', 20_000);
      await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: day('2026-11-25'), reference: null, userId: null, now: NOW });
      await visit(1, '2026-11-25');
      const later = d('2026-12-01');
      const row = (await listPmDue(t.db, later))[0]!;
      expect(row.action).toBeNull();
      expect(row.view).toBe('due');
      expect(row.result.status).toBe('ok');
      const [a] = await t.db.select().from(pmActions);
      expect(a!.clearedReason).toBe('visit_seen');
      expect(a!.clearedAt).not.toBeNull();
    });

    it('booked with no date 45 days old is due with bookedOverdue', async () => {
      await machine(1);
      await contract(1);
      await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: null, reference: null, userId: null, now: plusDays(-45) });
      const [row] = await listPmDue(t.db, NOW, { view: 'due' });
      expect(row).toMatchObject({ vantageEquipmentId: 1, view: 'due', bookedOverdue: true });
    });

    it('snoozed 90 is in the dismissed view; after 91 days it is back in due and the action expired', async () => {
      await machine(1);
      await contract(1);
      await dismissPm(t.db, { vantageEquipmentId: 1, reason: 'not_now', note: null, snoozeDays: 90, servicedOn: null, userId: null, now: NOW });
      expect(ids(await listPmDue(t.db, NOW, { view: 'dismissed' }))).toEqual([1]);
      expect(ids(await listPmDue(t.db, NOW, { view: 'due' }))).toEqual([]);
      expect(ids(await listPmDue(t.db, plusDays(91), { view: 'due' }))).toEqual([1]);
      const [a] = await t.db.select().from(pmActions);
      expect(a!.clearedReason).toBe('expired');
    });

    it('serviced_outside resets the clock: ok, in the dismissed view', async () => {
      await machine(1);
      await contract(1);
      await reading(1, '2026-01-05', 1000);
      await reading(1, '2026-11-01', 90_000);
      await reading(1, '2026-11-17', 91_000);
      await visit(1, '2025-09-01');
      expect((await getEquipmentPm(t.db, 1, NOW))!.result.status).toBe('overdue');
      await dismissPm(t.db, { vantageEquipmentId: 1, reason: 'serviced_outside', note: null, servicedOn: day('2026-11-05'), userId: null, now: NOW });
      const row = (await getEquipmentPm(t.db, 1, NOW))!;
      // Readings are 09:00Z, the reset is 5 Nov 00:00Z: 3.625 of 16 days between 90,000 and 91,000
      // -> 90,000 + 1,000*3.625/16 = 90,227; 91,000 - 90,227 = 773.
      expect(row.result).toMatchObject({ status: 'ok', clockSource: 'manual', pagesSince: 773 });
      expect(row.view).toBe('dismissed');
      expect(ids(await listPmDue(t.db, NOW, { view: 'dismissed' }))).toEqual([1]);
    });

    it('a reset survives booking, and only Undo of the reset removes it', async () => {
      await machine(1);
      await contract(1);
      await reading(1, '2026-01-05', 1000);
      await reading(1, '2026-11-17', 91_000);
      await visit(1, '2025-09-01');
      await dismissPm(t.db, { vantageEquipmentId: 1, reason: 'serviced_outside', note: null, servicedOn: day('2026-11-05'), userId: null, now: NOW });
      await markPmBooked(t.db, { vantageEquipmentId: 1, bookedFor: day('2026-12-01'), reference: null, userId: null, now: NOW });
      let row = (await getEquipmentPm(t.db, 1, NOW))!;
      expect(row.action).toMatchObject({ kind: 'booked' });
      expect(row.result.clockSource).toBe('manual');
      const [booked] = await t.db.select().from(pmActions).where(eq(pmActions.kind, 'booked'));
      await undoPmAction(t.db, booked!.id, null, NOW);
      row = (await getEquipmentPm(t.db, 1, NOW))!;
      expect(row.result.clockSource).toBe('manual');
    });

    it('reset then Undo puts the clock back on the last visit', async () => {
      await machine(1);
      await contract(1);
      await reading(1, '2026-01-05', 1000);
      await reading(1, '2026-11-17', 91_000);
      await visit(1, '2025-09-01');
      await dismissPm(t.db, { vantageEquipmentId: 1, reason: 'serviced_outside', note: null, servicedOn: day('2026-11-05'), userId: null, now: NOW });
      const [a] = await t.db.select().from(pmActions);
      await undoPmAction(t.db, a!.id, null, NOW);
      const row = (await getEquipmentPm(t.db, 1, NOW))!;
      expect(row.result.clockSource).toBe('visit');
      expect(row.action).toBeNull();
    });

    it('an open reset clears as visit_seen once a later counted visit lands', async () => {
      await machine(1);
      await contract(1);
      await reading(1, '2026-01-05', 1000);
      await reading(1, '2026-11-17', 91_000);
      await dismissPm(t.db, { vantageEquipmentId: 1, reason: 'serviced_outside', note: null, servicedOn: day('2026-11-05'), userId: null, now: NOW });
      await visit(1, '2026-11-10');
      const row = (await listPmDue(t.db, NOW))[0]!;
      expect(row.action).toBeNull();
      expect(row.result.clockSource).toBe('visit');
      const [a] = await t.db.select().from(pmActions);
      expect(a!.clearedReason).toBe('visit_seen');
    });
  });
});
