import { describe, expect, it } from 'vitest';
import type { PmResult, PmRow, PmStatus } from '@mps/db/queries';
import { inDefaultView } from '@mps/db/queries';
import {
  applyPmView,
  canAddToPlan,
  countPm,
  dueKinds,
  inPmView,
  parsePmFilters,
  selectPmRows,
  type PmFilters,
  type PmStatusFilter,
} from './filters';

const NOW = new Date('2026-11-18T12:00:00Z');

const row = (status: PmStatus, over: Partial<PmResult> = {}, id = 1): PmRow => ({
  vantageEquipmentId: id,
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
  family: 'TN-328',
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
    ...over,
  },
});

describe('parsePmFilters', () => {
  it('view parsed, default due', () => {
    expect(parsePmFilters({}).view).toBe('due');
    expect(parsePmFilters({ view: 'booked' }).view).toBe('booked');
    expect(parsePmFilters({ view: 'dismissed' }).view).toBe('dismissed');
    expect(parsePmFilters({ view: 'all' }).view).toBe('all');
    expect(parsePmFilters({ view: 'bogus' }).view).toBe('due');
    expect(parsePmFilters(new URLSearchParams('view=booked')).view).toBe('booked');
  });

  const noFacets = { town: [], county: [], status: [], family: [], customer: [] };

  it('defaults to the Due view with nothing else set', () => {
    expect(parsePmFilters({})).toEqual({ view: 'due', q: undefined, overdue: 'all', facets: noFacets, townSort: 'worst' });
  });

  it('reads old single-value status, customer and family links as one-value facets', () => {
    expect(parsePmFilters({ status: 'overdue', customer: ' Acme ', family: '7', search: ' c300 ', overdue: 'time' })).toEqual({
      view: 'due',
      q: 'c300',
      overdue: 'time',
      facets: { ...noFacets, status: ['overdue'], customer: ['Acme'], family: ['7'] },
      townSort: 'worst',
    });
  });

  it('reads repeated facet params and the town sort', () => {
    const f = parsePmFilters(new URLSearchParams('town=newbury&town=Reading&county=Berkshire&status=overdue&status=due_soon&townSort=az'));
    expect(f.facets).toEqual({ ...noFacets, town: ['newbury', 'Reading'], county: ['Berkshire'], status: ['overdue', 'due_soon'] });
    expect(f.townSort).toBe('az');
    expect(parsePmFilters({ townSort: 'bogus' }).townSort).toBe('worst');
  });

  it('accepts q as the search param too', () => {
    expect(parsePmFilters({ q: 'abc' }).q).toBe('abc');
  });

  it('reads URLSearchParams the same way', () => {
    expect(parsePmFilters(new URLSearchParams('view=all&status=ok&family=3&overdue=pages'))).toMatchObject({
      view: 'all',
      overdue: 'pages',
      facets: { status: ['ok'], family: ['3'] },
    });
  });

  it('accepts the When in area and Other dealer tabs', () => {
    expect(parsePmFilters(new URLSearchParams('?view=other-dealer')).view).toBe('other-dealer');
    expect(parsePmFilters({ view: 'when-in-area' }).view).toBe('when-in-area');
    expect(parsePmFilters({ view: 'other_dealer' }).view).toBe('due');
  });

  it('takes the first of a repeated view', () => {
    expect(parsePmFilters({ view: ['booked', 'all'] }).view).toBe('booked');
  });

  it('ignores junk', () => {
    expect(parsePmFilters({ status: 'bogus', family: 'x', overdue: 'never', customer: '  ' })).toEqual({
      view: 'due',
      q: undefined,
      overdue: 'all',
      facets: noFacets,
      townSort: 'worst',
    });
    expect(parsePmFilters({ family: '-2' }).facets.family).toEqual([]);
    expect(parsePmFilters({ family: '2.5' }).facets.family).toEqual([]);
  });
});

/** The page's list and the CSV export both go through selectPmRows. */
describe('selectPmRows (page and export)', () => {
  const at = (id: number, town: string | null, status: PmStatus = 'overdue'): PmRow => ({ ...row(status, { reason: 'pages' }, id), town });
  const rows = [at(1, 'Newbury'), at(2, 'Reading'), at(3, ' newbury '), at(4, null), at(5, 'Reading', 'ok')];
  const ids = (rs: PmRow[]) => rs.map((r) => r.vantageEquipmentId);

  it('filters the tab by town from the URL, any spelling', () => {
    expect(ids(selectPmRows(rows, parsePmFilters(new URLSearchParams('town=Newbury')), NOW))).toEqual([1, 3]);
  });

  it('ORs towns and ANDs other facets, inside the tab', () => {
    expect(ids(selectPmRows(rows, parsePmFilters(new URLSearchParams('town=newbury&town=reading')), NOW))).toEqual([1, 2, 3]);
    expect(ids(selectPmRows(rows, parsePmFilters(new URLSearchParams('view=all&town=reading&status=ok')), NOW))).toEqual([5]);
  });

  it('is the tab alone with no facets', () => {
    expect(ids(selectPmRows(rows, parsePmFilters({}), NOW))).toEqual([1, 2, 3, 4]);
  });
});

// inDefaultView lives in @mps/db; these pin the behaviour the page and CSV rely on.
describe('inDefaultView (from @mps/db)', () => {
  it('keeps overdue and due soon', () => {
    expect(inDefaultView(row('overdue'), NOW)).toBe(true);
    expect(inDefaultView(row('due_soon'), NOW)).toBe(true);
    expect(inDefaultView(row('ok'), NOW)).toBe(false);
    expect(inDefaultView(row('booked'), NOW)).toBe(false);
  });

  it('keeps a held machine only once it is past its interval or the time cap', () => {
    expect(inDefaultView(row('held', { pagesSince: 50000 }), NOW)).toBe(false);
    expect(inDefaultView(row('held', { pagesSince: 100000 }), NOW)).toBe(true);
    expect(inDefaultView(row('held', { timeCapDate: new Date('2026-11-01T00:00:00Z') }), NOW)).toBe(true);
    expect(inDefaultView(row('held', { timeCapDate: new Date('2026-12-01T00:00:00Z') }), NOW)).toBe(false);
  });
});

// inPmView itself is tested in @mps/db pm-queries.test.ts; this pins the re-export the page uses.
describe('inPmView (from @mps/db)', () => {
  it('puts due rows in Due only when they need PM or a booking went unseen', () => {
    expect(inPmView(row('overdue'), 'due', NOW)).toBe(true);
    expect(inPmView(row('ok'), 'due', NOW)).toBe(false);
    expect(inPmView({ ...row('ok'), bookedOverdue: true }, 'due', NOW)).toBe(true);
    expect(inPmView({ ...row('overdue'), view: 'dismissed' }, 'due', NOW)).toBe(false);
  });

  it('matches Booked and Dismissed on the row view, and All takes everything', () => {
    expect(inPmView({ ...row('booked'), view: 'booked' }, 'booked', NOW)).toBe(true);
    expect(inPmView(row('overdue'), 'booked', NOW)).toBe(false);
    expect(inPmView({ ...row('overdue'), view: 'dismissed' }, 'dismissed', NOW)).toBe(true);
    expect(inPmView({ ...row('ok'), view: 'dismissed' }, 'all', NOW)).toBe(true);
  });
});

describe('applyPmView', () => {
  const rows = [
    row('overdue', { reason: 'pages' }, 1),
    row('overdue', { reason: 'no_visit_12m' }, 2),
    row('overdue', { reason: 'time_cap' }, 3),
    row('due_soon', {}, 4),
    row('ok', {}, 5),
    { ...row('overdue', { reason: 'pages' }, 6), view: 'dismissed' as const },
    { ...row('booked', {}, 7), view: 'booked' as const },
  ];
  const ids = (rs: PmRow[]) => rs.map((r) => r.vantageEquipmentId);
  const f = (over: Partial<Pick<PmFilters, 'view' | 'overdue'> & { status: PmStatusFilter }>) => ({ view: 'due' as const, status: 'all' as const, overdue: 'all' as const, ...over });

  it('filters by view then status, keeping order', () => {
    expect(ids(applyPmView(rows, f({}), NOW))).toEqual([1, 2, 3, 4]);
    expect(ids(applyPmView(rows, f({ view: 'all' }), NOW))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ids(applyPmView(rows, f({ view: 'all', status: 'ok' }), NOW))).toEqual([5]);
    expect(ids(applyPmView(rows, f({ view: 'dismissed' }), NOW))).toEqual([6]);
    expect(ids(applyPmView(rows, f({ view: 'booked' }), NOW))).toEqual([7]);
  });

  it('narrows the Due tab by reason', () => {
    expect(ids(applyPmView(rows, f({ overdue: 'pages' }), NOW))).toEqual([1]);
    expect(ids(applyPmView(rows, f({ status: 'overdue', overdue: 'time' }), NOW))).toEqual([2, 3]);
  });

  it('the pages / time chips include due-soon rows by their reason, on the Due tab only', () => {
    const soon = [
      row('due_soon', { pctUsed: 0.9, pagesSince: 90000 }, 11),
      row('due_soon', { timeCapDate: new Date('2026-12-01T00:00:00Z') }, 12),
      row('due_soon', { estDueDate: new Date('2026-12-05T00:00:00Z'), pctUsed: 0.5 }, 13),
    ];
    const all = [...rows, ...soon];
    expect(ids(applyPmView(all, f({ overdue: 'pages' }), NOW))).toEqual([1, 11, 13]);
    expect(ids(applyPmView(all, f({ overdue: 'time' }), NOW))).toEqual([2, 3, 12]);
    expect(ids(applyPmView(all, f({ view: 'all', overdue: 'time' }), NOW))).toEqual(ids(applyPmView(all, f({ view: 'all' }), NOW)));
  });
});

describe('dueKinds', () => {
  it('classifies overdue by reason and due soon by what is close', () => {
    expect(dueKinds(row('overdue', { reason: 'pages' }), NOW)).toEqual(['pages']);
    expect(dueKinds(row('overdue', { reason: 'no_visit_12m' }), NOW)).toEqual(['time']);
    expect(dueKinds(row('due_soon', { pctUsed: 0.9 }), NOW)).toEqual(['pages']);
    expect(dueKinds(row('due_soon', { timeCapDate: new Date('2026-12-01T00:00:00Z') }), NOW)).toEqual(['time']);
    expect(dueKinds(row('due_soon', { pctUsed: 0.9, timeCapDate: new Date('2026-12-01T00:00:00Z') }), NOW)).toEqual(['pages', 'time']);
    expect(dueKinds(row('ok'), NOW)).toEqual([]);
  });
  it('uses the due-soon settings it is given', () => {
    const r = row('due_soon', { pctUsed: 0.8, timeCapDate: new Date('2026-12-20T00:00:00Z') });
    expect(dueKinds(r, NOW)).toEqual([]);
    expect(dueKinds(r, NOW, { dueSoonPct: 0.75, dueSoonDays: 40 })).toEqual(['pages', 'time']);
  });
});

describe('countPm', () => {
  it('counts each view and the overdue split within Due', () => {
    const c = countPm(
      [
        row('overdue', { reason: 'pages' }),
        row('overdue', { reason: 'no_visit_12m' }),
        row('ok'),
        row('held', { pagesSince: 200000 }),
        { ...row('overdue', { reason: 'pages' }), view: 'dismissed' },
        { ...row('booked'), view: 'booked' },
        { ...row('ok'), bookedOverdue: true },
      ],
      NOW,
    );
    expect(c).toEqual({
      due: 4,
      'when-in-area': 0,
      booked: 1,
      dismissed: 1,
      'other-dealer': 0,
      all: 7,
      overdue: 2,
      overdueByPages: 1,
      overdueByTime: 1,
      dueByPages: 2,
      dueByTime: 1,
    });
  });
});

describe('planner tabs', () => {
  const MJ = { dealer: 'MJ Flood', source: 'region' as const, region: 'ireland' as const };
  const wia = (r: PmRow): PmRow => ({ ...r, plan: { ...r.plan, whenInArea: true } });
  const other = (r: PmRow): PmRow => ({ ...r, otherDealer: MJ });
  const rows: PmRow[] = [
    row('overdue', { reason: 'pages' }, 1),
    wia(row('overdue', { reason: 'time_cap', timeCapDate: new Date('2025-05-18T12:00:00Z') }, 2)),
    wia(row('ok', {}, 3)),
    wia({ ...row('booked', {}, 4), view: 'booked' }),
    other(row('overdue', {}, 5)),
    other({ ...row('booked', {}, 6), view: 'booked' }),
    other({ ...row('overdue', {}, 7), view: 'dismissed' }),
    other(row('ok', {}, 8)),
    { ...row('overdue', {}, 9), view: 'dismissed' },
  ];
  const ids = (rs: PmRow[]) => rs.map((r) => r.vantageEquipmentId);
  const tab = (view: PmFilters['view']) => ids(applyPmView(rows, { view, status: 'all', overdue: 'all' }, NOW));

  it('Due excludes a When-in-area machine and other-dealer machines', () => {
    expect(tab('due')).toEqual([1]);
  });

  it('When in area lists flagged machines only while still due, overdue ones included', () => {
    expect(tab('when-in-area')).toEqual([2]);
  });

  it('Other dealer lists other-dealer machines in every state; no other tab shows them', () => {
    expect(tab('other-dealer')).toEqual([5, 6, 7, 8]);
    expect(tab('booked')).toEqual([4]);
    expect(tab('dismissed')).toEqual([9]);
    expect(tab('all')).toEqual([1, 2, 3, 4, 9]);
  });

  it('the status filter still narrows the new tabs', () => {
    expect(ids(applyPmView(rows, { view: 'other-dealer', status: 'ok', overdue: 'all' }, NOW))).toEqual([8]);
  });

  it('Add to plan is offered on Due and When in area rows only', () => {
    expect(rows.filter((r) => canAddToPlan(r, NOW)).map((r) => r.vantageEquipmentId)).toEqual([1, 2]);
  });

  it('countPm counts each tab; the overdue split stays within Due', () => {
    expect(countPm(rows, NOW)).toEqual({
      due: 1,
      'when-in-area': 1,
      booked: 1,
      dismissed: 1,
      'other-dealer': 4,
      all: 5,
      overdue: 1,
      overdueByPages: 1,
      overdueByTime: 0,
      dueByPages: 1,
      dueByTime: 0,
    });
  });
});
