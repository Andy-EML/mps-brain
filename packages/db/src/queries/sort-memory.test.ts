import { describe, expect, it } from 'vitest';
import { CUSTOMER_SORT_KEYS, sortCustomerRows, type CustomerRow } from './customers';
import { PM_SORT_KEYS, sortPmRows, type PmRow } from './pm-queries';
import { QUEUE_SORT_KEYS, sortQueueDevices, type QueueDevice } from './replenishment';
import { compareBy } from './shared';
import { SHELF_SORT_KEYS, sortShelves, type ShelfSummary } from './site-stock';
import { YIELD_SORT_KEYS, sortUnderYielding, type UnderYieldingRow } from './toner-yield';

const ids = <T>(rows: T[], f: (r: T) => string | number) => rows.map(f);

describe('compareBy', () => {
  type R = { id: number; s: string | null; n: number | null; d: Date | null };
  const get = { s: (r: R) => r.s, n: (r: R) => r.n, d: (r: R) => r.d };
  const run = (rows: R[], key: 's' | 'n' | 'd', dir: 'asc' | 'desc') =>
    [...rows].sort(compareBy(get, { key, dir }, (r) => r.id)).map((r) => r.id);

  it('compares strings case-insensitively, numbers and dates numerically', () => {
    const rows: R[] = [
      { id: 1, s: 'banana', n: 10, d: new Date('2026-03-01') },
      { id: 2, s: 'Apple', n: 9, d: new Date('2026-01-01') },
      { id: 3, s: 'cherry', n: 100, d: new Date('2026-02-01') },
    ];
    expect(run(rows, 's', 'asc')).toEqual([2, 1, 3]);
    expect(run(rows, 's', 'desc')).toEqual([3, 1, 2]);
    expect(run(rows, 'n', 'asc')).toEqual([2, 1, 3]); // 9 < 10 < 100, not lexical
    expect(run(rows, 'd', 'desc')).toEqual([1, 3, 2]);
  });

  it('puts nulls last in both directions', () => {
    const rows: R[] = [
      { id: 1, s: null, n: null, d: null },
      { id: 2, s: 'b', n: 2, d: new Date('2026-02-01') },
      { id: 3, s: 'a', n: 1, d: new Date('2026-01-01') },
    ];
    for (const key of ['s', 'n', 'd'] as const) {
      expect(run(rows, key, 'asc').at(-1), `${key} asc`).toBe(1);
      expect(run(rows, key, 'desc').at(-1), `${key} desc`).toBe(1);
    }
  });

  it('breaks ties on the id ascending whatever the direction, and case-folded equal strings tie', () => {
    const rows: R[] = [
      { id: 9, s: 'same', n: 5, d: null },
      { id: 3, s: 'SAME', n: 5, d: null },
      { id: 5, s: 'Same', n: 5, d: null },
    ];
    expect(run(rows, 's', 'asc')).toEqual([3, 5, 9]);
    expect(run(rows, 's', 'desc')).toEqual([3, 5, 9]);
    expect(run(rows, 'n', 'desc')).toEqual([3, 5, 9]);
  });

  it('uses the fallback for no sort or an unknown key (hostile query string)', () => {
    const fallback = (a: R, b: R) => b.id - a.id;
    const rows: R[] = [
      { id: 1, s: 'a', n: 1, d: null },
      { id: 2, s: 'b', n: 2, d: null },
    ];
    expect([...rows].sort(compareBy(get, undefined, (r) => r.id, fallback)).map((r) => r.id)).toEqual([2, 1]);
    const bad = { key: '__proto__', dir: 'asc' } as unknown as { key: 's'; dir: 'asc' };
    expect([...rows].sort(compareBy(get, bad, (r) => r.id, fallback)).map((r) => r.id)).toEqual([2, 1]);
  });
});

/** For each key: asc and desc reverse the distinct rows and keep the all-null row (first in the input) last. */
function expectSorted<T, K extends string>(
  keys: readonly K[],
  sort: (rows: T[], s?: { key: K; dir: 'asc' | 'desc' }) => T[],
  rows: T[],
  id: (r: T) => string | number,
  nullId: string | number,
  skip: readonly K[] = [],
) {
  for (const key of keys) {
    if (skip.includes(key)) continue;
    const asc = ids(sort(rows, { key, dir: 'asc' }), id);
    const desc = ids(sort(rows, { key, dir: 'desc' }), id);
    expect(asc.at(-1), `${key} asc: null row last`).toBe(nullId);
    expect(desc.at(-1), `${key} desc: null row last`).toBe(nullId);
    expect(desc.slice(0, -1), `${key}: desc reverses asc`).toEqual(asc.slice(0, -1).reverse());
    expect(new Set(asc).size).toBe(rows.length);
  }
}

describe('sortCustomerRows', () => {
  const row = (vantageId: number, o: Partial<CustomerRow>): CustomerRow => ({
    vantageId, name: null, reference: null, town: null, machines: 0, pending: 0, shelves: 0, sites: 0, selfManaged: null, deleted: false, ...o,
  });
  const rows = [
    row(40, {}),
    row(10, { name: 'Bravo', reference: 'R2', town: 'York', machines: 5, pending: 2, shelves: 1, sites: 3, selfManaged: 'head_office' }),
    row(20, { name: 'alpha', reference: 'R1', town: 'Ayr', machines: 1, pending: 0, shelves: 0, sites: 1, selfManaged: 'site' }),
    row(30, { name: 'Charlie', reference: 'R3', town: 'Luton', machines: 9, pending: 7, shelves: 4, sites: 5 }),
  ];

  it('exposes the keys', () => {
    expect([...CUSTOMER_SORT_KEYS]).toEqual(['name', 'ref', 'town', 'machines', 'pending', 'shelves', 'sites', 'stock']);
  });

  // Numeric columns have no nulls (0 is a value), so the all-null row is just a 0 there: skip them.
  it('sorts each key asc/desc with the null row last', () => {
    expectSorted(CUSTOMER_SORT_KEYS, sortCustomerRows, rows, (r) => r.vantageId, 40, ['machines', 'pending', 'shelves', 'sites', 'stock']);
  });

  it('sorts stock by source with unset rows last, tied on the id', () => {
    expect(ids(sortCustomerRows(rows, { key: 'stock', dir: 'asc' }), (r) => r.vantageId)).toEqual([10, 20, 30, 40]);
    expect(ids(sortCustomerRows(rows, { key: 'stock', dir: 'desc' }), (r) => r.vantageId)).toEqual([20, 10, 30, 40]);
  });

  it('sorts numeric columns numerically with the id as tiebreak', () => {
    expect(ids(sortCustomerRows(rows, { key: 'machines', dir: 'desc' }), (r) => r.vantageId)).toEqual([30, 10, 20, 40]);
    const ties = [row(7, { machines: 2 }), row(3, { machines: 2 }), row(5, { machines: 2 })];
    expect(ids(sortCustomerRows(ties, { key: 'machines', dir: 'desc' }), (r) => r.vantageId)).toEqual([3, 5, 7]);
  });

  it('no sort keeps the given order', () => {
    expect(ids(sortCustomerRows(rows), (r) => r.vantageId)).toEqual([40, 10, 20, 30]);
  });
});

describe('sortPmRows', () => {
  type O = { cust?: string; serial?: string; model?: string; town?: string; status?: string; pages?: number; pct?: number; last?: string; due?: string };
  const row = (id: number, o: O): PmRow =>
    ({
      vantageEquipmentId: id,
      customerName: o.cust ?? null,
      town: o.town ?? null,
      serial: o.serial ?? null,
      model: o.model ?? null,
      result: {
        status: o.status ?? 'ok',
        pagesSince: o.pages ?? null,
        pctUsed: o.pct ?? null,
        lastQualifying: o.last ? { at: new Date(o.last) } : null,
        estDueDate: o.due ? new Date(o.due) : null,
      },
    }) as unknown as PmRow;
  const rows = [
    row(40, { status: 'unknown' }),
    row(10, { cust: 'Bravo', serial: 'S2', model: 'M2', town: 'York', status: 'overdue', pages: 900, pct: 1.2, last: '2026-02-01', due: '2026-03-01' }),
    row(20, { cust: 'alpha', serial: 'S1', model: 'M1', town: 'Ayr', status: 'ok', pages: 100, pct: 0.1, last: '2026-01-01', due: '2026-01-01' }),
    row(30, { cust: 'Charlie', serial: 'S3', model: 'M3', town: 'Luton', status: 'due_soon', pages: 500, pct: 0.9, last: '2026-03-01', due: '2026-02-01' }),
  ];

  it('exposes the keys', () => {
    expect([...PM_SORT_KEYS]).toEqual(['customer', 'serial', 'model', 'status', 'pages', 'pct', 'lastVisit', 'due', 'town']);
  });

  it('sorts each key asc/desc with the null row last', () => {
    // status is never null: the unknown row sorts by its rank instead.
    expectSorted(PM_SORT_KEYS, sortPmRows, rows, (r) => r.vantageEquipmentId, 40, ['status']);
  });

  it('sorts status by severity (overdue first) with id tiebreak', () => {
    expect(ids(sortPmRows(rows, { key: 'status', dir: 'asc' }), (r) => r.vantageEquipmentId)).toEqual([10, 30, 40, 20]);
    const ties = [row(7, { status: 'ok' }), row(3, { status: 'ok' })];
    expect(ids(sortPmRows(ties, { key: 'status', dir: 'desc' }), (r) => r.vantageEquipmentId)).toEqual([3, 7]);
  });

  it('pages sort numerically', () => {
    expect(ids(sortPmRows(rows, { key: 'pages', dir: 'desc' }), (r) => r.vantageEquipmentId)).toEqual([10, 30, 20, 40]);
  });

  it('no sort, or a bad key, applies the default (overdue first, then percent used desc, then id)', () => {
    expect(ids(sortPmRows(rows), (r) => r.vantageEquipmentId)).toEqual([10, 30, 20, 40]);
    const bad = { key: '__proto__', dir: 'asc' } as unknown as { key: 'town'; dir: 'asc' };
    expect(ids(sortPmRows(rows, bad), (r) => r.vantageEquipmentId)).toEqual([10, 30, 20, 40]);
  });
});

describe('sortShelves', () => {
  const row = (id: number, o: { siteName?: string; familyName?: string; machines?: number; used?: number; live?: boolean }): ShelfSummary => ({
    id,
    vantageCustomerId: id,
    siteName: o.siteName ?? '',
    customerReference: null,
    postcode: null,
    headOfficeName: null,
    familyId: id,
    familyName: o.familyName ?? '',
    isColour: false,
    machines: o.machines ?? 0,
    holding: { black: 0, cyan: 0, magenta: 0, yellow: 0, waste: 0 },
    used: { black: o.used ?? 0, cyan: 0, magenta: 0, yellow: 0, waste: 0 },
    liveTopUp: o.live ?? false,
    autoOffDevices: 0,
  });
  const rows = [
    row(10, { siteName: 'Bravo', familyName: 'Mono', machines: 3, used: 4, live: true }),
    row(20, { siteName: 'alpha', familyName: 'C-series', machines: 1, used: 1 }),
    row(30, { siteName: 'Charlie', familyName: 'B-series', machines: 7, used: 9 }),
  ];

  it('exposes the keys', () => {
    expect([...SHELF_SORT_KEYS]).toEqual(['site', 'family', 'machines', 'used', 'status']);
  });

  it('sorts each key asc and desc, id as tiebreak', () => {
    expect(ids(sortShelves(rows, { key: 'site', dir: 'asc' }), (r) => r.id)).toEqual([20, 10, 30]);
    expect(ids(sortShelves(rows, { key: 'family', dir: 'asc' }), (r) => r.id)).toEqual([30, 20, 10]);
    expect(ids(sortShelves(rows, { key: 'machines', dir: 'desc' }), (r) => r.id)).toEqual([30, 10, 20]);
    expect(ids(sortShelves(rows, { key: 'used', dir: 'desc' }), (r) => r.id)).toEqual([30, 10, 20]);
    // status: proposed (live top-up) sorts after idle ascending; the two idle shelves tie and fall to id.
    expect(ids(sortShelves(rows, { key: 'status', dir: 'desc' }), (r) => r.id)).toEqual([10, 20, 30]);
    expect(ids(sortShelves(rows, { key: 'status', dir: 'asc' }), (r) => r.id)).toEqual([20, 30, 10]);
  });

  it('a missing site name sorts last in both directions', () => {
    const withNull = [{ ...row(5, { familyName: 'Z' }), siteName: null as unknown as string }, ...rows];
    for (const dir of ['asc', 'desc'] as const) {
      expect(sortShelves(withNull, { key: 'site', dir }).at(-1)!.id).toBe(5);
    }
  });

  it('no sort is the existing order: proposed first, then site, then family', () => {
    expect(ids(sortShelves(rows), (r) => r.id)).toEqual([10, 20, 30]);
  });
});

describe('sortQueueDevices', () => {
  const dev = (id: string, o: { name?: string; cust?: string; level?: number; at?: string }): QueueDevice =>
    ({
      drmsId: id,
      displayName: o.name ?? id,
      customerName: o.cust ?? null,
      proposals: [{ currentLevel: o.level ?? null, createdAt: new Date(o.at ?? '2026-01-01'), decidedAt: null }],
      orders: [],
    }) as unknown as QueueDevice;
  const rows = [
    dev('d9', { name: 'Zulu', level: 5, at: '2026-03-01' }),
    dev('d1', { name: 'Bravo', cust: 'Acme', level: 40, at: '2026-01-01' }),
    dev('d2', { name: 'alpha', cust: 'Zed', level: 10, at: '2026-02-01' }),
  ];
  const run = (tab: Parameters<typeof sortQueueDevices>[1], s?: Parameters<typeof sortQueueDevices>[2]) =>
    ids(sortQueueDevices(rows, tab, s), (r) => r.drmsId);

  it('exposes the keys', () => {
    expect([...QUEUE_SORT_KEYS]).toEqual(['urgency', 'recent', 'customer', 'device']);
  });

  it('urgency and recent reuse the tab orders, and desc reverses them', () => {
    expect(run('review', { key: 'urgency', dir: 'asc' })).toEqual(['d9', 'd2', 'd1']);
    expect(run('review', { key: 'urgency', dir: 'desc' })).toEqual(['d1', 'd2', 'd9']);
    expect(run('review', { key: 'recent', dir: 'asc' })).toEqual(['d9', 'd2', 'd1']);
    expect(run('review', { key: 'recent', dir: 'desc' })).toEqual(['d1', 'd2', 'd9']);
  });

  it('customer and device sort, nulls last in both directions', () => {
    for (const dir of ['asc', 'desc'] as const) {
      expect(run('review', { key: 'customer', dir }).at(-1)).toBe('d9');
    }
    expect(run('review', { key: 'customer', dir: 'asc' })).toEqual(['d1', 'd2', 'd9']);
    expect(run('review', { key: 'device', dir: 'asc' })).toEqual(['d2', 'd1', 'd9']);
    expect(run('review', { key: 'device', dir: 'desc' })).toEqual(['d9', 'd1', 'd2']);
  });

  it('ties fall to the device id', () => {
    const ties = [dev('d7', { cust: 'Same' }), dev('d3', { cust: 'same' })];
    expect(ids(sortQueueDevices(ties, 'review', { key: 'customer', dir: 'desc' }), (r) => r.drmsId)).toEqual(['d3', 'd7']);
  });

  it('no sort is the tab default: urgency for review and on-site, recency for the rest', () => {
    const two = [dev('d1', { at: '2026-01-01', level: 1 }), dev('d2', { at: '2026-05-01', level: 99 })];
    expect(ids(sortQueueDevices(two, 'review'), (r) => r.drmsId)).toEqual(['d1', 'd2']);
    expect(ids(sortQueueDevices(two, 'on-site'), (r) => r.drmsId)).toEqual(['d1', 'd2']);
    expect(ids(sortQueueDevices(two, 'ordered'), (r) => r.drmsId)).toEqual(['d2', 'd1']);
  });
});

describe('sortUnderYielding', () => {
  const row = (id: string, o: Partial<UnderYieldingRow>): UnderYieldingRow => ({
    drmsEquipmentId: id, customerName: null, serial: null, model: null, family: null, colour: 'black', ratedYield: 1000, avgAchieved: 500,
    avgPctOfRated: 0.5, cartridgesCounted: 1, lastOrderDate: null, stale: false, ...o,
  });
  const rows = [
    row('d9', {}),
    row('d1', { customerName: 'Bravo', serial: 'S2', model: 'M2', family: 'F2', colour: 'cyan', avgPctOfRated: 0.4, avgAchieved: 400, cartridgesCounted: 3, lastOrderDate: new Date('2026-02-01') }),
    row('d2', { customerName: 'alpha', serial: 'S1', model: 'M1', family: 'F1', colour: 'black', avgPctOfRated: 0.2, avgAchieved: 200, cartridgesCounted: 2, lastOrderDate: new Date('2026-01-01') }),
    row('d3', { customerName: 'Charlie', serial: 'S3', model: 'M3', family: 'F3', colour: 'yellow', avgPctOfRated: 0.6, avgAchieved: 600, cartridgesCounted: 10, lastOrderDate: new Date('2026-03-01') }),
  ];

  it('exposes the keys', () => {
    expect([...YIELD_SORT_KEYS]).toEqual(['customer', 'serial', 'model', 'family', 'colour', 'achieved', 'cartridges', 'lastOrder']);
  });

  it('sorts each key asc/desc, null row last in both directions', () => {
    // colour, achieved and cartridges are never null.
    expectSorted(YIELD_SORT_KEYS, sortUnderYielding, rows, (r) => r.drmsEquipmentId, 'd9', ['colour', 'achieved', 'cartridges']);
  });

  it('achieved is the percentage of rated, cartridges numeric (10 after 3)', () => {
    expect(ids(sortUnderYielding(rows, { key: 'achieved', dir: 'asc' }), (r) => r.drmsEquipmentId)).toEqual(['d2', 'd1', 'd9', 'd3']);
    expect(ids(sortUnderYielding(rows, { key: 'cartridges', dir: 'desc' }), (r) => r.drmsEquipmentId)).toEqual(['d3', 'd1', 'd2', 'd9']);
  });

  it('ties fall to the device id then colour', () => {
    const ties = [row('d7', { colour: 'cyan', model: 'x' }), row('d3', { colour: 'cyan', model: 'X' }), row('d3', { colour: 'black', model: 'x' })];
    const out = sortUnderYielding(ties, { key: 'model', dir: 'desc' });
    expect(out.map((r) => `${r.drmsEquipmentId}${r.colour}`)).toEqual(['d3black', 'd3cyan', 'd7cyan']);
  });

  it('no sort is worst first (average percent of rated ascending)', () => {
    expect(ids(sortUnderYielding(rows), (r) => r.drmsEquipmentId)).toEqual(['d2', 'd1', 'd9', 'd3']);
  });

  it('no sort breaks a tie on percent of rated by device id then colour', () => {
    const ties = [row('d7', { colour: 'cyan' }), row('d3', { colour: 'cyan' }), row('d3', { colour: 'black' }), row('d1', { avgPctOfRated: 0.9 })];
    expect(sortUnderYielding(ties).map((r) => `${r.drmsEquipmentId}${r.colour}`)).toEqual(['d3black', 'd3cyan', 'd7cyan', 'd1black']);
  });
});
