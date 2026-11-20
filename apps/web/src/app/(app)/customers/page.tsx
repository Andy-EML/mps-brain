import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listCustomers, type CustomerTab } from '@mps/db/queries';
import { cn } from 'cn';
import { CustomerTableRow } from '@/components/customer-table-row';
import {
  CUSTOMER_TABS,
  DEFAULT_CUSTOMER_TAB,
  customerHref,
  customerStockBadge,
  parseCustomerSearchParams,
} from '@/components/customers';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { SearchInput } from '@/components/search-input';
import { ToneBadge } from '@/components/tone-badge';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { hrefWith } from '@/lib/href';

export const metadata = { title: 'Customers · MPS Dashboard' };

const PAGE_SIZE = 50;

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-4 py-3 align-middle text-[13px]';

const EMPTY: Record<CustomerTab, string> = {
  'with-machines': 'No customer has a linked DRMS device yet.',
  'self-managed': 'No customer manages its own toner stock.',
  'head-offices': 'No customer is a head office of another.',
  all: 'No Vantage customers have been synced yet.',
};

/**
 * `/customers`, for every signed-in user: Vantage customers with their machine, pending proposal
 * and shelf counts and who keeps their toner (the dealer, or the customer itself — on its own flag
 * or its head office's). Tabs With machines (default) / Self-managed / Head offices / All, each with
 * its count; the search (name, reference, town) narrows the rows and the counts alike. A row opens
 * the customer page.
 */
export default async function CustomersPage({ searchParams }: PageProps<'/customers'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const { tab, search, page } = parseCustomerSearchParams(await searchParams);

  const db = getDb();
  const { rows, total, counts } = await listCustomers(db, {
    tab,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const tabParam = tab === DEFAULT_CUSTOMER_TAB ? undefined : tab;
  const searchParam = search || undefined;

  // A page number past the end (a stale bookmark, or a search that shrank the list) would otherwise
  // show the empty state over a list that does have rows.
  if (rows.length === 0 && total > 0 && page > 1) {
    const lastPage = Math.ceil(total / PAGE_SIZE);
    redirect(hrefWith('/customers', { search: searchParam, tab: tabParam, page: lastPage > 1 ? lastPage : undefined }));
  }

  const tabs: FilterTab[] = CUSTOMER_TABS.map((t) => ({
    value: t.value,
    label: `${t.label} (${formatNumber(counts[t.value])})`,
  }));
  const showSites = tab === 'head-offices';

  const counted = `${formatNumber(total)} ${pluralise(total, 'customer')}`;
  const subtitle = search ? `${counted} matching “${search}”` : counted;

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={subtitle}
        actions={
          <SearchInput
            action="/customers"
            defaultValue={search}
            placeholder="Search name, ref or town"
            hiddenParams={{ tab: tabParam }}
            className="w-[320px]"
          />
        }
      />

      <section className="rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <FilterTabs
            basePath="/customers"
            param="tab"
            defaultValue={DEFAULT_CUSTOMER_TAB}
            current={tab}
            tabs={tabs}
            params={{ search: searchParam }}
            ariaLabel="Filter customers"
          />
        </div>

        {rows.length > 0 ? (
          <div className="w-full overflow-x-auto border-t border-line">
            <table className="w-full min-w-[880px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={HEAD}>Name</th>
                  <th scope="col" className={HEAD}>Ref</th>
                  <th scope="col" className={HEAD}>Town</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>Machines</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>Pending</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>Shelves</th>
                  {showSites ? <th scope="col" className={cn(HEAD, 'text-right')}>Sites</th> : null}
                  <th scope="col" className={HEAD}>Stock</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = customerHref(r.vantageId);
                  const stock = customerStockBadge(r.selfManaged);
                  return (
                    <CustomerTableRow key={r.vantageId} href={href}>
                      <td className={cn(CELL, 'max-w-[320px]')}>
                        <Link href={href} className="block truncate font-medium hover:text-brand hover:underline">
                          {r.name ?? `Customer ${r.vantageId}`}
                        </Link>
                        {r.deleted ? (
                          <ToneBadge tone="critical" dot={false} className="mt-1 px-2 py-0.5 text-[11px]">
                            Deleted in Vantage
                          </ToneBadge>
                        ) : null}
                      </td>
                      <td className={cn(CELL, 'font-mono text-[12px]')}>{r.reference ?? '—'}</td>
                      <td className={CELL}>{r.town ?? '—'}</td>
                      <td className={cn(CELL, 'text-right tabular')}>{formatNumber(r.machines)}</td>
                      <td className={cn(CELL, 'text-right tabular')}>{formatNumber(r.pending)}</td>
                      <td className={cn(CELL, 'text-right tabular')}>{formatNumber(r.shelves)}</td>
                      {showSites ? <td className={cn(CELL, 'text-right tabular')}>{formatNumber(r.sites)}</td> : null}
                      <td className={CELL}>
                        {stock.tone === 'muted' ? (
                          <span className="text-muted-foreground">{stock.text}</span>
                        ) : (
                          <ToneBadge tone={stock.tone} dot={false} className="px-2 py-0.5 text-[12px]">
                            {stock.text}
                          </ToneBadge>
                        )}
                      </td>
                    </CustomerTableRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t border-line px-5 py-10 text-center text-sm text-muted-foreground">
            {search ? `No customers match “${search}”.` : EMPTY[tab]}
          </p>
        )}

        <div className="border-t border-line px-5 py-3.5">
          <Pagination
            basePath="/customers"
            params={{ search: searchParam, tab: tabParam }}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            noun="customer"
          />
        </div>
      </section>
    </>
  );
}
