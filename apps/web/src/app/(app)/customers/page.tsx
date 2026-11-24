import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CUSTOMER_SORT_KEYS, listCustomerWarnings, listCustomers, type CustomerTab, type CustomerWarnings } from '@mps/db/queries';
import { cn } from 'cn';
import { CustomerAccordionRow } from '@/components/customer-accordion-row';
import {
  CUSTOMER_TABS,
  DEFAULT_CUSTOMER_TAB,
  customerStockBadge,
  parseCustomerSearchParams,
} from '@/components/customers';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { ListControls } from '@/components/list-controls';
import { SearchInput } from '@/components/search-input';
import { SortHeader } from '@/components/sort-header';
import { ToneBadge } from '@/components/tone-badge';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { lastPageOf, listHref, parseListState, rowsCookieName, sortSpec, stateParams } from '@/lib/list-state';

export const metadata = { title: 'Customers · MPS Dashboard' };

const LIST_KEY = 'customers';
const DEFAULT_ROWS = 50;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-4 py-3 align-middle text-[13px]';
const NO_WARNINGS: CustomerWarnings = { noReading: 0, pmOverdue: 0, pending: 0 };

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
 * its count; the search (name, reference, town) narrows the rows and the counts alike. A row
 * expands in place onto its machine lines (a head office on the Head offices tab: its sites), with
 * a red ! for any warning; the name opens the customer page.
 */
export default async function CustomersPage({ searchParams }: PageProps<'/customers'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const sp = await searchParams;
  // Tab and search from the customers helper; page, rows and sort from the shared list state.
  const { tab, search } = parseCustomerSearchParams(sp);
  const cookieStore = await cookies();
  const parsed = parseListState((name) => first(sp[name]), {
    listKey: LIST_KEY,
    defaultRows: DEFAULT_ROWS,
    sortKeys: CUSTOMER_SORT_KEYS,
    cookieRows: cookieStore.get(rowsCookieName(LIST_KEY))?.value,
  });
  const showSites = tab === 'head-offices';
  // Header cells (Name, Ref, Town, Machines, Pending, Shelves, [Sites], Stock): the panel's colSpan.
  const columns = showSites ? 8 : 7;
  // Sites is a column only on Head offices; a `sort=sites` carried to another tab is dropped there.
  const state = parsed.sort === 'sites' && !showSites ? { ...parsed, sort: null } : parsed;
  const page = state.page;

  const db = getDb();
  const { rows, total, counts } = await listCustomers(db, {
    tab,
    search: search || undefined,
    limit: state.rows,
    offset: (page - 1) * state.rows,
    sort: sortSpec(state),
  });
  // The red ! per row: this page's customers only, one set-wise call.
  const warnings = await listCustomerWarnings(db, rows.map((r) => r.vantageId));

  const tabParam = tab === DEFAULT_CUSTOMER_TAB ? undefined : tab;
  const searchParam = search || undefined;
  const keep = { search: searchParam, tab: tabParam };
  // Kept across a tab change or a new search (the page is not).
  const listParams = stateParams(state, { defaultRows: DEFAULT_ROWS });

  // A page number past the end (a stale bookmark, a bigger page size, or a search that shrank the
  // list) would otherwise show the empty state over a list that does have rows.
  const lastPage = lastPageOf(total, state.rows);
  if (page > lastPage) redirect(listHref('/customers', keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  const sorting = { basePath: '/customers', keep, state, defaultRows: DEFAULT_ROWS };
  const controls = { ...sorting, total, listKey: LIST_KEY, noun: 'customer' };
  // This view's own URL, so a customer page's Back link and breadcrumb return to it.
  const back = listHref('/customers', keep, state, {}, { defaultRows: DEFAULT_ROWS });

  const tabs: FilterTab[] = CUSTOMER_TABS.map((t) => ({
    value: t.value,
    label: `${t.label} (${formatNumber(counts[t.value])})`,
  }));

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
            hiddenParams={{ tab: tabParam, ...listParams }}
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
            params={{ search: searchParam, ...listParams }}
            ariaLabel="Filter customers"
          />
        </div>

        <ListControls {...controls} className="border-t border-line px-5 py-3.5" />

        {rows.length > 0 ? (
          <div className="w-full overflow-x-auto border-t border-line">
            <table className="w-full min-w-[880px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <SortHeader label="Name" sortKey="name" className={HEAD} {...sorting} />
                  <SortHeader label="Ref" sortKey="ref" className={HEAD} {...sorting} />
                  <SortHeader label="Town" sortKey="town" className={HEAD} {...sorting} />
                  <SortHeader label="Machines" sortKey="machines" align="right" className={HEAD} {...sorting} />
                  <SortHeader label="Pending" sortKey="pending" align="right" className={HEAD} {...sorting} />
                  <SortHeader label="Shelves" sortKey="shelves" align="right" className={HEAD} {...sorting} />
                  {showSites ? (
                    <SortHeader label="Sites" sortKey="sites" align="right" className={HEAD} {...sorting} />
                  ) : null}
                  <SortHeader label="Stock" sortKey="stock" className={HEAD} {...sorting} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const stock = customerStockBadge(r.selfManaged);
                  return (
                    <CustomerAccordionRow
                      key={r.vantageId}
                      row={r}
                      warnings={warnings.get(r.vantageId) ?? NO_WARNINGS}
                      back={back}
                      columns={columns}
                    >
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
                    </CustomerAccordionRow>
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

        <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
      </section>
    </>
  );
}
