import { SITE_STOCK_CSV_HEADERS } from '@mps/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartridgeFamilies,
  cartridgeFamilyModels,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  replenishmentSettings,
  siteStockEvents,
  siteStockShelves,
  vantageCustomers,
  vantageEquipment,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import {
  getShelf,
  listFamilies,
  listShelfForDevice,
  listShelves,
  listSiteStockExportRows,
  listUnmappedModels,
} from './site-stock';

const NOW = new Date('2026-09-21T12:00:00Z');

describe('site stock reads', () => {
  let t: TestDb;
  let famC: number;
  let famM: number;
  let shelfId: number;

  beforeEach(async () => {
    t = await createTestDb();
    const { db } = t;
    await db.insert(vantageCustomers).values([
      { vantageId: 1, name: 'Site One', reference: 'S1', raw: { PostCode: 'AB1 2CD', HeadOfficeId: 2 } },
      { vantageId: 2, name: 'Head Office Ltd', reference: 'HO', raw: { PostCode: 'ZZ9 9ZZ' } },
    ]);
    const fams = await db
      .insert(cartridgeFamilies)
      .values([
        { name: 'C-series', isColour: true, ratedYieldBlack: 20000 },
        { name: 'Mono', isColour: false },
      ])
      .returning();
    famC = fams[0]!.id;
    famM = fams[1]!.id;
    await db.insert(cartridgeFamilyModels).values([
      { model: 'bizhub C300i', familyId: famC },
      { model: 'bizhub C360i', familyId: famC },
      { model: 'bizhub 301i', familyId: famM },
    ]);
    await db.insert(drmsEquipment).values([
      { drmsId: 'd1', modelName: 'bizhub C300i', serial: 'S1', status: 'Registered', isColour: true, customerName: 'Site One', raw: { Name: 'Site One Upstairs' } },
      { drmsId: 'd2', modelName: 'bizhub C360i', serial: 'S2', status: 'Registered', isColour: true, raw: {} },
      { drmsId: 'd3', modelName: 'bizhub 301i', serial: 'S3', status: 'Registered', raw: {} },
      { drmsId: 'd4', modelName: 'bizhub C300i', serial: 'S4', status: 'Registered', isColour: true, raw: {} },
      { drmsId: 'd5', modelName: 'bizhub Mystery', serial: 'S5', status: 'Registered', raw: {} },
      { drmsId: 'd6', modelName: 'bizhub C300i', serial: 'S6', status: 'Registered', isColour: true, missingSince: NOW, raw: {} },
    ]);
    await db.insert(vantageEquipment).values([
      { vantageId: 10, vantageCustomerId: 1, raw: {} },
      { vantageId: 11, vantageCustomerId: 1, raw: {} },
      { vantageId: 12, vantageCustomerId: 1, raw: {} },
      { vantageId: 13, vantageCustomerId: 1, raw: {} },
      { vantageId: 14, vantageCustomerId: 1, raw: {} },
      { vantageId: 15, vantageCustomerId: 1, raw: {} },
    ]);
    await db.insert(deviceLinks).values([
      { drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial' },
      { drmsEquipmentId: 'd2', vantageEquipmentId: 11, method: 'serial' },
      { drmsEquipmentId: 'd3', vantageEquipmentId: 12, method: 'serial' },
      // d4 was linked then unlinked: not a member.
      { drmsEquipmentId: 'd4', vantageEquipmentId: 13, method: 'serial', unlinkedAt: NOW },
      { drmsEquipmentId: 'd5', vantageEquipmentId: 14, method: 'serial' },
      { drmsEquipmentId: 'd6', vantageEquipmentId: 15, method: 'serial' },
    ]);
    const [s] = await db
      .insert(siteStockShelves)
      .values({ vantageCustomerId: 1, familyId: famC, holdingBlack: 3, holdingWaste: 1, usedBlack: 2, countingFrom: NOW })
      .returning();
    shelfId = s!.id;
  });
  afterEach(() => t.close());

  it('a shelf has the linked monitored devices of its customer and family, nothing else', async () => {
    const shelves = await listShelves(t.db, {});
    expect(shelves).toHaveLength(1);
    const s = shelves[0]!;
    expect(s.machines).toBe(2); // d1, d2: not d4 (unlinked), d6 (missing), d3 (other family)
    expect(s).toMatchObject({
      siteName: 'Site One',
      customerReference: 'S1',
      postcode: 'AB1 2CD',
      headOfficeName: 'Head Office Ltd',
      familyName: 'C-series',
      isColour: true,
      liveTopUp: false,
      autoOffDevices: 0,
    });
    expect(s.holding).toEqual({ black: 3, cyan: 0, magenta: 0, yellow: 0, waste: 1 });
    expect(s.used.black).toBe(2);
  });

  it('a second family at the same customer is a separate shelf', async () => {
    await t.db.insert(siteStockShelves).values({ vantageCustomerId: 1, familyId: famM, countingFrom: NOW });
    const shelves = await listShelves(t.db, {});
    expect(shelves.map((s) => [s.familyName, s.machines]).sort()).toEqual([['C-series', 2], ['Mono', 1]]);
  });

  it('counts auto-off devices, flags a live top-up and sorts it first', async () => {
    await t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'd2', autoReplenish: false });
    const [mono] = await t.db.insert(siteStockShelves).values({ vantageCustomerId: 1, familyId: famM, countingFrom: NOW }).returning();
    await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'd3',
      vantageEquipmentId: 12,
      colour: 'black',
      trigger: 'site_stock',
      status: 'pending',
      shelfId: mono!.id,
    });
    const shelves = await listShelves(t.db, {});
    expect(shelves.map((s) => [s.familyName, s.liveTopUp])).toEqual([['Mono', true], ['C-series', false]]);
    expect(shelves.find((s) => s.familyName === 'C-series')!.autoOffDevices).toBe(1);
  });

  it('searches site, reference, postcode and family', async () => {
    expect(await listShelves(t.db, { search: 'site one' })).toHaveLength(1);
    expect(await listShelves(t.db, { search: 'ab1' })).toHaveLength(1);
    expect(await listShelves(t.db, { search: 'c-ser' })).toHaveLength(1);
    expect(await listShelves(t.db, { search: 'nope' })).toHaveLength(0);
  });

  it('getShelf returns devices and newest-first events; null for a missing shelf', async () => {
    await t.db.insert(siteStockEvents).values([
      { shelfId, alarmId: 'a1', drmsEquipmentId: 'd1', colour: 'black', receivedAt: new Date('2026-09-01T00:00:00Z'), counted: true, reason: 'counted' },
      { shelfId, alarmId: 'a2', drmsEquipmentId: 'd2', colour: 'black', receivedAt: new Date('2026-09-02T00:00:00Z'), counted: false, reason: 'repeat' },
    ]);
    const g = await getShelf(t.db, shelfId);
    expect(g!.devices.map((d) => d.drmsId)).toEqual(['d1', 'd2']);
    expect(g!.devices[0]!.displayName).toBe('Site One Upstairs');
    expect(g!.events.map((e) => e.reason)).toEqual(['repeat', 'counted']);
    expect(await getShelf(t.db, 9999)).toBeNull();
  });

  it('finds the shelf a device is on', async () => {
    expect(await listShelfForDevice(t.db, 'd1')).toEqual({ shelfId, siteName: 'Site One', familyName: 'C-series' });
    expect(await listShelfForDevice(t.db, 'd4')).toBeNull();
    expect(await listShelfForDevice(t.db, 'd5')).toBeNull();
  });

  it('lists families with models, rated yield and shelf counts', async () => {
    const fams = await listFamilies(t.db);
    const c = fams.find((f) => f.name === 'C-series')!;
    expect(c.models).toEqual(['bizhub C300i', 'bizhub C360i']);
    expect(c.ratedYield).toEqual({ black: 20000 });
    expect(c.shelves).toBe(1);
    expect(fams.find((f) => f.name === 'Mono')!.shelves).toBe(0);
  });

  it('lists monitored linked models that have no family', async () => {
    expect(await listUnmappedModels(t.db)).toEqual([{ model: 'bizhub Mystery', devices: 1 }]);
    await t.db.update(drmsEquipment).set({ missingSince: NOW }).where(eq(drmsEquipment.drmsId, 'd5'));
    expect(await listUnmappedModels(t.db)).toEqual([]);
  });

  it('exports every (site, family) in the fleet, zeros where there is no shelf', async () => {
    const rows = await listSiteStockExportRows(t.db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(SITE_STOCK_CSV_HEADERS.length);
    const col = (name: (typeof SITE_STOCK_CSV_HEADERS)[number]) => SITE_STOCK_CSV_HEADERS.indexOf(name);
    const c = rows.find((r) => r[col('family')] === 'C-series')!;
    expect(c.slice(0, 6)).toEqual([1, 'Site One', 'S1', 'AB1 2CD', 'C-series', 2]);
    expect(c.slice(6)).toEqual([3, 0, 0, 0, 1, 2, 0, 0, 0, 0]);
    const m = rows.find((r) => r[col('family')] === 'Mono')!;
    expect(m.slice(5)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
