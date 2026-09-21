import { redirect } from 'next/navigation';
import { Download, Info } from 'lucide-react';
import { getRegistrationCounts, listRegistrations, type RegistrationTab } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { RegistrationQueue } from '@/components/registration-queue';
import { parseRegistrationTab } from '@/components/registrations';
import { SearchInput } from '@/components/search-input';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { hrefWith } from '@/lib/href';

export const metadata = { title: 'DRMS registrations · MPS Dashboard' };

const PAGE_SIZE = 100;

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
  const page = Math.max(1, Number.parseInt(first(params.page) ?? '1', 10) || 1);
  const errorCode = first(params.error);
  const error = errorCode ? (ERRORS[errorCode] ?? 'That did not work. Refresh the page and try again.') : null;

  const db = getDb();
  const [{ rows, total }, counts] = await Promise.all([
    listRegistrations(db, { tab, search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    getRegistrationCounts(db),
  ]);

  const tabParam = tab === 'awaiting' ? undefined : tab;
  if (rows.length === 0 && total > 0 && page > 1) {
    const lastPage = Math.ceil(total / PAGE_SIZE);
    redirect(hrefWith('/registrations', { tab: tabParam, search, page: lastPage > 1 ? lastPage : undefined }));
  }

  const tabs: FilterTab[] = [
    { value: 'awaiting', label: <TabLabel label="Awaiting approval" count={counts.awaitingApproval} /> },
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
              hiddenParams={{ tab: tabParam }}
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
            params={{ search }}
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

        <RegistrationQueue key={`${tab}-${search ?? ''}-${page}`} tab={tab} rows={rows} search={search} />

        <div className="border-t border-line px-5 py-3.5">
          <Pagination
            basePath="/registrations"
            params={{ tab: tabParam, search }}
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
