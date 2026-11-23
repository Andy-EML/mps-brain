import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartridgeFamilies,
  customerFlags,
  deviceLinks,
  drmsEquipment,
  hiddenDevices,
  replenishmentProposals,
  siteStockShelves,
  vantageCustomers,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { getCustomer, listCustomerDevices, listCustomerOrders, listCustomerShelves, listCustomers, searchVantageCustomers } from './customers';

describe('searchVantageCustomers', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageCustomers).values([
      { vantageId: 1, name: 'Acme Printing', reference: 'ACM001', raw: {} },
      { vantageId: 2, name: 'Beta School', reference: 'BET001', raw: {} },
      // Matches "acme" but has no linked DRMS device.
      { vantageId: 3, name: 'Acme Holdings', reference: 'ACM002', raw: {} },
      // Linked, but its only link has been closed.
      { vantageId: 4, name: 'Acme Old', reference: 'ACM003', raw: {} },
      // Deleted in Vantage.
      { vantageId: 5, name: 'Acme Gone', reference: 'ACM004', deletedDate: new Date('2026-01-01T00:00:00Z'), raw: {} },
    ]);
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'd1', raw: {} },
      { drmsId: 'd2', raw: {} },
      { drmsId: 'd3', raw: {} },
      { drmsId: 'd4', raw: {} },
      { drmsId: 'd5', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 101, vantageCustomerId: 1, raw: {} },
      { vantageId: 102, vantageCustomerId: 1, raw: {} },
      { vantageId: 103, vantageCustomerId: 1, raw: {} }, // not linked: not counted
      { vantageId: 201, vantageCustomerId: 2, raw: {} },
      { vantageId: 301, vantageCustomerId: 3, raw: {} },
      { vantageId: 401, vantageCustomerId: 4, raw: {} },
      { vantageId: 501, vantageCustomerId: 5, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'd1', vantageEquipmentId: 101, method: 'serial' },
      { drmsEquipmentId: 'd2', vantageEquipmentId: 102, method: 'serial' },
      { drmsEquipmentId: 'd3', vantageEquipmentId: 201, method: 'serial' },
      { drmsEquipmentId: 'd4', vantageEquipmentId: 401, method: 'serial', unlinkedAt: new Date('2026-09-01T00:00:00Z') },
      { drmsEquipmentId: 'd5', vantageEquipmentId: 501, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  it('matches the name case-insensitively, only customers with a linked device, with device counts', async () => {
    expect(await searchVantageCustomers(t.db, 'aCmE')).toEqual([
      { vantageId: 1, name: 'Acme Printing', reference: 'ACM001', deviceCount: 2 },
    ]);
  });

  it('matches the reference case-insensitively', async () => {
    expect(await searchVantageCustomers(t.db, 'bet0')).toEqual([
      { vantageId: 2, name: 'Beta School', reference: 'BET001', deviceCount: 1 },
    ]);
  });

  it('orders by name and honours the limit', async () => {
    const all = await searchVantageCustomers(t.db, 'e');
    expect(all.map((r) => r.name)).toEqual(['Acme Printing', 'Beta School']);
    expect(await searchVantageCustomers(t.db, 'e', 1)).toHaveLength(1);
  });

  it('treats % and _ in the query as plain text', async () => {
    expect(await searchVantageCustomers(t.db, '%')).toEqual([]);
    expect(await searchVantageCustomers(t.db, 'ACM_01')).toEqual([]);
  });
});

describe('customer read queries', () => {
  let t: TestDb;
  const NOW = new Date();
  const monthsAgo = (m: number) => new Date(NOW.getFullYear(), NOW.getMonth() - m, 15);
  beforeEach(async () => {
    t = await createTestDb();
    const c = (vantageId: number, name: string, reference: string, raw: Record<string, unknown> = {}, extra: object = {}) => ({
      vantageId,
      name,
      reference,
      raw,
      ...extra,
    });
    await t.db.insert(vantageCustomers).values([
      c(1, 'Hewetts Group', 'HEW00', { Town: ' Ashford ' }),
      c(2, 'Hewetts Ashford', 'HEW01', { HeadOfficeId: 1, Town: 'Ashford' }),
      c(3, 'Hewetts Dover', 'HEW02', { HeadOfficeId: 1, Town: 'Dover' }),
      c(4, 'Acme Printing', 'ACM01', { Town: 'Howden', PostCode: 'DN14 7AA' }, { isOnStop: true }),
      c(5, 'Hidden Only Ltd', 'HID01', { Town: 'Leeds' }),
      c(6, 'Nobody Ltd', 'NOB01', { Town: 'Hull' }),
      c(7, 'Gone Site', 'GON01', { HeadOfficeId: 1 }, { deletedDate: new Date('2026-01-01T00:00:00Z') }),
      c(8, '100% Fun_Co', 'FUN01', {}),
    ]);
    await t.db.insert(customerFlags).values({ vantageCustomerId: 1, selfManaged: true, selfManagedNote: 'they hold stock' });
    await t.db.insert(drmsEquipment).values(['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((drmsId) => ({ drmsId, raw: {} })));
    await t.db.insert(vantageEquipment).values(
      [
        [11, 2],
        [12, 2],
        [13, 3],
        [14, 4],
        [15, 4],
        [16, 5],
      ].map(([vantageId, vantageCustomerId]) => ({ vantageId: vantageId!, vantageCustomerId: vantageCustomerId!, raw: {} })),
    );
    await t.db.insert(deviceLinks).values(
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((d, i) => ({ drmsEquipmentId: d, vantageEquipmentId: 11 + i, method: 'serial' as const })),
    );
    await t.db.insert(hiddenDevices).values([{ drmsEquipmentId: 'd5' }, { drmsEquipmentId: 'd6' }]);
    await t.db.insert(replenishmentProposals).values([
      { drmsEquipmentId: 'd1', colour: 'black', trigger: 'threshold', status: 'pending' },
      { drmsEquipmentId: 'd3', colour: 'black', trigger: 'threshold', status: 'pending' },
      { drmsEquipmentId: 'd3', colour: 'cyan', trigger: 'threshold', status: 'approved' },
      { drmsEquipmentId: 'd4', colour: 'black', trigger: 'threshold', status: 'pending' },
      { drmsEquipmentId: 'd5', colour: 'black', trigger: 'threshold', status: 'pending' },
    ]);
    const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'F', isColour: false }).returning();
    await t.db.insert(siteStockShelves).values([
      { vantageCustomerId: 4, familyId: fam!.id, countingFrom: NOW },
      { vantageCustomerId: 3, familyId: fam!.id, countingFrom: NOW },
    ]);
  });
  afterEach(() => t.close());

  it('tab counts: a customer with only a hidden device is not "with machines"', async () => {
    const { counts } = await listCustomers(t.db, {});
    expect(counts).toEqual({ 'with-machines': 4, 'self-managed': 3, 'head-offices': 1, all: 7 });
  });

  it('with-machines lists customers with a visible device, head office included via its sites, A-Z', async () => {
    const { rows, total } = await listCustomers(t.db, { tab: 'with-machines' });
    expect(total).toBe(4);
    expect(rows.map((r) => r.name)).toEqual(['Acme Printing', 'Hewetts Ashford', 'Hewetts Dover', 'Hewetts Group']);
  });

  it('sorts the filtered list and pages it, with the total and tab counts unchanged by sort', async () => {
    const asc = await listCustomers(t.db, { tab: 'with-machines', sort: { key: 'name', dir: 'asc' } });
    const desc = await listCustomers(t.db, { tab: 'with-machines', sort: { key: 'name', dir: 'desc' } });
    expect(desc.rows.map((r) => r.name)).toEqual(asc.rows.map((r) => r.name).reverse());
    expect(desc.counts).toEqual(asc.counts);
    const page = await listCustomers(t.db, { tab: 'with-machines', sort: { key: 'name', dir: 'desc' }, limit: 2, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r.name)).toEqual(desc.rows.slice(1, 3).map((r) => r.name));
    // machines desc: ties (equal machine counts) fall to the customer id, so a page edge is stable.
    const m = await listCustomers(t.db, { tab: 'with-machines', sort: { key: 'machines', dir: 'desc' } });
    const counts = m.rows.map((r) => r.machines);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    for (let i = 1; i < m.rows.length; i++) {
      if (m.rows[i]!.machines === m.rows[i - 1]!.machines) expect(m.rows[i]!.vantageId).toBeGreaterThan(m.rows[i - 1]!.vantageId);
    }
  });

  it('self-managed lists the head office and its sites with their source', async () => {
    const { rows } = await listCustomers(t.db, { tab: 'self-managed' });
    expect(rows.map((r) => [r.vantageId, r.selfManaged])).toEqual([
      [2, 'head_office'],
      [3, 'head_office'],
      [1, 'site'],
    ]);
  });

  it('a head-office row counts its sites (not deleted ones) and includes their machines, pending and shelves', async () => {
    const { rows } = await listCustomers(t.db, { tab: 'head-offices' });
    expect(rows).toEqual([
      {
        vantageId: 1,
        name: 'Hewetts Group',
        reference: 'HEW00',
        town: 'Ashford',
        machines: 3,
        pending: 2,
        shelves: 1,
        sites: 2,
        selfManaged: 'site',
        deleted: false,
      },
    ]);
  });

  it('a site row counts its own visible machines, pending, shelves; hidden devices excluded', async () => {
    const { rows } = await listCustomers(t.db, { tab: 'all', search: 'acme' });
    expect(rows).toEqual([
      { vantageId: 4, name: 'Acme Printing', reference: 'ACM01', town: 'Howden', machines: 1, pending: 1, shelves: 1, sites: 0, selfManaged: null, deleted: false },
    ]);
  });

  it('searches name, reference and town, escaping % and _', async () => {
    const byTown = await listCustomers(t.db, { tab: 'all', search: 'dover' });
    expect(byTown.rows.map((r) => r.vantageId)).toEqual([3]);
    const byRef = await listCustomers(t.db, { tab: 'all', search: 'nob0' });
    expect(byRef.rows.map((r) => r.vantageId)).toEqual([6]);
    expect((await listCustomers(t.db, { tab: 'all', search: '%' })).rows.map((r) => r.vantageId)).toEqual([8]);
    expect((await listCustomers(t.db, { tab: 'all', search: 'F_n' })).rows).toEqual([]);
  });

  it('paginates with a stable total', async () => {
    const p = await listCustomers(t.db, { tab: 'all', limit: 2, offset: 2 });
    expect(p.total).toBe(7);
    expect(p.rows).toHaveLength(2);
  });

  it('getCustomer of a site returns its head office and inherited self-managed state', async () => {
    const d = await getCustomer(t.db, 2);
    expect(d).toMatchObject({
      vantageId: 2,
      town: 'Ashford',
      headOffice: { vantageId: 1, name: 'Hewetts Group' },
      selfManaged: { selfManaged: true, source: 'head_office', note: 'they hold stock' },
      sites: [],
    });
  });

  it('getCustomer of a head office returns its sites as rows', async () => {
    const d = await getCustomer(t.db, 1);
    expect(d?.headOffice).toBeNull();
    expect(d?.sites.map((s) => [s.vantageId, s.machines, s.pending, s.shelves])).toEqual([
      [2, 2, 1, 0],
      [3, 1, 1, 1],
    ]);
  });

  it('a deleted customer with its flag on is listed on the Self-managed tab only, marked deleted', async () => {
    await t.db.insert(vantageCustomers).values({ vantageId: 9, name: 'Zed Gone HQ', reference: 'ZED00', raw: {}, deletedDate: new Date('2026-06-01T00:00:00Z') });
    await t.db.insert(customerFlags).values({ vantageCustomerId: 9, selfManaged: true });
    const sm = await listCustomers(t.db, { tab: 'self-managed' });
    expect(sm.counts).toEqual({ 'with-machines': 4, 'self-managed': 4, 'head-offices': 1, all: 7 });
    expect(sm.rows.map((r) => [r.vantageId, r.selfManaged, r.deleted])).toEqual([
      [2, 'head_office', false],
      [3, 'head_office', false],
      [1, 'site', false],
      [9, 'site', true],
    ]);
    expect((await listCustomers(t.db, { tab: 'all' })).rows.map((r) => r.vantageId)).not.toContain(9);
    // A deleted customer whose flag row says off is not on any tab.
    await t.db.insert(customerFlags).values({ vantageCustomerId: 7, selfManaged: false });
    expect((await listCustomers(t.db, { tab: 'self-managed' })).total).toBe(4);
  });

  it('getCustomer returns a deleted customer that has a flag row (any value), marked deleted', async () => {
    await t.db.insert(customerFlags).values({ vantageCustomerId: 7, selfManaged: false });
    expect(await getCustomer(t.db, 7)).toMatchObject({ vantageId: 7, name: 'Gone Site', deleted: true });
    expect(await getCustomer(t.db, 4)).toMatchObject({ deleted: false });
  });

  it('getCustomer returns details and null for a missing or deleted customer', async () => {
    expect(await getCustomer(t.db, 4)).toMatchObject({ name: 'Acme Printing', postCode: 'DN14 7AA', isOnStop: true });
    expect(await getCustomer(t.db, 7)).toBeNull();
    expect(await getCustomer(t.db, 999)).toBeNull();
  });

  it('listCustomerDevices splits visible and hidden', async () => {
    const r = await listCustomerDevices(t.db, [4]);
    expect(r.visible.map((d) => d.drmsId)).toEqual(['d4']);
    expect(r.hidden.map((d) => d.drmsId)).toEqual(['d5']);
    const both = await listCustomerDevices(t.db, [2, 3, 4]);
    expect(both.visible.map((d) => d.drmsId).sort()).toEqual(['d1', 'd2', 'd3', 'd4']);
    expect(await listCustomerDevices(t.db, [])).toEqual({ visible: [], hidden: [] });
  });

  it('listCustomerOrders: last window only, header or line link, newest first, with device name', async () => {
    await t.db.insert(vantageSalesOrders).values([
      { vantageId: 1, reference: 'SO1', orderDate: monthsAgo(1), vantageEquipmentId: 14, raw: {} },
      { vantageId: 2, reference: 'SO2', orderDate: monthsAgo(13), vantageEquipmentId: 14, raw: {} },
      { vantageId: 3, reference: 'SO3', orderDate: monthsAgo(0), vantageEquipmentId: null, raw: {} },
      { vantageId: 4, reference: 'SO4', orderDate: monthsAgo(2), vantageEquipmentId: 11, raw: {} },
      { vantageId: 5, reference: 'SO5', orderDate: monthsAgo(1), vantageEquipmentId: 14, deletedDate: NOW, raw: {} },
    ]);
    await t.db.insert(vantageSalesOrderLines).values([
      { vantageId: 1, salesOrderId: 1, vantageEquipmentId: 14, itemPartNumber: 'TN', colour: 'black', raw: {} },
      { vantageId: 2, salesOrderId: 2, vantageEquipmentId: 14, itemPartNumber: 'TN', colour: 'black', raw: {} },
      { vantageId: 3, salesOrderId: 3, vantageEquipmentId: 15, itemPartNumber: 'TN', colour: 'cyan', raw: {} },
      { vantageId: 4, salesOrderId: 4, vantageEquipmentId: 11, itemPartNumber: 'TN', colour: 'black', raw: {} },
      { vantageId: 5, salesOrderId: 5, vantageEquipmentId: 14, itemPartNumber: 'TN', colour: 'black', raw: {} },
    ]);
    const since = new Date(NOW.getFullYear(), NOW.getMonth() - 12, NOW.getDate());
    const orders = await listCustomerOrders(t.db, [4], since);
    expect(orders.map((o) => o.reference)).toEqual(['SO3', 'SO1']);
    expect(orders[0]).toMatchObject({ drmsId: 'd5', open: true, lines: [{ colour: 'cyan' }] });
    expect(orders[1]).toMatchObject({ drmsId: 'd4', typeName: null });
    expect(typeof orders[1]!.deviceName).toBe('string');
    expect((await listCustomerOrders(t.db, [2], since)).map((o) => o.reference)).toEqual(['SO4']);
    expect(await listCustomerOrders(t.db, [], since)).toEqual([]);
  });

  it('listCustomerShelves returns the shelves of the given customers', async () => {
    const shelves = await listCustomerShelves(t.db, [3, 4]);
    expect(shelves.map((s) => s.vantageCustomerId)).toEqual([4, 3]);
    expect(await listCustomerShelves(t.db, [1])).toEqual([]);
    expect(await listCustomerShelves(t.db, [])).toEqual([]);
  });
});
