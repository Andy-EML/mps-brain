import Link from 'next/link';
import { AlertTriangle, PowerOff } from 'lucide-react';
import { getAppState } from '@mps/db';
import { getReplenishmentStats, listReplenishmentQueue, type QueueTab } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { replenishmentErrorMessage } from '@/components/replenishment';
import { ReplenishmentQueue } from '@/components/replenishment-queue';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';

export const metadata = { title: 'Toner orders · MPS Dashboard' };

const TABS: readonly QueueTab[] = ['review', 'in-progress', 'ordered', 'rejected'];

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
  const [devices, inProgress, stats, ordersEnabled] = await Promise.all([
    listReplenishmentQueue(db, { tab }),
    // The In progress tab's count. `openMpsOrders` is not it: that also counts orders already in
    // Vantage and not yet completed. The list is small (orders a person or the sender still owes).
    tab === 'in-progress' ? null : listReplenishmentQueue(db, { tab: 'in-progress' }),
    getReplenishmentStats(db),
    getAppState<boolean>(db, 'vantage_orders_enabled'),
  ]);
  const inProgressOrders = (inProgress ?? devices).reduce((n, d) => n + d.orders.length, 0);

  const tabs: FilterTab[] = [
    { value: 'review', label: <TabLabel label="Review" count={stats.awaitingReviewDevices} /> },
    { value: 'in-progress', label: <TabLabel label="In progress" count={inProgressOrders} /> },
    { value: 'ordered', label: 'Ordered' },
    { value: 'rejected', label: 'Rejected' },
  ];

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'Toner orders' }]} />

      <PageHeader
        title="Toner orders"
        subtitle="Proposals from low toner and DRMS consumable alarms. Nothing is ordered until someone approves it."
        actions={
          <dl className="flex items-start gap-10">
            <HeaderStat label="Awaiting review" value={stats.awaitingReviewDevices} tone={stats.awaitingReviewDevices > 0 ? 'warn' : undefined} />
            <HeaderStat label="Open orders" value={stats.openMpsOrders} />
            <HeaderStat label="Cartridges this quarter" value={stats.cartridgesThisQuarter} />
          </dl>
        }
      />

      {ordersEnabled !== true ? (
        // Live ordering is on the roadmap, not switched on: until then this is a record of decisions.
        // Still keyed on app_state, so it goes away by itself if sending is ever enabled.
        <div role="status" className="mb-4 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/5 px-5 py-4">
          <PowerOff aria-hidden className="mt-0.5 size-[18px] shrink-0 text-warn" />
          <p className="text-[14px] text-warn">
            Orders are not sent to Vantage yet — approving records the decision so the queue stays tidy. Raise the
            order in Vantage as usual.
          </p>
        </div>
      ) : null}

      {stats.attentionOrders > 0 ? (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-critical/30 bg-critical/5 px-5 py-4">
          <AlertTriangle aria-hidden className="mt-0.5 size-[18px] shrink-0 text-critical" />
          <p className="text-[14px] text-critical">
            {formatNumber(stats.attentionOrders)} {pluralise(stats.attentionOrders, 'order')}{' '}
            {stats.attentionOrders === 1 ? 'needs' : 'need'} a person — failed, or Vantage did not answer.{' '}
            {tab !== 'in-progress' ? (
              <Link href="/orders?tab=in-progress" className="font-medium underline underline-offset-2">
                Open In progress
              </Link>
            ) : null}
          </p>
        </div>
      ) : null}

      <section className="rounded-xl border border-line bg-card">
        <div className="border-b border-line px-5 py-4">
          <FilterTabs basePath="/orders" param="tab" current={tab} tabs={tabs} defaultValue="review" ariaLabel="Toner order queue" />
        </div>

        {error ? (
          <p role="alert" className="border-b border-line bg-critical/5 px-5 py-3 text-[13px] text-critical">
            {error}
          </p>
        ) : null}

        <ReplenishmentQueue tab={tab} devices={devices} />
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
