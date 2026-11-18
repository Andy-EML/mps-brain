import { describe, expect, it } from 'vitest';
import type { PmResult, PmRow, PmStatus } from '@mps/db/queries';
import { inDefaultView } from '@mps/db/queries';
import { applyPmView, countPm, dueKinds, inPmView, parsePmFilters, type PmFilters } from './filters';

const NOW = new Date('2026-11-18T12:00:00Z');

const row = (status: PmStatus, over: Partial<PmResult> = {}, id = 1): PmRow => ({
  vantageEquipmentId: id,
  drmsEquipmentId: null,
  customerName: 'Acme',
  town: null,
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

  it('defaults to the Due view, any status, with nothing else set', () => {
    expect(parsePmFilters({})).toEqual({ view: 'due', status: 'all', customer: undefined, family: undefined, q: undefined, overdue: 'all' });
  });

  it('reads status, customer, family, search and overdue reason', () => {
    expect(parsePmFilters({ status: 'overdue', customer: ' Acme ', family: '7', search: ' c300 ', overdue: 'time' })).toEqual({
      view: 'due',
      status: 'overdue',
      customer: 'Acme',
      family: 7,
      q: 'c300',
      overdue: 'time',
    });
  });

  it('accepts q as the search param too', () => {
    expect(parsePmFilters({ q: 'abc' }).q).toBe('abc');
  });

  it('reads URLSearchParams the same way', () => {
    expect(parsePmFilters(new URLSearchParams('view=all&status=ok&family=3&overdue=pages'))).toMatchObject({
      view: 'all',
      status: 'ok',
      family: 3,
      overdue: 'pages',
    });
  });

  it('takes the first of repeated params', () => {
    expect(parsePmFilters({ status: ['held', 'ok'] }).status).toBe('held');
  });

  it('ignores junk', () => {
    expect(parsePmFilters({ status: 'bogus', family: 'x', overdue: 'never', customer: '  ' })).toEqual({
      view: 'due',
      status: 'all',
      customer: undefined,
      family: undefined,
      q: undefined,
      overdue: 'all',
    });
    expect(parsePmFilters({ family: '-2' }).family).toBeUndefined();
    expect(parsePmFilters({ family: '2.5' }).family).toBeUndefined();
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
  const f = (over: Partial<Pick<PmFilters, 'view' | 'status' | 'overdue'>>) => ({ view: 'due' as const, status: 'all' as const, overdue: 'all' as const, ...over });

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
    expect(c).toEqual({ due: 4, booked: 1, dismissed: 1, all: 7, overdue: 2, overdueByPages: 1, overdueByTime: 1, dueByPages: 2, dueByTime: 1 });
  });
});
