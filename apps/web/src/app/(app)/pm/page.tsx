import { Fragment } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Download, Info } from 'lucide-react';
import { cn } from 'cn';
import { PM_SORT_KEYS, getPlannerSettings, getPmSettings, listFamilies, listPmDue, londonDay, overdueMonths, type PmRow, type PmSettings } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { ListControls } from '@/components/list-controls';
import { PM_VISIT_ROWS } from '@/components/pm-detail';
import { PmFacetPanel, type PmFacetGroup } from '@/components/pm-facet-panel';
import { PmFilterChips, type PmFilterChip } from '@/components/pm-filter-chips';
import { PmRow as PmTableRow } from '@/components/pm-row';
import { statusLabel } from '@/components/pm-status';
import { SearchInput } from '@/components/search-input';
import { SortHeader } from '@/components/sort-header';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber } from '@/lib/format';
import { hrefWith, type QueryParams } from '@/lib/href';
import { PM_DEFAULT_ROWS, pmKeep } from '@/lib/list-keep';
import { lastPageOf, listHref, parseListState, PM_ROWS_OPTIONS, rowsCookieName, sortSpec, stateParams } from '@/lib/list-state';
import { pmErrorMessage } from '@/lib/pm-action-form';
import {
  PM_FACETS,
  applyPmFacets,
  facetKey,
  facetOptions,
  groupByTown,
  pageTownGroups,
  townHeader,
  type PmFacet,
  type PmFacetSelection,
} from '@/lib/pm-facets';
import {
  PM_STATUSES,
  applyPmView,
  canAddToPlan,
  countPm,
  parsePmFilters,
  selectPmRows,
  tabOf,
  type PmFilters,
  type PmViewFilter,
  type TownSort,
} from './filters';

export const metadata = { title: 'PM due · MPS Dashboard' };

const LIST_KEY = 'pm';
const DEFAULT_ROWS = PM_DEFAULT_ROWS;
/** Columns in the collapsed row (`PmRow`), the narrow Plan cell included. */
const COLUMNS = 8;

/** Header cell; the two long labels may wrap to two lines so the row fits without sideways scroll. */
const HEAD_WRAP = 'px-2 py-2.5 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const HEAD = `${HEAD_WRAP} whitespace-nowrap`;

const FACET_TITLE: Record<PmFacet, string> = {
  town: 'Town',
  county: 'County',
  status: 'Status',
  family: 'Model family',
  customer: 'Customer',
};
const TOWN_SORT_LABEL: Record<TownSort, string> = { worst: 'Worst first', az: 'A–Z' };
/**
 * The facets the side panel offers. Model family is left out (not wanted); an old `family=` link
 * still filters and shows a removable chip.
 */
const PANEL_FACETS = ['town', 'county', 'status', 'customer'] as const satisfies readonly PmFacet[];
const NO_FACETS: PmFacetSelection = { town: [], county: [], status: [], family: [], customer: [] };

const VIEW_LABEL: Record<PmViewFilter, string> = {
  due: 'Due',
  'when-in-area': 'When in area',
  booked: 'Booked',
  dismissed: 'Dismissed',
  'other-dealer': 'Other dealer',
  all: 'All',
};
/** Tab order on the page. */
const TABS = ['due', 'when-in-area', 'booked', 'dismissed', 'other-dealer', 'all'] as const satisfies readonly PmViewFilter[];

/** The URL params for a set of filters, defaults left off; each facet repeats its param. */
function filterParams(f: PmFilters): QueryParams {
  return {
    view: f.view === 'due' ? undefined : f.view,
    search: f.q,
    overdue: f.overdue === 'all' ? undefined : f.overdue,
    townSort: f.townSort === 'worst' ? undefined : f.townSort,
    ...f.facets,
  };
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * `/pm`: machines on an active contract with their meter-driven preventive-maintenance state, as
 * accordion rows in six tabs (Due, When in area, Booked, Dismissed, Other dealer, All), grouped by
 * town. Mark booked / Dismiss / Undo and the planner flags (Priority, When in area, Add to plan, Mark
 * as ours) are recorded in this app only — nothing is written to Vantage. Every row of every dealer is
 * loaded once (search applied) so the tabs can count them; the tab, overdue reason and the side-panel
 * facets (town, county, status, family, customer) are applied here, each facet counted with the
 * others applied.
 */
export default async function PmDuePage({ searchParams }: PageProps<'/pm'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;
  const filters = parsePmFilters(params);
  const cookieStore = await cookies();
  const state = parseListState((name) => first(params[name]), {
    listKey: LIST_KEY,
    defaultRows: DEFAULT_ROWS,
    sortKeys: PM_SORT_KEYS,
    cookieRows: cookieStore.get(rowsCookieName(LIST_KEY))?.value,
    rowsOptions: PM_ROWS_OPTIONS,
  });
  const page = state.page;
  const openRaw = first(params.open);
  const openId = openRaw && /^\d{1,10}$/.test(openRaw) ? Number(openRaw) : null;
  const pmError = first(params.pmError);

  const db = getDb();
  const now = new Date();
  const [all, settings, families, planner] = await Promise.all([
    // view and dealer 'all' explicitly: the tabs (incl. Other dealer) are counted and applied here.
    // Customer and family are facets, applied in memory so their counts see every row.
    listPmDue(db, now, { view: 'all', dealer: 'all', q: filters.q, sort: sortSpec(state) }),
    getPmSettings(db),
    listFamilies(db),
    getPlannerSettings(db),
  ]);
  // The region dealers, suggested when a row is marked Other dealer from its menu.
  const dealerSuggestions = [...new Set(Object.values(planner.regionDealers).filter((d): d is string => !!d))];
  // Tab counts follow the search box, not the facets.
  const counts = countPm(all, now, settings);
  // The tab and due reason; the facets are counted over these and then applied.
  const inTab = applyPmView(all, filters, now, settings);
  const rows = applyPmFacets(inTab, filters.facets);
  const groups = groupByTown(rows, filters.townSort);
  // The machines in the order the page shows them, groups flattened.
  const ordered = groups.flatMap((g) => g.rows);
  const base = filterParams(filters);
  const today = londonDay(now);

  // Pager, rows picker and sort headers keep the filters and the open row (Review Focus 4).
  const keep = pmKeep(base, openId);
  const lastPage = lastPageOf(rows.length, state.rows);
  if (page > lastPage) redirect(listHref('/pm', keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  // Page size counts machines; a town split across pages repeats its header.
  const slices = pageTownGroups(groups, page, state.rows);
  const shown = slices.flatMap((sl) => sl.rows);
  // Sort and page size survive a change of tab, filter or search; the page does not.
  const listParams = stateParams(state, { defaultRows: DEFAULT_ROWS });
  const sorting = { basePath: '/pm', keep, state, defaultRows: DEFAULT_ROWS };
  const controls = { ...sorting, total: rows.length, listKey: LIST_KEY, noun: 'machine', rowsOptions: PM_ROWS_OPTIONS };

  // This view's own URL without the open row (the actions add it): forms post it back, the device
  // page's Back link returns to it.
  const back = listHref('/pm', base, state, {}, { defaultRows: DEFAULT_ROWS });
  const moved =
    openId !== null && !shown.some((r) => r.vantageEquipmentId === openId)
      ? movedTo(all, ordered, openId, filters, now, settings, state.rows, listParams)
      : null;

  const tabs: FilterTab[] = TABS.map((v) => ({
    value: v,
    label: <TabLabel label={VIEW_LABEL[v]} count={counts[v]} />,
  }));

  // Side panel: each facet's options counted over the tab with every other facet applied.
  const labels: Partial<Record<PmFacet, Map<string, string>>> = {
    family: new Map(families.map((fam) => [String(fam.id), fam.name])),
    status: new Map(PM_STATUSES.map((st) => [st, statusLabel(st)])),
  };
  // Links that change a facet keep the rest of the view (not the page or the open row).
  const view: QueryParams = { ...base, ...listParams };
  const facetGroups: PmFacetGroup[] = PANEL_FACETS.map((f) => ({
    facet: f,
    title: FACET_TITLE[f],
    options: facetOptions(inTab, filters.facets, f, labels[f]),
    clearHref: filters.facets[f].length > 0 ? hrefWith('/pm', { ...view, [f]: undefined }) : null,
  }));
  const activeCount = PM_FACETS.reduce((n, f) => n + filters.facets[f].length, 0);
  const clearAllHref = hrefWith('/pm', { ...view, ...NO_FACETS });
  const chips: PmFilterChip[] = PM_FACETS.flatMap((f) =>
    filters.facets[f].map((v) => {
      const match = facetKey(f, v);
      const label =
        facetGroups.find((g) => g.facet === f)?.options.find((o) => o.value === match)?.label ?? labels[f]?.get(v) ?? v;
      return {
        facet: FACET_TITLE[f],
        label,
        href: hrefWith('/pm', { ...view, [f]: filters.facets[f].filter((x) => x !== v) }),
      };
    }),
  );
  // The panel form replaces the query string, so the rest of the view rides along as hidden fields.
  const panelHidden: [string, string][] = Object.entries(view).flatMap(([k, v]): [string, string][] => {
    // The panel's own facets come from its checkboxes; anything else (an old `family=`) rides along.
    if ((PANEL_FACETS as readonly string[]).includes(k) || v == null || v === '') return [];
    return Array.isArray(v) ? (v as readonly string[]).map((x): [string, string] => [k, x]) : [[k, String(v)]];
  });
  const hasFilters = activeCount > 0 || filters.overdue !== 'all';

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'PM due' }]} />

      <PageHeader
        title="PM due"
        subtitle={`Machines on an active contract, by pages since the last engineer visit of ${settings.qualifyingMinutes} minutes or more (or since install). Booked and Dismiss are recorded in this app only — book PM in Vantage.`}
        actions={
          <>
            <SearchInput
              action="/pm"
              defaultValue={filters.q}
              placeholder="Search customer, serial or model"
              hiddenParams={{
                ...listParams,
                view: base.view as string | undefined,
                overdue: base.overdue as string | undefined,
                townSort: base.townSort as string | undefined,
                ...filters.facets,
              }}
              className="w-[280px]"
            />
            <Link
              href="/pm/planner"
              className="flex h-10 items-center rounded-lg border border-line bg-card px-3.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              PM planner →
            </Link>
            {/* A plain link, not next/link: the response is a file download, not a page. */}
            <a
              href={hrefWith('/pm/export', base)}
              className="flex h-10 items-center gap-2 rounded-lg border border-line bg-card px-3.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              <Download aria-hidden className="size-4" />
              Export CSV
            </a>
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside aria-label="Filters" className="min-w-0">
          <PmFacetPanel
            groups={facetGroups}
            hidden={panelHidden}
            activeCount={activeCount}
            clearAllHref={activeCount > 0 ? clearAllHref : null}
          />
        </aside>
        <section className="min-w-0 rounded-xl border border-line bg-card">
          <div className="border-b border-line px-5 py-4">
            <FilterTabs
              basePath="/pm"
              param="view"
              current={filters.view}
              defaultValue="due"
              tabs={tabs}
              params={{ ...base, ...listParams, view: undefined }}
              ariaLabel="PM list tab"
            />
          </div>

          <p className="flex items-start gap-2.5 border-b border-line px-5 py-3 text-[13px] text-muted-foreground">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              {formatNumber(counts.overdue)} overdue in Due: {formatNumber(counts.overdueByPages)} over their page interval,{' '}
              {formatNumber(counts.overdueByTime)} by time ({settings.timeCapMonths} months since the last visit or install, or
              no qualifying visit in the visit history the app holds — those may simply have had their last PM before that
              history starts). Click a row for its visits and to mark it booked or dismiss it.
            </span>
          </p>

          {filters.view === 'due' ? (
            <nav aria-label="Due reason" className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
              {(
                [
                  ['all', 'All due', counts.due],
                  ['pages', 'Due by pages', counts.dueByPages],
                  ['time', 'Due by time', counts.dueByTime],
                ] as const
              ).map(([value, label, count]) => (
                <Link
                  key={value}
                  href={hrefWith('/pm', { ...base, ...listParams, overdue: value === 'all' ? undefined : value })}
                  aria-current={filters.overdue === value ? 'true' : undefined}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                    filters.overdue === value ? 'border-brand bg-brand-soft text-foreground' : 'border-line hover:bg-muted',
                  )}
                >
                  {label} ({formatNumber(count)})
                </Link>
              ))}
            </nav>
          ) : null}

          {moved ? (
            <p role="status" className="border-b border-line bg-brand-soft px-5 py-2.5 text-[13px]">
              {moved.name} is now in {moved.view === filters.view ? `this tab, on page ${moved.page}` : `the ${VIEW_LABEL[moved.view]} tab`}.{' '}
              <Link href={moved.href} className="font-medium text-brand hover:underline">
                Show it
              </Link>
            </p>
          ) : null}

          <PmFilterChips chips={chips} clearAllHref={clearAllHref} />

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <ListControls {...controls} />
            <nav aria-label="Town order" className="flex items-center gap-1 text-sm text-muted-foreground">
              Towns
              {(['worst', 'az'] as const).map((t) => (
                <Link
                  key={t}
                  href={hrefWith('/pm', { ...view, townSort: t === 'worst' ? undefined : t })}
                  aria-current={filters.townSort === t ? 'true' : undefined}
                  className={cn(
                    'rounded-full px-2.5 py-1 transition-colors',
                    filters.townSort === t ? 'bg-secondary font-medium text-foreground' : 'hover:bg-muted hover:text-foreground',
                  )}
                >
                  {TOWN_SORT_LABEL[t]}
                </Link>
              ))}
            </nav>
          </div>

          {shown.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted-foreground">
              {filters.q || hasFilters ? 'No machines match these filters.' : 'No machine is in this view.'}
            </p>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse">
                <thead>
                  <tr className="border-b border-line">
                    <SortHeader label="Customer" sortKey="customer" className={cn(HEAD, 'pl-4')} {...sorting} />
                    <SortHeader label="Serial" sortKey="serial" className={HEAD} {...sorting} />
                    <SortHeader label="Model" sortKey="model" className={HEAD} {...sorting} />
                    <SortHeader label="Status" sortKey="status" className={HEAD} {...sorting} />
                    <SortHeader label="Pages since / %" sortKey="pct" align="right" className={HEAD_WRAP} {...sorting} />
                    <SortHeader label="Last counted visit" sortKey="lastVisit" className={HEAD_WRAP} {...sorting} />
                    <SortHeader label="Est. due" sortKey="due" className={HEAD} {...sorting} />
                    <th scope="col" className={cn(HEAD, 'w-px pr-3 pl-1')}>
                      {filters.view === 'other-dealer' ? 'Dealer' : 'Plan'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {slices.map((sl) => (
                    <Fragment key={sl.group.key}>
                      <tr className="border-b border-line bg-muted/40">
                        <th scope="colgroup" colSpan={COLUMNS} className="px-4 py-2 text-left text-[13px] font-semibold">
                          {townHeader(sl.group)}
                          {sl.continued ? ' (continued)' : ''}
                        </th>
                      </tr>
                      {sl.rows.map((r) => (
                        <PmTableRow
                          key={r.vantageEquipmentId}
                          row={trimVisits(r)}
                          back={back}
                          initiallyOpen={r.vantageEquipmentId === openId}
                          error={r.vantageEquipmentId === openId && pmError ? pmErrorMessage(pmError) : null}
                          today={today}
                          qualifyingMinutes={settings.qualifyingMinutes}
                          timeCapMonths={settings.timeCapMonths}
                          columns={COLUMNS}
                          overdueMonths={overdueMonths(r, now)}
                          otherDealerTab={filters.view === 'other-dealer'}
                          canAddToPlan={canAddToPlan(r, now)}
                          dealerSuggestions={dealerSuggestions}
                        />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
        </section>
      </div>
    </>
  );
}

/** Only the visits the detail shows go to the browser. */
function trimVisits(r: PmRow): PmRow {
  return r.result.visits.length <= PM_VISIT_ROWS ? r : { ...r, result: { ...r.result, visits: r.result.visits.slice(0, PM_VISIT_ROWS) } };
}

/**
 * Where the `?open=` machine went when it is not on this page — an action moved it to another tab,
 * or it sits on another page of this one — with a link that opens it there. Null when it left the
 * contract list. `ordered` is this view's machines in page order (town groups flattened). When the
 * machine is not in it, it is looked for in the tab it is now in, with the status facet and the due
 * reason dropped (and every facet, if the others would still hide it). The link keeps the sort, the
 * page size and the town order.
 */
function movedTo(
  all: PmRow[],
  ordered: PmRow[],
  openId: number,
  f: PmFilters,
  now: Date,
  settings: PmSettings,
  pageSize: number,
  listParams: Record<string, string>,
): { name: string; view: PmViewFilter; page: number; href: string } | null {
  const row = all.find((r) => r.vantageEquipmentId === openId);
  if (!row) return null;
  const name = [row.customerName ?? 'Unknown customer', row.serial].filter(Boolean).join(' · ');
  let target = f;
  let list = ordered;
  if (!list.some((r) => r.vantageEquipmentId === openId)) {
    const facets = { ...f.facets, status: [] };
    target = {
      ...f,
      view: tabOf(row, now),
      overdue: 'all',
      facets: applyPmFacets([row], facets).length > 0 ? facets : NO_FACETS,
    };
    list = groupByTown(selectPmRows(all, target, now, settings), target.townSort).flatMap((g) => g.rows);
  }
  const page = Math.floor(list.findIndex((r) => r.vantageEquipmentId === openId) / pageSize) + 1;
  return {
    name,
    view: target.view,
    page,
    href: hrefWith('/pm', { ...filterParams(target), ...listParams, page: page > 1 ? page : undefined, open: openId }),
  };
}

function TabLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(count)}</span>
    </>
  );
}
