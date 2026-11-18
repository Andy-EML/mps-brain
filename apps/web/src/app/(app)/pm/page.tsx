import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Download, Info } from 'lucide-react';
import { cn } from 'cn';
import { getPmSettings, listFamilies, listPmDue, londonDay, type PmRow, type PmSettings } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { PM_VISIT_ROWS } from '@/components/pm-detail';
import { PmRow as PmTableRow } from '@/components/pm-row';
import { statusLabel } from '@/components/pm-status';
import { SearchInput } from '@/components/search-input';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber } from '@/lib/format';
import { hrefWith } from '@/lib/href';
import { pmErrorMessage } from '@/lib/pm-action-form';
import { PM_STATUSES, applyPmView, countPm, inPmView, parsePmFilters, type PmFilters, type PmViewFilter } from './filters';

export const metadata = { title: 'PM due · MPS Dashboard' };

const PAGE_SIZE = 100;
/** Columns in the collapsed row (`PmRow`). */
const COLUMNS = 7;

const HEAD = 'px-4 py-2.5 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CONTROL =
  'h-9 rounded-lg border border-input bg-card px-2 text-[13px] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

const VIEW_LABEL: Record<PmViewFilter, string> = { due: 'Due', booked: 'Booked', dismissed: 'Dismissed', all: 'All' };

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
 * accordion rows in four tabs (Due, Booked, Dismissed, All). Mark booked / Dismiss / Undo are
 * recorded in this app only — nothing is written to Vantage. Every row is loaded once (customer,
 * family and search applied) so the tabs can count them; the tab, status and overdue reason are
 * applied here.
 */
export default async function PmDuePage({ searchParams }: PageProps<'/pm'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;
  const filters = parsePmFilters(params);
  const page = Math.max(1, Number.parseInt(first(params.page) ?? '1', 10) || 1);
  const openRaw = first(params.open);
  const openId = openRaw && /^\d{1,10}$/.test(openRaw) ? Number(openRaw) : null;
  const pmError = first(params.pmError);

  const db = getDb();
  const now = new Date();
  const [all, settings, families] = await Promise.all([
    // view 'all' explicitly: the tabs are counted and applied here (inPmView mirrors the DB rule).
    listPmDue(db, now, { view: 'all', customer: filters.customer, family: filters.family, q: filters.q }),
    getPmSettings(db),
    listFamilies(db),
  ]);
  const counts = countPm(all, now, settings);
  const rows = applyPmView(all, filters, now, settings);
  const base = filterParams(filters);
  const today = londonDay(now);

  const lastPage = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page > lastPage && rows.length > 0) {
    redirect(hrefWith('/pm', { ...base, page: lastPage > 1 ? lastPage : undefined, open: openId ?? undefined }));
  }
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // This view's own URL: forms post it back, the device page's Back link returns to it.
  const back = hrefWith('/pm', { ...base, page: page > 1 ? page : undefined });
  const moved = openId !== null && !shown.some((r) => r.vantageEquipmentId === openId) ? movedTo(all, rows, openId, filters, now, settings) : null;

  const tabs: FilterTab[] = (['due', 'booked', 'dismissed', 'all'] as const).map((v) => ({
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
                view: base.view as string | undefined,
                status: base.status as string | undefined,
                customer: filters.customer,
                family: filters.family?.toString(),
                overdue: base.overdue as string | undefined,
              }}
              className="w-[280px]"
            />
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
            params={{ ...base, view: undefined }}
            ariaLabel="PM list tab"
          />
        </div>

        <form action="/pm" method="get" className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
          {base.view ? <input type="hidden" name="view" value={String(base.view)} /> : null}
          {filters.q ? <input type="hidden" name="search" value={filters.q} /> : null}
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
              href={hrefWith('/pm', { view: base.view, search: filters.q })}
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
                href={hrefWith('/pm', { ...base, overdue: value === 'all' ? undefined : value })}
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

        {shown.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            {filters.q || hasFilters ? 'No machines match these filters.' : 'No machine is in this view.'}
          </p>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[1000px] border-collapse">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={HEAD}>Customer</th>
                  <th scope="col" className={HEAD}>Serial</th>
                  <th scope="col" className={HEAD}>Model</th>
                  <th scope="col" className={HEAD}>Status</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>Pages since / %</th>
                  <th scope="col" className={HEAD}>Last counted visit</th>
                  <th scope="col" className={HEAD}>Est. due</th>
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
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="border-t border-line px-5 py-3.5">
          <Pagination basePath="/pm" params={base} page={page} pageSize={PAGE_SIZE} total={rows.length} noun="machine" />
        </div>
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
 */
function movedTo(
  all: PmRow[],
  rows: PmRow[],
  openId: number,
  f: PmFilters,
  now: Date,
  settings: PmSettings,
): { name: string; view: PmViewFilter; page: number; href: string } | null {
  const row = all.find((r) => r.vantageEquipmentId === openId);
  if (!row) return null;
  const name = [row.customerName ?? 'Unknown customer', row.serial].filter(Boolean).join(' · ');
  let view: PmViewFilter = f.view;
  let list = rows;
  let keep = filterParams(f);
  if (!list.some((r) => r.vantageEquipmentId === openId)) {
    view = (['due', 'booked', 'dismissed'] as const).find((v) => inPmView(row, v, now)) ?? 'all';
    keep = { ...keep, view: view === 'due' ? undefined : view, status: undefined, overdue: undefined };
    list = applyPmView(all, { view, status: 'all', overdue: 'all' }, now, settings);
  }
  const page = Math.floor(list.findIndex((r) => r.vantageEquipmentId === openId) / PAGE_SIZE) + 1;
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
