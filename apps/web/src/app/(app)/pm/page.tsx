import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Download, Info } from 'lucide-react';
import { cn } from 'cn';
import { PM_SORT_KEYS, getPmSettings, listFamilies, listPmDue, londonDay, overdueMonths, type PmRow, type PmSettings } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { ListControls } from '@/components/list-controls';
import { PM_VISIT_ROWS } from '@/components/pm-detail';
import { PmRow as PmTableRow } from '@/components/pm-row';
import { statusLabel } from '@/components/pm-status';
import { SearchInput } from '@/components/search-input';
import { SortHeader } from '@/components/sort-header';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber } from '@/lib/format';
import { hrefWith } from '@/lib/href';
import { PM_DEFAULT_ROWS, pmKeep } from '@/lib/list-keep';
import { lastPageOf, listHref, parseListState, rowsCookieName, sortSpec, stateParams } from '@/lib/list-state';
import { pmErrorMessage } from '@/lib/pm-action-form';
import { PM_STATUSES, applyPmView, canAddToPlan, countPm, parsePmFilters, tabOf, type PmFilters, type PmViewFilter } from './filters';

export const metadata = { title: 'PM due · MPS Dashboard' };

const LIST_KEY = 'pm';
const DEFAULT_ROWS = PM_DEFAULT_ROWS;
/** Columns in the collapsed row (`PmRow`), the narrow Plan cell included. */
const COLUMNS = 8;

const HEAD = 'px-4 py-2.5 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CONTROL =
  'h-9 rounded-lg border border-input bg-card px-2 text-[13px] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

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

/** The URL params for a set of filters, defaults left off. */
function filterParams(f: PmFilters): Record<string, string | number | undefined> {
  return {
    view: f.view === 'due' ? undefined : f.view,
    status: f.status === 'all' ? undefined : f.status,
    customer: f.customer,
    family: f.family,
    search: f.q,
    overdue: f.overdue === 'all' ? undefined : f.overdue,
  };
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * `/pm`: machines on an active contract with their meter-driven preventive-maintenance state, as
 * accordion rows in six tabs (Due, When in area, Booked, Dismissed, Other dealer, All). Mark booked /
 * Dismiss / Undo and the planner flags (Priority, When in area, Add to plan, Mark as ours) are
 * recorded in this app only — nothing is written to Vantage. Every row of every dealer is loaded once
 * (customer, family and search applied) so the tabs can count them; the tab, status and overdue
 * reason are applied here.
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
  });
  const page = state.page;
  const openRaw = first(params.open);
  const openId = openRaw && /^\d{1,10}$/.test(openRaw) ? Number(openRaw) : null;
  const pmError = first(params.pmError);

  const db = getDb();
  const now = new Date();
  const [all, settings, families] = await Promise.all([
    // view and dealer 'all' explicitly: the tabs (incl. Other dealer) are counted and applied here.
    listPmDue(db, now, {
      view: 'all',
      dealer: 'all',
      customer: filters.customer,
      family: filters.family,
      q: filters.q,
      sort: sortSpec(state),
    }),
    getPmSettings(db),
    listFamilies(db),
  ]);
  const counts = countPm(all, now, settings);
  const rows = applyPmView(all, filters, now, settings);
  const base = filterParams(filters);
  const today = londonDay(now);

  // Pager, rows picker and sort headers keep the filters and the open row (Review Focus 4).
  const keep = pmKeep(base, openId);
  const lastPage = lastPageOf(rows.length, state.rows);
  if (page > lastPage) redirect(listHref('/pm', keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  const shown = rows.slice((page - 1) * state.rows, page * state.rows);
  // Sort and page size survive a change of tab, filter or search; the page does not.
  const listParams = stateParams(state, { defaultRows: DEFAULT_ROWS });
  const sorting = { basePath: '/pm', keep, state, defaultRows: DEFAULT_ROWS };
  const controls = { ...sorting, total: rows.length, listKey: LIST_KEY, noun: 'machine' };

  // This view's own URL without the open row (the actions add it): forms post it back, the device
  // page's Back link returns to it.
  const back = listHref('/pm', base, state, {}, { defaultRows: DEFAULT_ROWS });
  const moved =
    openId !== null && !shown.some((r) => r.vantageEquipmentId === openId)
      ? movedTo(all, rows, openId, filters, now, settings, state.rows, listParams)
      : null;

  const tabs: FilterTab[] = TABS.map((v) => ({
    value: v,
    label: <TabLabel label={VIEW_LABEL[v]} count={counts[v]} />,
  }));

  const customers = [...new Set(all.map((r) => r.customerName).filter((c): c is string => !!c))].sort((a, b) =>
    a.localeCompare(b),
  );
  const hasFilters =
    filters.customer !== undefined || filters.family !== undefined || filters.overdue !== 'all' || filters.status !== 'all';

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
                status: base.status as string | undefined,
                customer: filters.customer,
                family: filters.family?.toString(),
                overdue: base.overdue as string | undefined,
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

      <section className="rounded-xl border border-line bg-card">
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

        <form action="/pm" method="get" className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          {base.view ? <input type="hidden" name="view" value={String(base.view)} /> : null}
          {filters.q ? <input type="hidden" name="search" value={filters.q} /> : null}
          {Object.entries(listParams).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <input
            name="customer"
            list="pm-customers"
            defaultValue={filters.customer}
            placeholder="Customer"
            aria-label="Customer"
            className={cn(CONTROL, 'w-56 px-3')}
          />
          <datalist id="pm-customers">
            {customers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <select name="family" defaultValue={filters.family?.toString() ?? ''} aria-label="Cartridge family" className={CONTROL}>
            <option value="">Any family</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={filters.status} aria-label="PM status" className={CONTROL}>
            <option value="all">Any status</option>
            {PM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select name="overdue" defaultValue={filters.overdue} aria-label="Overdue reason" className={CONTROL}>
            <option value="all">Overdue: any reason</option>
            <option value="pages">Overdue by pages</option>
            <option value="time">Overdue by time</option>
          </select>
          <button type="submit" className="h-9 rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-muted">
            Apply
          </button>
          {hasFilters ? (
            <Link
              href={hrefWith('/pm', { view: base.view, search: filters.q, ...listParams })}
              className="px-1 text-[13px] text-brand hover:underline"
            >
              Clear filters
            </Link>
          ) : null}
        </form>

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

        <ListControls {...controls} className="border-b border-line px-5 py-3.5" />

        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            {filters.q || hasFilters ? 'No machines match these filters.' : 'No machine is in this view.'}
          </p>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[1000px] border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <SortHeader label="Customer" sortKey="customer" className={HEAD} {...sorting} />
                  <SortHeader label="Serial" sortKey="serial" className={HEAD} {...sorting} />
                  <SortHeader label="Model" sortKey="model" className={HEAD} {...sorting} />
                  <SortHeader label="Status" sortKey="status" className={HEAD} {...sorting} />
                  <SortHeader label="Pages since / %" sortKey="pct" align="right" className={HEAD} {...sorting} />
                  <SortHeader label="Last counted visit" sortKey="lastVisit" className={HEAD} {...sorting} />
                  <SortHeader label="Est. due" sortKey="due" className={HEAD} {...sorting} />
                  <th scope="col" className={cn(HEAD, 'w-px pr-3 pl-1')}>
                    {filters.view === 'other-dealer' ? 'Dealer' : 'Plan'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
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
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
      </section>
    </>
  );
}

/** Only the visits the detail shows go to the browser. */
function trimVisits(r: PmRow): PmRow {
  return r.result.visits.length <= PM_VISIT_ROWS ? r : { ...r, result: { ...r.result, visits: r.result.visits.slice(0, PM_VISIT_ROWS) } };
}

/**
 * Where the `?open=` machine went when it is not on this page — an action moved it to another tab,
 * or it sits on another page of this one — with a link that opens it there. Null when it is in no
 * view the filters allow (it left the contract list, or the status / overdue filter hides it).
 * `all` is already in the list's sort order; the link keeps that sort and the page size.
 */
function movedTo(
  all: PmRow[],
  rows: PmRow[],
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
  let view: PmViewFilter = f.view;
  let list = rows;
  let keep: Record<string, string | number | undefined> = { ...filterParams(f), ...listParams };
  if (!list.some((r) => r.vantageEquipmentId === openId)) {
    view = tabOf(row, now);
    keep = { ...keep, view: view === 'due' ? undefined : view, status: undefined, overdue: undefined };
    list = applyPmView(all, { view, status: 'all', overdue: 'all' }, now, settings);
  }
  const page = Math.floor(list.findIndex((r) => r.vantageEquipmentId === openId) / pageSize) + 1;
  return { name, view, page, href: hrefWith('/pm', { ...keep, page: page > 1 ? page : undefined, open: openId }) };
}

function TabLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(count)}</span>
    </>
  );
}
