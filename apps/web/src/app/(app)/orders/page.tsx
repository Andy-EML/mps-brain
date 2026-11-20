import Link from 'next/link';
import { Info } from 'lucide-react';
import { getReplenishmentStats, getYieldCheckForProposals, listReplenishmentQueue, type QueueTab } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { replenishmentErrorMessage } from '@/components/replenishment';
import { ReplenishmentQueue } from '@/components/replenishment-queue';
import { YieldChecksProvider, type YieldChecks } from '@/components/yield-note';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber } from '@/lib/format';

export const metadata = { title: 'Toner orders · MPS Dashboard' };

const TABS: readonly QueueTab[] = ['review', 'on-site', 'in-progress', 'ordered', 'rejected'];

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

  const db = getDb();
  const [devices, inProgress, stats] = await Promise.all([
    listReplenishmentQueue(db, { tab }),
    // The In progress tab's count. `openMpsOrders` is not it: that also counts orders already in
    // Vantage and not yet completed. The list is small (orders still waiting for their sales order).
    tab === 'in-progress' ? null : listReplenishmentQueue(db, { tab: 'in-progress' }),
    getReplenishmentStats(db),
  ]);
  const inProgressOrders = (inProgress ?? devices).reduce((n, d) => n + d.orders.length, 0);

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
          <FilterTabs basePath="/orders" param="tab" current={tab} tabs={tabs} defaultValue="review" ariaLabel="Toner order queue" />
          <Link href="/orders/yield" className="text-[13px] font-medium text-brand hover:underline">
            Toner yield
          </Link>
        </div>

        {error ? (
          <p role="alert" className="border-b border-line bg-critical/5 px-5 py-3 text-[13px] text-critical">
            {error}
          </p>
        ) : null}

        <YieldChecksProvider checks={yieldChecks}>
          <ReplenishmentQueue tab={tab} devices={devices} />
        </YieldChecksProvider>
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
