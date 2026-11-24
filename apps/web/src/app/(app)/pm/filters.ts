import { DEFAULT_PM_SETTINGS, inPmView, type PmRow, type PmSettings, type PmStatus } from '@mps/db/queries';
// Relative, not `@/`: vitest has no path alias.
import { PM_STATUSES } from '../../../lib/pm-statuses';
import { applyPmFacets, parsePmFacets, type PmFacetSelection } from '../../../lib/pm-facets';
import { overdueKind } from '../../../components/pm-status';

/**
 * The `/pm` page's search params, shared with its CSV export. `view` is the tab — Due (the
 * default), When in area, Booked, Dismissed, Other dealer or All; the side-panel facets (town,
 * county, status, family, customer — repeatable) narrow within it. Old single-value `status`,
 * `family` and `customer` links are read as one-value facets.
 */

export const PM_VIEWS = ['due', 'booked', 'dismissed', 'when-in-area', 'other-dealer', 'all'] as const;
export { PM_STATUSES };
export const OVERDUE_FILTERS = ['all', 'pages', 'time'] as const;
/** Town group order: worst first (the default) or A–Z. */
export const TOWN_SORTS = ['worst', 'az'] as const;
export type TownSort = (typeof TOWN_SORTS)[number];

export type PmViewFilter = (typeof PM_VIEWS)[number];
export type PmStatusFilter = PmStatus | 'all';
export type OverdueFilter = (typeof OVERDUE_FILTERS)[number];

export interface PmFilters {
  view: PmViewFilter;
  q: string | undefined;
  /** Narrows overdue rows by reason; other statuses are left alone. */
  overdue: OverdueFilter;
  /** Side-panel facets: OR within one, AND across them. */
  facets: PmFacetSelection;
  /** `townSort=az` orders the town groups by name. */
  townSort: TownSort;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function get(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

const text = (v: string | undefined): string | undefined => v?.trim() || undefined;

export function parsePmFilters(params: Params): PmFilters {
  const view = get(params, 'view');
  const overdue = get(params, 'overdue');
  return {
    view: PM_VIEWS.includes(view as PmViewFilter) ? (view as PmViewFilter) : 'due',
    // The shared SearchInput submits `search`; `q` is accepted too.
    q: text(get(params, 'search')) ?? text(get(params, 'q')),
    overdue: OVERDUE_FILTERS.includes(overdue as OverdueFilter) ? (overdue as OverdueFilter) : 'all',
    facets: parsePmFacets(params),
    townSort: get(params, 'townSort') === 'az' ? 'az' : 'worst',
  };
}

// The tab rule lives in @mps/db (`inPmView`, also used by `listPmDue`); re-exported for the page.
export { inPmView };

/** Machines another dealer services for PM: only the Other dealer tab shows them. */
const isOther = (r: PmRow): boolean => r.otherDealer.dealer !== null;

/**
 * Whether a row belongs to a `/pm` tab. Rows are loaded with `dealer: 'all'`. Due is ours, needing
 * PM (`inPmView` due) and not set to When in area; When in area is ours, flagged and still due (it
 * never drops back to Due on its own); Booked, Dismissed and All are ours as `inPmView` says; Other
 * dealer is every other-dealer machine whatever its state.
 */
export function inPmTab(r: PmRow, view: PmViewFilter, now: Date): boolean {
  if (view === 'other-dealer') return isOther(r);
  if (isOther(r)) return false;
  if (view === 'due') return !r.plan.whenInArea && inPmView(r, 'due', now);
  if (view === 'when-in-area') return r.plan.whenInArea && inPmView(r, 'due', now);
  return inPmView(r, view, now);
}

/** Add to plan is offered on Due and When in area rows only (not Booked, Dismissed or other-dealer ones). */
export function canAddToPlan(r: PmRow, now: Date): boolean {
  return inPmTab(r, 'due', now) || inPmTab(r, 'when-in-area', now);
}

/** The tab a row is found in when it is not in the current one (All when no narrower tab has it). */
export function tabOf(r: PmRow, now: Date): PmViewFilter {
  return (['due', 'when-in-area', 'booked', 'dismissed', 'other-dealer'] as const).find((v) => inPmTab(r, v, now)) ?? 'all';
}

export type DueKind = 'pages' | 'time';
export type DueSoonSettings = Pick<PmSettings, 'dueSoonPct' | 'dueSoonDays'>;
const DAY_MS = 86_400_000;

/**
 * Why a Due-tab row needs PM, for the "Due by pages" / "Due by time" chips. Overdue follows its
 * reason (`pages` is pages; `time_cap` and `no_visit_12m` are time). Due soon is by pages when the
 * interval is `dueSoonPct` used or the estimated due date is within `dueSoonDays`, and by time when
 * the time cap is within `dueSoonDays`. A held machine in the list is past its interval or its cap.
 * A row can be both; a row that is neither (a booking that went unseen) is in no chip.
 */
export function dueKinds(r: PmRow, now: Date, soon: DueSoonSettings = DEFAULT_PM_SETTINGS): DueKind[] {
  const { status, reason, pctUsed, pagesSince, estDueDate, timeCapDate } = r.result;
  const nowMs = now.getTime();
  const within = (d: Date | null) => d !== null && d.getTime() - nowMs <= soon.dueSoonDays * DAY_MS;
  let pages = false;
  let time = false;
  if (status === 'overdue') {
    const kind = overdueKind(reason);
    pages = kind === 'pages';
    time = kind === 'time';
  } else if (status === 'due_soon') {
    pages = (pctUsed !== null && pctUsed >= soon.dueSoonPct) || within(estDueDate);
    time = within(timeCapDate);
  } else if (status === 'held') {
    pages = pagesSince !== null && pagesSince >= r.intervalPages;
    time = timeCapDate !== null && nowMs >= timeCapDate.getTime();
  }
  return [...(pages ? (['pages'] as const) : []), ...(time ? (['time'] as const) : [])];
}

/**
 * The rows a view + due-reason selection shows (and one status, when given), in the order given.
 * The reason (`overdue` param: pages / time) narrows the Due tab only. The page's facets are
 * applied after this (`selectPmRows`), so their counts can be worked out from these rows.
 */
export function applyPmView(
  rows: PmRow[],
  f: Pick<PmFilters, 'view' | 'overdue'> & { status?: PmStatusFilter },
  now: Date,
  soon: DueSoonSettings = DEFAULT_PM_SETTINGS,
): PmRow[] {
  return rows.filter((r) => {
    if (!inPmTab(r, f.view, now)) return false;
    if (f.status !== undefined && f.status !== 'all' && r.result.status !== f.status) return false;
    if (f.overdue !== 'all' && f.view === 'due' && !dueKinds(r, now, soon).includes(f.overdue)) return false;
    return true;
  });
}

/** The rows the page lists and the CSV exports: tab, due reason, then every facet. */
export function selectPmRows(
  rows: PmRow[],
  f: Pick<PmFilters, 'view' | 'overdue' | 'facets'>,
  now: Date,
  soon: DueSoonSettings = DEFAULT_PM_SETTINGS,
): PmRow[] {
  return applyPmFacets(applyPmView(rows, f, now, soon), f.facets);
}

export type PmCounts = Record<
  PmViewFilter | 'overdue' | 'overdueByPages' | 'overdueByTime' | 'dueByPages' | 'dueByTime',
  number
>;

/** Tab counts over rows already loaded (search applied, facets not); the overdue and due-by-reason splits are within Due. */
export function countPm(rows: PmRow[], now: Date, soon: DueSoonSettings = DEFAULT_PM_SETTINGS): PmCounts {
  const c: PmCounts = {
    due: 0,
    'when-in-area': 0,
    booked: 0,
    dismissed: 0,
    'other-dealer': 0,
    all: 0,
    overdue: 0,
    overdueByPages: 0,
    overdueByTime: 0,
    dueByPages: 0,
    dueByTime: 0,
  };
  for (const r of rows) {
    if (isOther(r)) {
      c['other-dealer'] += 1;
      continue;
    }
    c.all += 1;
    if (inPmTab(r, 'when-in-area', now)) c['when-in-area'] += 1;
    else if (inPmTab(r, 'due', now)) {
      c.due += 1;
      const kinds = dueKinds(r, now, soon);
      if (kinds.includes('pages')) c.dueByPages += 1;
      if (kinds.includes('time')) c.dueByTime += 1;
      if (r.result.status === 'overdue') {
        c.overdue += 1;
        const kind = overdueKind(r.result.reason);
        if (kind === 'pages') c.overdueByPages += 1;
        else if (kind === 'time') c.overdueByTime += 1;
      }
    } else if (r.view === 'booked') c.booked += 1;
    else if (r.view === 'dismissed') c.dismissed += 1;
  }
  return c;
}
