import { describe, expect, it } from 'vitest';
import { listHref, parseListState, type ListState } from './list-state';
import { ORDERS_DEFAULT_ROWS, PM_DEFAULT_ROWS, ordersKeep, pmKeep, queueDefaultSort } from './list-keep';
import { decisionBackPath } from '../components/replenishment';

/** Review Focus 4: accordion lists keep their open row (PM) and their tab (Toner orders) when paging or sorting. */
describe('PM list links keep the open row', () => {
  const keep = pmKeep({ view: 'booked', customer: 'Acme', search: undefined }, 123);
  const state: ListState<string> = { page: 2, rows: 20, sort: 'pct', dir: 'desc' };

  it('keeps open and the filters on page links', () => {
    const href = listHref('/pm', keep, state, { page: 3 }, { defaultRows: PM_DEFAULT_ROWS });
    const q = new URL(href, 'http://x').searchParams;
    expect(q.get('open')).toBe('123');
    expect(q.get('view')).toBe('booked');
    expect(q.get('customer')).toBe('Acme');
    expect(q.get('page')).toBe('3');
    expect(q.get('sort')).toBe('pct');
    expect(q.get('dir')).toBe('desc');
    expect(q.get('rows')).toBe('20');
  });

  it('keeps open on sort and rows links, which drop the page', () => {
    for (const change of [{ sort: 'serial', dir: 'asc' as const }, { rows: 50 }]) {
      const q = new URL(listHref('/pm', keep, state, change, { defaultRows: PM_DEFAULT_ROWS }), 'http://x').searchParams;
      expect(q.get('open')).toBe('123');
      expect(q.get('view')).toBe('booked');
      expect(q.has('page')).toBe(false);
    }
  });

  it('leaves open off when no row is open', () => {
    expect(listHref('/pm', pmKeep({ view: undefined }, null), state, { page: 1 }, { defaultRows: PM_DEFAULT_ROWS })).toBe(
      '/pm?sort=pct&dir=desc&rows=20',
    );
  });
});

describe('Toner order links keep the tab', () => {
  const state = parseListState((n) => ({ sort: 'customer', page: '2' })[n], {
    listKey: 'orders',
    defaultRows: ORDERS_DEFAULT_ROWS,
    sortKeys: ['urgency', 'recent', 'customer', 'device'] as const,
  });

  it('keeps tab on page, sort and rows links', () => {
    const keep = ordersKeep('on-site');
    expect(listHref('/orders', keep, state, { page: 3 }, { defaultRows: ORDERS_DEFAULT_ROWS })).toBe(
      '/orders?tab=on-site&sort=customer&page=3',
    );
    expect(listHref('/orders', keep, state, { sort: 'device', dir: 'asc' }, { defaultRows: ORDERS_DEFAULT_ROWS })).toBe(
      '/orders?tab=on-site&sort=device',
    );
    expect(listHref('/orders', keep, state, { rows: 20 }, { defaultRows: ORDERS_DEFAULT_ROWS })).toBe(
      '/orders?tab=on-site&sort=customer&rows=20',
    );
  });

  it('leaves the default Review tab off the URL', () => {
    expect(ordersKeep('review')).toEqual({ tab: undefined });
  });

  it('each tab defaults to today’s order', () => {
    expect(queueDefaultSort('review')).toBe('urgency');
    expect(queueDefaultSort('on-site')).toBe('urgency');
    expect(queueDefaultSort('in-progress')).toBe('recent');
    expect(queueDefaultSort('ordered')).toBe('recent');
    expect(queueDefaultSort('rejected')).toBe('recent');
  });
});

describe('decisionBackPath with the list URL', () => {
  it('returns a refused decision to the same tab, page and sort', () => {
    expect(decisionBackPath('/orders?tab=on-site&sort=customer&page=2', 'd1')).toBe('/orders?tab=on-site&sort=customer&page=2');
  });

  it('drops a stale error so the new one is the only one', () => {
    expect(decisionBackPath('/orders?tab=on-site&error=stale', 'd1')).toBe('/orders?tab=on-site');
    expect(decisionBackPath('/orders?error=stale', 'd1')).toBe('/orders');
  });

  it('refuses anything that is not the orders list', () => {
    expect(decisionBackPath('//evil.example/orders', 'd1')).toBe('/orders');
    expect(decisionBackPath('/devices?tab=x', 'd1')).toBe('/orders');
    expect(decisionBackPath('https://evil.example/orders', 'd1')).toBe('/orders');
  });
});
