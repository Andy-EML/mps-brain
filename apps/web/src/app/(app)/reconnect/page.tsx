import { Fragment } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Download, Info } from 'lucide-react';
import { cn } from 'cn';
import {
  getReconnectCounts,
  listReconnect,
  NEWLY_SILENT_MAX_DAYS,
  RECONNECT_DAYS,
  type ReconnectFilter,
  type ReconnectRow,
} from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { CopyText } from '@/components/copy-text';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { SearchInput } from '@/components/search-input';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatDate, formatDateTime, formatNumber, pluralise } from '@/lib/format';
import { deviceHref } from '@/lib/device-origin';
import { hrefWith } from '@/lib/href';
import { monitoringGroupLabel, parseReconnectFilter } from './filters';

export const metadata = { title: 'Needs reconnecting · MPS Dashboard' };

const PAGE_SIZE = 50;

const EMPTY: Record<ReconnectFilter, string> = {
  all: `Every machine that sends meter readings has been in touch in the last ${RECONNECT_DAYS} days.`,
  new: 'No machine has gone quiet in the last 30 days.',
  long: 'No machine has been quiet for more than 30 days.',
  unmonitored: 'Every machine on a Vantage contract has sent DRMS a meter reading.',
};

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ReconnectPage({ searchParams }: PageProps<'/reconnect'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const search = first(params.search)?.trim() || undefined;
  const filter = parseReconnectFilter(first(params.filter));
  const page = Math.max(1, Number.parseInt(first(params.page) ?? '1', 10) || 1);

  const db = getDb();
  const now = new Date();
  const [{ rows, total }, counts] = await Promise.all([
    listReconnect(db, { filter, search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, now }),
    getReconnectCounts(db, { now }),
  ]);

  const filterParam = filter === 'all' ? undefined : filter;

  // A page number past the end (a stale bookmark, or a search that shrank the list) would otherwise
  // show the empty state over a list that does have rows.
  if (rows.length === 0 && total > 0 && page > 1) {
    const lastPage = Math.ceil(total / PAGE_SIZE);
    redirect(
      hrefWith('/reconnect', {
        search,
        filter: filterParam,
        page: lastPage > 1 ? lastPage : undefined,
      }),
    );
  }

  // This view's own URL, for the device page's Back link.
  const back = hrefWith('/reconnect', { search, filter: filterParam, page: page > 1 ? page : undefined });

  const tabs: FilterTab[] = [
    { value: 'all', label: <TabLabel label="All" count={counts.silent} /> },
    { value: 'new', label: <TabLabel label="Newly silent" count={counts.newlySilent} /> },
    { value: 'long', label: <TabLabel label="Long silent" count={counts.longSilent} /> },
    {
      value: 'unmonitored',
      label: <TabLabel label="Not monitored yet" count={counts.unmonitored} />,
    },
  ];

  return (
    <>
      <Breadcrumb
        className="mb-3"
        items={[{ label: 'Fleet overview', href: '/' }, { label: 'Needs reconnecting' }]}
      />

      <PageHeader
        title="Needs reconnecting"
        subtitle={`Machines on a Vantage contract that CSRC hasn't heard from for ${RECONNECT_DAYS} days or more, newest first.`}
        actions={
          <>
            <SearchInput
              action="/reconnect"
              defaultValue={search}
              placeholder="Search customer or serial"
              hiddenParams={{ filter: filterParam }}
              className="w-[280px]"
            />
            {/* A plain link, not next/link: the response is a file download, not a page. */}
            <a
              href={hrefWith('/reconnect/export', { filter: filterParam, search })}
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
            basePath="/reconnect"
            current={filter}
            tabs={tabs}
            params={{ search }}
            ariaLabel="Filter machines"
          />
        </div>

        <p className="flex items-start gap-2.5 border-b border-line px-5 py-3 text-[13px] text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {filter === 'unmonitored' ? (
            <span>
              These machines have never sent DRMS a meter reading, so there is no way to tell
              whether they are online — a machine can check in on CSRC every day without DRMS
              hearing of it. Register them in DRMS to monitor them.
            </span>
          ) : (
            <span>
              Only machines that send meter readings are judged. DRMS collects readings daily and
              alarms every half hour, so {RECONNECT_DAYS} days with neither means the machine has
              stopped talking to CSRC. Machines that have never sent a reading are under{' '}
              <em>Not monitored yet</em>.
            </span>
          )}
        </p>

        {rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-muted-foreground">
            {search ? `No machines match “${search}”.` : EMPTY[filter]}
          </p>
        ) : filter === 'unmonitored' ? (
          <UnmonitoredTable rows={rows} back={back} />
        ) : (
          <SilentTable rows={rows} back={back} />
        )}

        <div className="border-t border-line px-5 py-3.5">
          <Pagination
            basePath="/reconnect"
            params={{ search, filter: filterParam }}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            noun="machine"
          />
        </div>
      </section>
    </>
  );
}

function TabLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(count)}</span>
    </>
  );
}

function CustomerCell({ row }: { row: ReconnectRow }) {
  return (
    <td className="px-5 py-4">
      <div className="truncate text-[15px] font-semibold">
        {row.customerName ?? 'Unknown customer'}
      </div>
      {row.customerReference ? (
        <div className="truncate text-[13px] text-muted-foreground">{row.customerReference}</div>
      ) : null}
    </td>
  );
}

/** `back` is this list's own URL, so the device page's Back link returns to the same view. */
function DeviceCells({ row, back }: { row: ReconnectRow; back: string }) {
  return (
    <>
      <td className="px-5 py-4 text-[14px]">{row.location ?? '—'}</td>
      <td className="px-5 py-4">
        {/* The same name as the queue and device page; the model underneath unless it already ends it. */}
        <div className="truncate text-[14px]">{row.displayName}</div>
        {row.model && !row.displayName.includes(row.model) ? (
          <div className="truncate text-[13px] text-muted-foreground">{row.model}</div>
        ) : null}
      </td>
      <td className="px-5 py-4">
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Link href={deviceHref(row.drmsId, 'reconnect', back)} className="font-mono hover:text-brand hover:underline">
            {row.serial ?? row.drmsId}
          </Link>
          {row.serial ? <CopyText text={row.serial} iconOnly /> : null}
        </div>
      </td>
      <td className="px-5 py-4 text-[14px]">{row.drmsStatus ?? '—'}</td>
    </>
  );
}

function SilentTable({ rows, back }: { rows: ReconnectRow[]; back: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={HEAD}>
              Customer
            </th>
            <th scope="col" className={HEAD}>
              Location
            </th>
            <th scope="col" className={HEAD}>
              Device
            </th>
            <th scope="col" className={HEAD}>
              Serial
            </th>
            <th scope="col" className={HEAD}>
              DRMS status
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Last contact
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.drmsId} className="border-b border-line align-top last:border-0">
              <CustomerCell row={row} />
              <DeviceCells row={row} back={back} />
              <td className="px-5 py-4 text-right">
                <div className="text-[14px] whitespace-nowrap">
                  {formatDateTime(row.lastContactAt)}
                </div>
                {row.daysSilent !== null ? (
                  <div
                    className={cn(
                      'text-[13px] whitespace-nowrap',
                      row.daysSilent > NEWLY_SILENT_MAX_DAYS ? 'text-critical' : 'text-warn',
                    )}
                  >
                    {formatNumber(row.daysSilent)} {pluralise(row.daysSilent, 'day')} ago
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Grouped by `registeredInDrms`, which is how the query sorts them. */
function UnmonitoredTable({ rows, back }: { rows: ReconnectRow[]; back: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={HEAD}>
              Customer
            </th>
            <th scope="col" className={HEAD}>
              Location
            </th>
            <th scope="col" className={HEAD}>
              Device
            </th>
            <th scope="col" className={HEAD}>
              Serial
            </th>
            <th scope="col" className={HEAD}>
              DRMS status
            </th>
            <th scope="col" className={HEAD}>
              First connected
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Last alarm
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const startsGroup = i === 0 || rows[i - 1]!.registeredInDrms !== row.registeredInDrms;
            return (
              <Fragment key={row.drmsId}>
                {startsGroup ? (
                  <tr className="border-b border-line bg-muted/40">
                    <th
                      scope="colgroup"
                      colSpan={7}
                      className="px-5 py-2 text-left text-[13px] font-medium"
                    >
                      {monitoringGroupLabel(row.registeredInDrms)}
                      {!row.registeredInDrms ? (
                        <span className="ml-2 font-normal text-muted-foreground">
                          Register them to monitor them.
                        </span>
                      ) : null}
                    </th>
                  </tr>
                ) : null}
                <tr className="border-b border-line align-top last:border-0">
                  <CustomerCell row={row} />
                  <DeviceCells row={row} back={back} />
                  <td className="px-5 py-4 text-[14px] whitespace-nowrap">
                    {formatDate(row.firstConnectedAt)}
                  </td>
                  <td className="px-5 py-4 text-right text-[14px] whitespace-nowrap">
                    {formatDateTime(row.lastAlarmAt)}
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
