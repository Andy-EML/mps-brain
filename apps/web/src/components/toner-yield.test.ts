import { describe, expect, it } from 'vitest';
import type { CartridgeInterval, YieldCheck } from '@mps/db/queries';
import { avgAchievedText, cartridgeRows, pagesSinceCell, yieldNote } from './toner-yield';

const check = (over: Partial<YieldCheck> = {}): YieldCheck => ({
  colour: 'black',
  lastOrderDate: new Date('2026-10-22T09:00:00Z'),
  pagesSinceLastOrder: 3950,
  pagesSinceEstimated: false,
  pctOfRated: 3950 / 28000,
  ratedYield: 28000,
  early: true,
  stale: false,
  status: 'ok',
  ...over,
});

const cart = (day: string, pagesDone: number | null, quantity = 1): CartridgeInterval => ({
  orderDate: new Date(`${day}T00:00:00Z`),
  anchor: new Date(`${day}T00:00:00Z`),
  salesOrderId: Number(day.replaceAll('-', '')),
  lineId: 1,
  lineIds: [1],
  quantity,
  pagesDone,
  pagesPerCartridge: pagesDone === null ? null : pagesDone / quantity,
});

describe('yieldNote', () => {
  it('gives pages since and the share of the rated yield', () => {
    expect(yieldNote(check())).toEqual({
      text: 'Last ordered 22 Oct 2026 · 3,950 pages since (14% of 28,000)',
      early: true,
      stale: false,
    });
  });

  it('gives the pages alone when no rated yield is entered', () => {
    const n = yieldNote(check({ ratedYield: null, pctOfRated: null, early: null, status: 'no_rated_yield' }));
    expect(n.text).toBe('Last ordered 22 Oct 2026 · 3,950 pages since · no rated yield');
    expect(n.early).toBe(false);
  });

  it('says when the meter history cannot cover the order, and when meters are stale', () => {
    expect(yieldNote(check({ pagesSinceLastOrder: null, pctOfRated: null, early: null, stale: true })).text).toBe(
      'Last ordered 22 Oct 2026 · not enough meter history · stale meters',
    );
  });

  it('marks an estimated count with "~"', () => {
    expect(yieldNote(check({ pagesSinceEstimated: true })).text).toBe(
      'Last ordered 22 Oct 2026 · ~3,950 pages since (14% of 28,000)',
    );
    expect(
      yieldNote(check({ pagesSinceEstimated: true, ratedYield: null, pctOfRated: null, early: null, status: 'no_rated_yield' })).text,
    ).toBe('Last ordered 22 Oct 2026 · ~3,950 pages since · no rated yield');
  });

  it('says there is no earlier order', () => {
    expect(yieldNote(check({ lastOrderDate: null, pagesSinceLastOrder: null, pctOfRated: null, early: false })).text).toBe(
      'No earlier order on record',
    );
  });
});

describe('avgAchievedText / pagesSinceCell', () => {
  it('explains a missing average', () => {
    expect(avgAchievedText({ avgAchieved: null, avgPctOfRated: null, cartridges: [] })).toBe('No orders on record');
    expect(avgAchievedText({ avgAchieved: null, avgPctOfRated: null, cartridges: [cart('2026-10-01', null)] })).toBe('Needs a second order');
    expect(
      avgAchievedText({ avgAchieved: null, avgPctOfRated: null, cartridges: [cart('2026-09-01', null), cart('2026-10-01', null)] }),
    ).toBe('Not enough meter history');
  });

  it('shows the average with and without a rated yield', () => {
    expect(avgAchievedText({ avgAchieved: 21400.4, avgPctOfRated: 0.764, cartridges: [] })).toBe('21,400 (76% of rated)');
    expect(avgAchievedText({ avgAchieved: 21400, avgPctOfRated: null, cartridges: [] })).toBe('21,400');
  });

  it('shows pages since, or why not', () => {
    expect(pagesSinceCell({ lastOrderDate: null, pagesSinceLastOrder: null, pagesSinceEstimated: false, pctOfRatedSinceLastOrder: null })).toBe('—');
    expect(pagesSinceCell({ lastOrderDate: new Date(), pagesSinceLastOrder: null, pagesSinceEstimated: false, pctOfRatedSinceLastOrder: null })).toBe(
      'Not enough meter history',
    );
    expect(pagesSinceCell({ lastOrderDate: new Date(), pagesSinceLastOrder: 3950, pagesSinceEstimated: false, pctOfRatedSinceLastOrder: 0.141 })).toBe('3,950 (14%)');
    expect(pagesSinceCell({ lastOrderDate: new Date(), pagesSinceLastOrder: 3950, pagesSinceEstimated: true, pctOfRatedSinceLastOrder: 0.141 })).toBe('~3,950 (14%)');
  });
});

describe('cartridgeRows', () => {
  it('lists newest first, the newest in use, unmeasured ones explained', () => {
    const rows = cartridgeRows({
      cartridges: [cart('2026-08-01', null), cart('2026-09-01', 9000, 2), cart('2026-10-01', null)],
      pagesSinceLastOrder: 1200,
      pagesSinceEstimated: false,
    });
    expect(rows.map((r) => [r.pagesText, r.perCartridgeText, r.inUse])).toEqual([
      ['In use · 1,200 so far', '—', true],
      ['9,000', '4,500', false],
      ['Not enough meter history', '—', false],
    ]);
  });

  it('marks an estimated in-use count with "~"', () => {
    const [row] = cartridgeRows({ cartridges: [cart('2026-10-01', null)], pagesSinceLastOrder: 1200, pagesSinceEstimated: true });
    expect(row?.pagesText).toBe('In use · ~1,200 so far');
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => cart(`2026-0${(i % 9) + 1}-${String(i + 10)}`, 1000));
    expect(cartridgeRows({ cartridges: many, pagesSinceLastOrder: null, pagesSinceEstimated: false }, 8)).toHaveLength(8);
  });
});
