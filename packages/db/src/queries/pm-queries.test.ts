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
import { dismissPm, markPmBooked, undoPmAction } from './pm-actions';
import { pmActions } from '../schema';
import { getEquipmentPm, getPmSettings, inPmView, listPmDue, listWorkCategories, savePmSettings, setFamilyPmInterval, type PmRow } from './pm-queries';

const d = (iso: string) => new Date(`${iso}T09:00:00Z`);
const NOW = d('2026-11-18');

describe('inPmView', () => {
  const row = (status: PmStatus, over: Partial<PmRow> = {}): PmRow => ({
    vantageEquipmentId: 1,
    drmsEquipmentId: null,
    customerName: 'Acme',
    town: null,
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

  const machine = (id: number, customer = `Cust ${id}`) => t.db.insert(vantageEquipment).values({ vantageId: id, customerName: customer, serial: `SER${id}`, raw: {} });
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
    await t.db.insert(vantageEquipment).values({ vantageId: 1, customerName: 'New', serial: 'S1', installDate: d('2026-08-18'), raw: {} });
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
      { vantageId: 1, customerName: 'Acme', vantageCustomerId: 7, serial: 'S1', raw: {} },
      { vantageId: 2, customerName: 'Beta', vantageCustomerId: 8, serial: 'S2', raw: {} },
      { vantageId: 3, customerName: 'Gamma', serial: 'S3', raw: {} },
    ]);
    await contract(1);
    await contract(2);
    await contract(3);
    const rows = await listPmDue(t.db, NOW, { view: 'all' });
    expect(rows.map((r) => [r.vantageEquipmentId, r.town])).toEqual([[1, 'Leeds'], [2, null], [3, null]]);
    expect((await listPmDue(t.db, NOW, { view: 'all', q: 'leeds' })).map((r) => r.vantageEquipmentId)).toEqual([1]);
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
      expect(row.result).toMatchObject({ status: 'ok', clockSource: 'manual', pagesSince: 1000 });
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
