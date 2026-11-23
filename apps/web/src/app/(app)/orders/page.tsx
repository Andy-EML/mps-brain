import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ArrowDown, ArrowUp, Info } from 'lucide-react';
import {
  QUEUE_SORT_KEYS,
  getReplenishmentStats,
  getYieldCheckForProposals,
  listReplenishmentQueue,
  listReplenishmentQueuePage,
  sortQueueDevices,
  type QueueSortKey,
  type QueueTab,
} from '@mps/db/queries';
import { cn } from 'cn';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { ListControls } from '@/components/list-controls';
import { PageHeader } from '@/components/page-header';
import { replenishmentErrorMessage } from '@/components/replenishment';
import { ReplenishmentQueue } from '@/components/replenishment-queue';
import { YieldChecksProvider, type YieldChecks } from '@/components/yield-note';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber } from '@/lib/format';
import { ORDERS_DEFAULT_ROWS, ordersKeep, queueDefaultSort } from '@/lib/list-keep';
import {
  lastPageOf,
  listHref,
  parseListState,
  rowsCookieName,
  sortSpec,
  stateParams,
  type ListState,
} from '@/lib/list-state';

export const metadata = { title: 'Toner orders · MPS Dashboard' };

const TABS: readonly QueueTab[] = ['review', 'on-site', 'in-progress', 'ordered', 'rejected'];

const LIST_KEY = 'orders';
const DEFAULT_ROWS = ORDERS_DEFAULT_ROWS;

/** The "Sort by" choices: the queue is a card list with no header row to click. */
const SORT_CHOICES: readonly { key: QueueSortKey; label: string }[] = [
  { key: 'urgency', label: 'Most urgent' },
  { key: 'recent', label: 'Most recent' },
  { key: 'customer', label: 'Customer' },
  { key: 'device', label: 'Device' },
];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function OrdersPage({ searchParams }: PageProps<'/orders'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const requested = first(params.tab);
  const tab: QueueTab = TABS.includes(requested as QueueTab) ? (requested as QueueTab) : 'review';
  const errorCode = first(params.error);
  const error = errorCode ? replenishmentErrorMessage(errorCode) : null;
  const cookieStore = await cookies();
  const state = parseListState((name) => first(params[name]), {
    listKey: LIST_KEY,
    defaultRows: DEFAULT_ROWS,
    sortKeys: QUEUE_SORT_KEYS,
    cookieRows: cookieStore.get(rowsCookieName(LIST_KEY))?.value,
  });

  const db = getDb();
  const offset = (state.page - 1) * state.rows;
  // The In progress tab's count. `openMpsOrders` is not it: that also counts orders already in
  // Vantage and not yet completed. The list is small (orders still waiting for their sales order),
  // so it is loaded whole — and on the In progress tab that one load is also the page's list.
  const inProgressLoad = listReplenishmentQueue(db, { tab: 'in-progress', limit: Number.MAX_SAFE_INTEGER });
  const pageLoad =
    tab === 'in-progress'
      ? inProgressLoad.then((all) => ({
          rows: sortQueueDevices(all, tab, sortSpec(state)).slice(offset, offset + state.rows),
          total: all.length,
        }))
      : listReplenishmentQueuePage(db, { tab, sort: sortSpec(state), limit: state.rows, offset });
  const [{ rows: devices, total }, inProgress, stats] = await Promise.all([pageLoad, inProgressLoad, getReplenishmentStats(db)]);
  const inProgressOrders = inProgress.reduce((n, d) => n + d.orders.length, 0);

  // Pager, rows picker and Sort by keep the tab (Review Focus 4); `error` is not kept, so moving
  // on dismisses it.
  const keep = ordersKeep(tab);
  const lastPage = lastPageOf(total, state.rows);
  if (state.page > lastPage) redirect(listHref('/orders', keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  // Sort and page size survive a change of tab; the page does not.
  const listParams = stateParams(state, { defaultRows: DEFAULT_ROWS });
  const controls = { basePath: '/orders', keep, state, defaultRows: DEFAULT_ROWS, total, listKey: LIST_KEY, noun: 'device' };
  // This list's own URL: device links return to it and decision forms post it back.
  const back = listHref('/orders', keep, state, {}, { defaultRows: DEFAULT_ROWS });

  // Toner yield ("Last ordered … · N pages since"), one batched call for every live proposal shown.
  const liveIds = devices.flatMap((d) => d.proposals.filter((p) => p.status === 'pending' || p.status === 'approved').map((p) => p.id));
  const yieldChecks: YieldChecks = Object.fromEntries(await getYieldCheckForProposals(db, liveIds));

  const tabs: FilterTab[] = [
    { value: 'review', label: <TabLabel label="Review" count={stats.awaitingReviewDevices} /> },
    { value: 'on-site', label: <TabLabel label="Probably on site" count={stats.onSiteDevices} /> },
    { value: 'in-progress', label: <TabLabel label="In progress" count={inProgressOrders} /> },
    { value: 'ordered', label: 'Ordered' },
    { value: 'rejected', label: 'Rejected' },
  ];

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'Toner orders' }]} />

      <PageHeader
        title="Toner orders"
        subtitle="Proposals from low toner and DRMS consumable alarms. Nothing is queued until someone approves it."
        actions={
          <dl className="flex items-start gap-10">
            <HeaderStat label="Awaiting review" value={stats.awaitingReviewDevices} tone={stats.awaitingReviewDevices > 0 ? 'warn' : undefined} />
            <HeaderStat label="Open orders" value={stats.openMpsOrders} />
            <HeaderStat label="Cartridges this quarter" value={stats.cartridgesThisQuarter} />
          </dl>
        }
      />

      {/* The app never places a Vantage order, so this is permanent, not a stand-in for a switch. */}
      <div role="note" className="mb-4 flex items-start gap-3 rounded-xl border border-line bg-muted/30 px-5 py-4">
        <Info aria-hidden className="mt-0.5 size-[18px] shrink-0 text-muted-foreground" />
        <p className="text-[14px] text-muted-foreground">
          Approving records the decision; it does not place an order. Raise the order in Vantage as usual, and it
          moves out of In progress by itself when the sales order shows up in the hourly sales-order sync.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <FilterTabs
            basePath="/orders"
            param="tab"
            current={tab}
            tabs={tabs}
            defaultValue="review"
            params={listParams}
            ariaLabel="Toner order queue"
          />
          <div className="flex flex-wrap items-center gap-4">
            <SortBy tab={tab} keep={keep} state={state} />
            <Link href="/orders/yield" className="text-[13px] font-medium text-brand hover:underline">
              Toner yield
            </Link>
          </div>
        </div>

        {error ? (
          <p role="alert" className="border-b border-line bg-critical/5 px-5 py-3 text-[13px] text-critical">
            {error}
          </p>
        ) : null}

        <ListControls {...controls} className="border-b border-line px-5 py-3.5" />

        <YieldChecksProvider checks={yieldChecks}>
          <ReplenishmentQueue tab={tab} devices={devices} back={back} />
        </YieldChecksProvider>

        <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
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

/**
 * "Sort by" as links. No `sort` param is the tab's own order (most urgent on Review / Probably on
 * site, most recent elsewhere), so that choice links back to no param. Clicking the active choice
 * flips its direction (an arrow shows when it is reversed or a name sort is chosen).
 */
function SortBy({
  tab,
  keep,
  state,
}: {
  tab: QueueTab;
  keep: Record<string, string | undefined>;
  state: ListState<QueueSortKey>;
}) {
  const fallback = queueDefaultSort(tab);
  const current = state.sort ?? fallback;
  return (
    <nav aria-label="Sort toner orders" className="flex flex-wrap items-center gap-1 text-[13px]">
      <span className="mr-1 text-muted-foreground">Sort by</span>
      {SORT_CHOICES.map(({ key, label }) => {
        const active = key === current;
        const change: Partial<ListState<QueueSortKey>> = active
          ? { sort: key, dir: state.sort !== null && state.dir === 'desc' ? 'asc' : 'desc' }
          : key === fallback
            ? { sort: null, dir: 'asc' }
            : { sort: key, dir: 'asc' };
        const showArrow = active && (state.dir === 'desc' || key === 'customer' || key === 'device');
        const Arrow = state.dir === 'desc' ? ArrowDown : ArrowUp;
        return (
          <Link
            key={key}
            href={listHref('/orders', keep, state, change, { defaultRows: DEFAULT_ROWS })}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors',
              active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {label}
            {showArrow ? <Arrow role="img" aria-label={state.dir === 'desc' ? 'reversed' : 'ascending'} className="size-3.5" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** The small right-aligned figures in the mockup's header ("Open orders 5"). */
function HeaderStat({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
  return (
    <div className="text-right">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 text-[22px] leading-none font-semibold tabular-nums ${tone === 'warn' ? 'text-warn' : ''}`}>
        {formatNumber(value)}
      </dd>
    </div>
  );
}
