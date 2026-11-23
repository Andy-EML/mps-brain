import { describe, expect, it } from 'vitest';
import {
  keepSort,
  lastPageOf,
  listHref,
  nextSort,
  pageWindow,
  parseListState,
  rowsCookieName,
  sortSpec,
  stateParams,
  type ListState,
} from './list-state';

const KEYS = ['model', 'customer'] as const;
function parse(q: Record<string, string>, cookieRows?: string, defaultRows = 50) {
  return parseListState((n) => q[n], { listKey: 'devices', defaultRows, sortKeys: KEYS, cookieRows });
}

describe('parseListState rows', () => {
  it('URL beats cookie beats default', () => {
    expect(parse({ rows: '20' }, '100').rows).toBe(20);
    expect(parse({}, '100').rows).toBe(100);
    expect(parse({}).rows).toBe(50);
  });
  it('invalid URL rows fall back to cookie/default', () => {
    expect(parse({ rows: '999' }, '100').rows).toBe(100);
    expect(parse({ rows: 'abc' }).rows).toBe(50);
    expect(parse({ rows: '999' }).rows).toBe(50);
  });
  it('invalid cookie falls back to default', () => {
    expect(parse({}, '7').rows).toBe(50);
    expect(parse({}, 'x').rows).toBe(50);
  });
});

describe('parseListState page', () => {
  it('normalises page', () => {
    expect(parse({ page: '0' }).page).toBe(1);
    expect(parse({ page: '-3' }).page).toBe(1);
    expect(parse({ page: 'abc' }).page).toBe(1);
    expect(parse({ page: '2.7' }).page).toBe(2);
    expect(parse({}).page).toBe(1);
    expect(parse({ page: '99999999999' }).page).toBe(1_000_000);
  });
});

describe('parseListState sort/dir', () => {
  it('accepts only known sort keys', () => {
    expect(parse({ sort: 'model' }).sort).toBe('model');
    expect(parse({ sort: '__proto__' }).sort).toBeNull();
    expect(parse({ sort: 'nope' }).sort).toBeNull();
    expect(parse({}).sort).toBeNull();
  });
  it('dir is desc only when asked', () => {
    expect(parse({ dir: 'desc' }).dir).toBe('desc');
    expect(parse({ dir: 'DESC' }).dir).toBe('asc');
    expect(parse({ dir: 'up' }).dir).toBe('asc');
    expect(parse({}).dir).toBe('asc');
  });
});

describe('rowsCookieName', () => {
  it('is per list', () => {
    expect(rowsCookieName('devices')).toBe('lc_rows_devices');
    expect(rowsCookieName('customers')).not.toBe(rowsCookieName('devices'));
  });
});

describe('listHref', () => {
  const base: ListState<string> = { page: 3, rows: 50, sort: 'model', dir: 'desc' };
  const o = { defaultRows: 50 };
  it('changing page keeps sort and keep params', () => {
    expect(listHref('/devices', { q: 'a b', filter: null }, base, { page: 4 }, o)).toBe(
      '/devices?q=a+b&sort=model&dir=desc&page=4',
    );
  });
  it('drops page when rows change; omits default rows', () => {
    expect(listHref('/devices', {}, base, { rows: 50 }, o)).toBe('/devices?sort=model&dir=desc');
    expect(listHref('/devices', {}, base, { rows: 20 }, o)).toBe('/devices?sort=model&dir=desc&rows=20');
  });
  it('drops page when sort changes; omits dir=asc', () => {
    expect(listHref('/devices', {}, base, { sort: 'customer', dir: 'asc' }, o)).toBe('/devices?sort=customer');
  });
  it('page 1 is omitted; no sort omits dir', () => {
    const s: ListState<string> = { page: 1, rows: 100, sort: null, dir: 'desc' };
    expect(listHref('/x', {}, s, { page: 1 }, o)).toBe('/x?rows=100');
  });
});

describe('pageWindow', () => {
  it('windows', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(10, 20)).toEqual([8, 9, 10, 11, 12]);
    expect(pageWindow(20, 20)).toEqual([16, 17, 18, 19, 20]);
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(1, 1)).toEqual([1]);
  });
});

describe('nextSort', () => {
  const s = (sort: string | null, dir: 'asc' | 'desc'): ListState<string> => ({ page: 1, rows: 50, sort, dir });
  it('toggles', () => {
    expect(nextSort(s(null, 'asc'), 'model')).toEqual({ sort: 'model', dir: 'asc' });
    expect(nextSort(s('customer', 'desc'), 'model')).toEqual({ sort: 'model', dir: 'asc' });
    expect(nextSort(s('model', 'asc'), 'model')).toEqual({ sort: 'model', dir: 'desc' });
    expect(nextSort(s('model', 'desc'), 'model')).toEqual({ sort: 'model', dir: 'asc' });
  });
});

describe('stateParams', () => {
  it('omits defaults and page', () => {
    expect(stateParams({ page: 3, rows: 50, sort: null, dir: 'asc' }, { defaultRows: 50 })).toEqual({});
  });
  it('writes sort, desc dir and non-default rows', () => {
    expect(stateParams({ page: 3, rows: 20, sort: 'model', dir: 'desc' }, { defaultRows: 50 })).toEqual({
      sort: 'model',
      dir: 'desc',
      rows: '20',
    });
    expect(stateParams({ page: 1, rows: 50, sort: 'model', dir: 'asc' }, { defaultRows: 50 })).toEqual({ sort: 'model' });
  });
  it('never writes dir without a sort', () => {
    expect(stateParams({ page: 1, rows: 50, sort: null, dir: 'desc' }, { defaultRows: 50 })).toEqual({});
  });
});

describe('sortSpec', () => {
  it('is undefined with no sort, else key + dir', () => {
    expect(sortSpec({ page: 1, rows: 50, sort: null, dir: 'desc' })).toBeUndefined();
    expect(sortSpec({ page: 1, rows: 50, sort: 'model', dir: 'desc' })).toEqual({ key: 'model', dir: 'desc' });
  });
});

describe('lastPageOf', () => {
  it('is at least 1 and rounds up', () => {
    expect(lastPageOf(0, 50)).toBe(1);
    expect(lastPageOf(50, 50)).toBe(1);
    expect(lastPageOf(51, 50)).toBe(2);
    expect(lastPageOf(1000, 200)).toBe(5);
  });
});

describe('page past the end (Review Focus 1)', () => {
  it('a huge page parses, and the redirect target is the last page with state kept', () => {
    const state = parse({ page: '99999', rows: '20', sort: 'model', dir: 'desc' });
    const last = lastPageOf(45, state.rows);
    expect(state.page > last).toBe(true);
    expect(listHref('/devices', { filter: 'manual' }, state, { page: last }, { defaultRows: 50 })).toBe(
      '/devices?filter=manual&sort=model&dir=desc&rows=20&page=3',
    );
  });
  it('odd params never throw', () => {
    expect(() => parse({ rows: '999', page: '0', sort: '__proto__', dir: 'sideways' })).not.toThrow();
    expect(parse({ rows: 'abc', sort: 'constructor' })).toEqual({ page: 1, rows: 50, sort: null, dir: 'asc' });
  });
});

describe('keepSort', () => {
  const state = { page: 2, rows: 50, sort: 'decided' as const, dir: 'desc' as const };
  it('keeps a sort the view shows', () => {
    expect(keepSort(state, ['machine', 'decided'])).toBe(state);
  });
  it('drops a sort the view does not show, keeping the rest of the state', () => {
    expect(keepSort(state, ['machine', 'created'])).toEqual({ page: 2, rows: 50, sort: null, dir: 'asc' });
  });
  it('leaves no sort alone', () => {
    const none = { ...state, sort: null };
    expect(keepSort(none, ['machine'])).toBe(none);
  });
});
