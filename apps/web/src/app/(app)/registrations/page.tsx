import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Download, Info } from 'lucide-react';
import { REGISTRATION_SORT_KEYS, getRegistrationCounts, listRegistrations, type RegistrationTab } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { ListControls } from '@/components/list-controls';
import { RegistrationQueue } from '@/components/registration-queue';
import { REGISTRATION_TAB_SORT_KEYS, awaitingTabCount, parseRegistrationTab } from '@/components/registrations';
import { SearchInput } from '@/components/search-input';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { REGISTRATIONS_DEFAULT_ROWS } from '@/lib/list-keep';
import { keepSort, lastPageOf, listHref, parseListState, rowsCookieName, sortSpec, stateParams } from '@/lib/list-state';

export const metadata = { title: 'DRMS registrations · MPS Dashboard' };

const LIST_KEY = 'registrations';
const DEFAULT_ROWS = REGISTRATIONS_DEFAULT_ROWS;

/** `?error=` codes from the actions (`RegistrationErrorCode`), as sentences. */
const ERRORS: Record<string, string> = {
  empty: 'Nothing was selected. Tick at least one machine first.',
  stale: 'Someone else has already decided one of those, or the nightly scan moved it — the list has been refreshed.',
  not_found: 'That registration no longer exists — the list has been refreshed.',
  bad_state: 'That registration has moved on since the page loaded (only the latest failure of a machine can be retried).',
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RegistrationsPage({ searchParams }: PageProps<'/registrations'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const tab: RegistrationTab = parseRegistrationTab(first(params.tab));
  const search = first(params.search)?.trim() || undefined;
  const cookieStore = await cookies();
  // A sort on a column this tab does not show (carried over from another tab) is dropped here.
  const state = keepSort(
    parseListState((name) => first(params[name]), {
      listKey: LIST_KEY,
      defaultRows: DEFAULT_ROWS,
      sortKeys: REGISTRATION_SORT_KEYS,
      cookieRows: cookieStore.get(rowsCookieName(LIST_KEY))?.value,
    }),
    REGISTRATION_TAB_SORT_KEYS[tab],
  );
  const page = state.page;
  const errorCode = first(params.error);
  const error = errorCode ? (ERRORS[errorCode] ?? 'That did not work. Refresh the page and try again.') : null;

  const db = getDb();
  const [{ rows, total }, counts] = await Promise.all([
    listRegistrations(db, { tab, search, limit: state.rows, offset: (page - 1) * state.rows, sort: sortSpec(state) }),
    getRegistrationCounts(db),
  ]);

  const tabParam = tab === 'awaiting' ? undefined : tab;
  const keep = { tab: tabParam, search };
  const lastPage = lastPageOf(total, state.rows);
  if (page > lastPage) redirect(listHref('/registrations', keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  // Sort and page size survive a change of tab or search; the page does not (nor a sort the new
  // tab has no column for — see above).
  const listParams = stateParams(state, { defaultRows: DEFAULT_ROWS });
  const sorting = { basePath: '/registrations', keep, state, defaultRows: DEFAULT_ROWS };
  const controls = { ...sorting, total, listKey: LIST_KEY, noun: 'machine' };
  const back = listHref('/registrations', keep, state, {}, { defaultRows: DEFAULT_ROWS });

  const tabs: FilterTab[] = [
    { value: 'awaiting', label: <TabLabel label="Awaiting approval" count={awaitingTabCount(counts).text} /> },
    { value: 'waiting', label: <TabLabel label="Waiting" count={counts.waiting} /> },
    { value: 'registered', label: <TabLabel label="Registered" count={counts.registered} /> },
    { value: 'failed', label: <TabLabel label="Failed" count={counts.failed} /> },
    { value: 'rejected', label: <TabLabel label="Rejected" count={counts.rejected} /> },
  ];

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'DRMS registrations' }]} />

      <PageHeader
        title="DRMS registrations"
        subtitle="Machines newly connected to CSRC, checked against Vantage every night. Nothing is registered in DRMS until someone approves it."
        actions={
          <>
            <SearchInput
              action="/registrations"
              defaultValue={search}
              placeholder="Search serial, device or customer"
              hiddenParams={{ tab: tabParam, ...listParams }}
              className="w-[280px]"
            />
            {/* A plain link, not next/link: the response is a file download, not a page. */}
            <a
              href="/registrations/export"
              className="flex h-10 items-center gap-2 rounded-lg border border-line bg-card px-3.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              <Download aria-hidden className="size-4" />
              Export log
            </a>
          </>
        }
      />

      {counts.approved > 0 ? (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 px-5 py-4">
          <Info aria-hidden className="mt-0.5 size-[18px] shrink-0 text-warn" />
          <p className="text-[14px] text-warn">
            {formatNumber(counts.approved)} approved {pluralise(counts.approved, 'machine')}{' '}
            {counts.approved === 1 ? 'is' : 'are'} being registered in DRMS, one at a time with a pause between each. They
            move to <em>Registered</em> or <em>Failed</em> as DRMS answers.
          </p>
        </div>
      ) : null}

      <section className="rounded-xl border border-line bg-card">
        <div className="border-b border-line px-5 py-4">
          <FilterTabs
            basePath="/registrations"
            param="tab"
            current={tab}
            tabs={tabs}
            defaultValue="awaiting"
            params={{ search, ...listParams }}
            ariaLabel="DRMS registration queue"
          />
        </div>

        {error ? (
          <p role="alert" className="border-b border-line bg-critical/5 px-5 py-3 text-[13px] text-critical">
            {error}
          </p>
        ) : null}

        {tab === 'awaiting' || tab === 'waiting' ? (
          <p className="flex items-start gap-2.5 border-b border-line px-5 py-3 text-[13px] text-muted-foreground">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              {tab === 'awaiting'
                ? 'Each machine is Discovered in DRMS, connects straight to CSRC, and matches exactly one Vantage machine with an active contract. A customer-name flag means DRMS holds a different customer from Vantage — the machine is registered under the DRMS customer; decide whether that is right.'
                : 'These pass the DRMS checks but not a Vantage one yet. They are checked again every night and move to Awaiting approval once they pass.'}
            </span>
          </p>
        ) : null}

        <ListControls {...controls} className="border-b border-line px-5 py-3.5" />

        <RegistrationQueue
          // A new page, sort or page size is a new set of rows: start the ticked boxes afresh.
          key={back}
          tab={tab}
          rows={rows}
          search={search}
          back={back}
          sorting={sorting}
        />

        <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
      </section>
    </>
  );
}

function TabLabel({ label, count }: { label: string; count: number | string }) {
  return (
    <>
      {label}
      <span className="ml-1.5 tabular-nums opacity-60">{typeof count === 'number' ? formatNumber(count) : count}</span>
    </>
  );
}
