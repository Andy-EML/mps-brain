import { hrefWith } from './href';

export const ROWS_OPTIONS = [10, 20, 50, 100, 200] as const;
export type SortDir = 'asc' | 'desc';
export interface ListState<K extends string> {
  page: number;
  rows: number;
  sort: K | null;
  dir: SortDir;
}

const MAX_PAGE = 1_000_000;

/** One cookie per list, so a rows choice on one screen never leaks to another. */
export function rowsCookieName(listKey: string): string {
  return `lc_rows_${listKey}`;
}

function validRows(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return (ROWS_OPTIONS as readonly number[]).includes(n) ? n : null;
}

/** Read list state from URL params; every invalid value falls back silently. */
export function parseListState<K extends string>(
  get: (name: string) => string | undefined,
  opts: { listKey: string; defaultRows: number; sortKeys: readonly K[]; cookieRows?: string | undefined },
): ListState<K> {
  const pageNum = Math.floor(Number(get('page')));
  const page = pageNum >= 1 ? Math.min(pageNum, MAX_PAGE) : 1;
  const rows = validRows(get('rows')) ?? validRows(opts.cookieRows) ?? opts.defaultRows;
  const rawSort = get('sort');
  const sort = rawSort !== undefined ? (opts.sortKeys.find((k) => k === rawSort) ?? null) : null;
  const dir: SortDir = get('dir') === 'desc' ? 'desc' : 'asc';
  return { page, rows, sort, dir };
}

/** URL for this list with state overrides; drops page when rows/sort change; omits defaults. */
export function listHref<K extends string>(
  basePath: string,
  keep: Record<string, string | number | null | undefined>,
  state: ListState<K>,
  change: Partial<ListState<K>>,
  opts: { defaultRows: number },
): string {
  const next = { ...state, ...change };
  const resets = 'rows' in change || 'sort' in change || 'dir' in change;
  return hrefWith(basePath, {
    ...keep,
    ...stateParams(next, opts),
    page: !resets && next.page > 1 ? next.page : undefined,
  });
}

/**
 * The sort/dir/rows query params for a state (no page), as `listHref` writes them: defaults left
 * out. For links that change something else (a tab, a filter, a search) but keep the ordering and
 * page size, and for forms that post the view to a server action.
 */
export function stateParams<K extends string>(
  state: ListState<K>,
  opts: { defaultRows: number },
): { sort?: string; dir?: string; rows?: string } {
  const out: { sort?: string; dir?: string; rows?: string } = {};
  if (state.sort) {
    out.sort = state.sort;
    if (state.dir === 'desc') out.dir = 'desc';
  }
  if (state.rows !== opts.defaultRows) out.rows = String(state.rows);
  return out;
}

/** The query option for a state: `{ key, dir }` when a sort is chosen, else undefined (default order). */
export function sortSpec<K extends string>(state: ListState<K>): { key: K; dir: SortDir } | undefined {
  return state.sort ? { key: state.sort, dir: state.dir } : undefined;
}

/**
 * `state` with its sort dropped (back to the view's default order) when the current view does not
 * show that column — a sort carried over from another tab of the same list.
 */
export function keepSort<K extends string>(state: ListState<K>, shown: readonly K[]): ListState<K> {
  return state.sort === null || shown.includes(state.sort) ? state : { ...state, sort: null, dir: 'asc' };
}

/** The last page for `total` rows at `rows` per page; 1 for an empty list. */
export function lastPageOf(total: number, rows: number): number {
  return Math.max(1, Math.ceil(total / rows));
}

/** Up to `size` page numbers centred on the current page, clamped to 1..lastPage. */
export function pageWindow(page: number, lastPage: number, size = 5): number[] {
  const count = Math.min(size, Math.max(1, lastPage));
  let start = page - Math.floor(count / 2);
  start = Math.max(1, Math.min(start, lastPage - count + 1));
  return Array.from({ length: count }, (_, i) => start + i);
}

/** First click on a column sorts ascending; clicking the active column flips direction. */
export function nextSort<K extends string>(state: ListState<K>, key: K): { sort: K; dir: SortDir } {
  if (state.sort === key) return { sort: key, dir: state.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: key, dir: 'asc' };
}
