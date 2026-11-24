import { describe, expect, it } from 'vitest';
import type { PmRow, PmStatus } from '@mps/db/queries';
import {
  applyPmFacets,
  facetKey,
  facetOptions,
  groupByTown,
  pageTownGroups,
  parsePmFacets,
  townHeader,
  type PmFacetSelection,
} from './pm-facets';

const row = (id: number, over: Partial<PmRow> & { status?: PmStatus } = {}): PmRow => {
  const { status = 'due_soon', ...rest } = over;
  return {
    vantageEquipmentId: id,
    drmsEquipmentId: null,
    customerName: 'Acme',
    town: 'Reading',
    customerId: null,
    district: null,
    county: null,
    areaCounty: null,
    familyId: 1,
    otherDealer: { dealer: null, source: null, region: null },
    plan: { whenInArea: false, priority: false, boardColumn: null },
    serial: 'A1',
    model: 'C300i',
    family: 'TN-328',
    intervalPages: 100000,
    intervalSource: 'global',
    action: null,
    bookedOverdue: false,
    view: 'due',
    result: { status } as PmRow['result'],
    ...rest,
  };
};
const empty = (): PmFacetSelection => ({ town: [], county: [], status: [], family: [], customer: [] });

describe('town groups', () => {
  it('town variants merge', () => {
    const g = groupByTown([row(1, { town: 'Reading' }), row(2, { town: ' reading ' }), row(3, { town: 'Reading' }), row(4, { town: 'READING' })], 'worst');
    expect(g).toHaveLength(1);
    expect(g[0]!.label).toBe('Reading');
    expect(g[0]!.due).toBe(4);
    const g2 = groupByTown([row(1, { town: 'New  Bury' }), row(2, { town: 'new bury' })], 'az');
    expect(g2).toHaveLength(1);
  });
  it('blank town is No town and last', () => {
    const g = groupByTown([row(1, { town: null, status: 'overdue' }), row(2, { town: '  ' }), row(3, { town: 'Zeta' })], 'worst');
    expect(g.map((x) => x.label)).toEqual(['Zeta', 'No town']);
    expect(g[1]!.rows).toHaveLength(2);
    expect(groupByTown([row(1, { town: null }), row(2, { town: 'Aa' })], 'az').map((x) => x.label)).toEqual(['Aa', 'No town']);
  });
  it('worst-first order', () => {
    const g = groupByTown(
      [row(1, { town: 'B' }), row(2, { town: 'A', status: 'overdue' }), row(3, { town: 'C', status: 'overdue' }), row(4, { town: 'C' }), row(5, { town: 'D', status: 'overdue' })],
      'worst',
    );
    expect(g.map((x) => x.label)).toEqual(['C', 'A', 'D', 'B']);
  });
  it('az order', () => {
    const g = groupByTown([row(1, { town: 'B', status: 'overdue' }), row(2, { town: 'a' }), row(3, { town: 'C' })], 'az');
    expect(g.map((x) => x.label)).toEqual(['a', 'B', 'C']);
  });
  it('continued header keeps full counts', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, { status: i <= 2 ? 'overdue' : 'due_soon' }));
    const groups = groupByTown(rows, 'worst');
    const p1 = pageTownGroups(groups, 1, 3);
    const p2 = pageTownGroups(groups, 2, 3);
    expect(p1).toHaveLength(1);
    expect(p1[0]!.continued).toBe(false);
    expect(p1[0]!.rows).toHaveLength(3);
    expect(p2[0]!.continued).toBe(true);
    expect(p2[0]!.rows).toHaveLength(2);
    expect(p2[0]!.group.due).toBe(5);
    expect(p2[0]!.group.overdue).toBe(2);
  });
  it('page spans groups counting machines', () => {
    const groups = groupByTown([row(1, { town: 'A' }), row(2, { town: 'A' }), row(3, { town: 'B' })], 'az');
    const s = pageTownGroups(groups, 1, 3);
    expect(s.map((x) => x.rows.length)).toEqual([2, 1]);
  });
  it('townHeader copy', () => {
    expect(townHeader({ key: 'a', label: 'Newbury', due: 5, overdue: 2, priority: 0, rows: [] })).toBe('Newbury · 5 due · 2 overdue');
    expect(townHeader({ key: 'a', label: 'Newbury', due: 5, overdue: 2, priority: 3, rows: [] })).toBe('Newbury · 5 due · 2 overdue · ★ 3');
  });
  it('priority counted', () => {
    const g = groupByTown([row(1, { plan: { whenInArea: false, priority: true, boardColumn: null } }), row(2)], 'worst');
    expect(g[0]!.priority).toBe(1);
  });
});

describe('facets', () => {
  const rows = [
    row(1, { town: 'Reading', areaCounty: 'Berkshire', status: 'overdue' }),
    row(2, { town: 'Newbury', areaCounty: 'Berkshire', status: 'due_soon' }),
    row(3, { town: 'Slough', areaCounty: null, county: 'Bucks', status: 'overdue', familyId: 2, family: 'TN-5' }),
    row(4, { town: 'Slough', status: 'overdue' }),
  ];
  it('OR within facet, AND across', () => {
    expect(applyPmFacets(rows, { ...empty(), town: ['reading', 'newbury'] }).map((r) => r.vantageEquipmentId)).toEqual([1, 2]);
    expect(applyPmFacets(rows, { ...empty(), town: ['reading', 'newbury'], status: ['overdue'] }).map((r) => r.vantageEquipmentId)).toEqual([1]);
    expect(applyPmFacets(rows, { ...empty(), county: ['Bucks', 'Unknown'] }).map((r) => r.vantageEquipmentId)).toEqual([3, 4]);
    expect(applyPmFacets(rows, { ...empty(), family: ['2'] }).map((r) => r.vantageEquipmentId)).toEqual([3]);
  });
  it('counts ignore own facet', () => {
    const sel = { ...empty(), town: ['newbury'] };
    const opts = facetOptions(rows, sel, 'town');
    expect(opts.find((o) => o.value === 'reading')!.count).toBe(1);
    expect(opts.find((o) => o.value === 'newbury')!.checked).toBe(true);
    const st = facetOptions(rows, sel, 'status');
    expect(st.find((o) => o.value === 'overdue')).toBeUndefined();
    expect(st.find((o) => o.value === 'due_soon')!.count).toBe(1);
  });
  it('ticked value with zero count stays', () => {
    const sel = { ...empty(), town: ['reading'], status: ['due_soon'] };
    const opts = facetOptions(rows, sel, 'town');
    const reading = opts.find((o) => o.value === 'reading')!;
    expect(reading.count).toBe(0);
    expect(reading.checked).toBe(true);
    expect(reading.label).toBe('Reading');
    const st = facetOptions(rows, { ...empty(), status: ['ok'] }, 'status');
    expect(st.find((o) => o.value === 'ok')!.count).toBe(0);
  });
  it('sorted count desc then label; labels', () => {
    const opts = facetOptions(rows, empty(), 'town');
    expect(opts.map((o) => o.label)).toEqual(['Slough', 'Newbury', 'Reading']);
    const fam = facetOptions(rows, empty(), 'family', new Map([['1', 'Mapped']]));
    expect(fam.map((o) => o.label)).toEqual(['Mapped', 'TN-5']);
    expect(facetOptions(rows, empty(), 'county').map((o) => o.label)).toEqual(['Berkshire', 'Bucks', 'Unknown']);
  });
  it('customer with stray whitespace matches its ticked value', () => {
    const rs = [row(1, { customerName: '  Acme  Ltd ' }), row(2, { customerName: 'Other' })];
    expect(applyPmFacets(rs, { ...empty(), customer: ['Acme Ltd'] }).map((r) => r.vantageEquipmentId)).toEqual([1]);
  });
  it('parsePmFacets drops junk', () => {
    const sel = parsePmFacets(new URLSearchParams('town=Reading&town=%20&town=Reading&town=Slough&status=overdue&status=bogus&family=12&family=abc&customer=Acme'));
    expect(sel.town).toEqual(['Reading', 'Slough']);
    expect(sel.status).toEqual(['overdue']);
    expect(sel.family).toEqual(['12']);
    expect(sel.customer).toEqual(['Acme']);
    expect(parsePmFacets({ town: ['A', ' ', 'A'], family: '7' }).town).toEqual(['A']);
    expect(parsePmFacets({ family: '7' }).family).toEqual(['7']);
    expect(parsePmFacets({}).county).toEqual([]);
  });
  it('town values dedupe by townKey', () => {
    expect(parsePmFacets(new URLSearchParams('town=Newbury&town=newbury&town=%20NEWBURY%20')).town).toEqual(['Newbury']);
  });
});

describe('customer facet (case-insensitive)', () => {
  const rs = [
    row(1, { customerName: 'ACME Ltd' }),
    row(2, { customerName: 'Acme Ltd' }),
    row(3, { customerName: 'Acme Ltd' }),
    row(4, { customerName: 'Acme Holdings' }),
    row(5, { customerName: 'Other' }),
  ];
  const ids = (sel: PmFacetSelection) => applyPmFacets(rs, sel).map((r) => r.vantageEquipmentId);
  it('mixed-case link value matches exactly, not by substring', () => {
    expect(ids({ ...empty(), customer: ['acme LTD'] })).toEqual([1, 2, 3]);
  });
  it('value matching no row exactly falls back to substring', () => {
    expect(ids({ ...empty(), customer: ['acme'] })).toEqual([1, 2, 3, 4]);
    expect(ids({ ...empty(), customer: ['nobody'] })).toEqual([]);
  });
  it('label is the most common spelling; value is the folded key', () => {
    const opts = facetOptions(rs, empty(), 'customer');
    const acme = opts.find((o) => o.value === 'acme ltd')!;
    expect(acme.label).toBe('Acme Ltd');
    expect(acme.count).toBe(3);
    const ticked = facetOptions(rs, { ...empty(), customer: ['ACME LTD'] }, 'customer');
    expect(ticked.find((o) => o.value === 'acme ltd')!.checked).toBe(true);
  });
  it('parse dedupes case variants and facetKey folds', () => {
    expect(parsePmFacets(new URLSearchParams('customer=Acme%20Ltd&customer=acme%20%20ltd')).customer).toEqual(['Acme Ltd']);
    expect(facetKey('customer', ' Acme  LTD ')).toBe('acme ltd');
    expect(facetKey('town', ' NewBury')).toBe('newbury');
    expect(facetKey('county', 'Berkshire')).toBe('Berkshire');
  });
});
