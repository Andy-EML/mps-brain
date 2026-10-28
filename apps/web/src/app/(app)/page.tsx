import Link from 'next/link';
import {
  getCollectionStatus,
  getConsumableWarnings,
  getCustomerCount,
  getFleetSummary,
  getIssueCounts,
  getReconnectCounts,
  getReplenishmentStats,
  getTonerHealth,
  listDeviceFilterOptions,
  listDevices,
} from '@mps/db/queries';
import { CollectionOutageBanner } from '@/components/collection-outage-banner';
import { DeviceFilterBar } from '@/components/device-filter-bar';
import { DeviceTable } from '@/components/device-table';
import { PageHeader } from '@/components/page-header';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { issueTypeLabel, topIssueType } from '@/components/toner';
import { TonerLegend } from '@/components/toner-bar';
import { TonerHealthCard } from '@/components/toner-health-card';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceFilterParams, hasDeviceFilters, parseDeviceFilters } from '@/lib/device-filters';
import { formatNumber, formatRelative, pluralise } from '@/lib/format';
import { hrefWith } from '@/lib/href';

export const metadata = { title: 'Fleet overview · MPS Dashboard' };

/** Rows shown on the overview before you have to go to /devices. */
const PREVIEW_ROWS = 8;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function FleetOverviewPage({ searchParams }: PageProps<'/'>) {
  await requireUser();
  const params = await searchParams;
  const db = getDb();
  const now = new Date();
  // The same filters as /devices, over the preview; "View all devices" carries them across.
  const filters = parseDeviceFilters((name) => first(params[name]));
  const filterParams = deviceFilterParams(filters);
  const filtered = hasDeviceFilters(filters);

  const [summary, health, customers, issueCounts, preview, warnings, collection, replenishment, reconnect, options] = await Promise.all([
    getFleetSummary(db),
    getTonerHealth(db),
    getCustomerCount(db),
    getIssueCounts(db, { status: 'open' }),
    listDevices(db, { ...filters, limit: PREVIEW_ROWS }),
    getConsumableWarnings(db),
    getCollectionStatus(db),
    getReplenishmentStats(db, now),
    getReconnectCounts(db, { now }),
    listDeviceFilterOptions(db),
  ]);

  const warningDevices = new Set(warnings.map((w) => w.drmsId)).size;
  const topIssue = topIssueType(issueCounts);

  const subtitle = `${formatNumber(summary.devices)} ${pluralise(summary.devices, 'device')} · ${formatNumber(
    customers,
  )} ${pluralise(customers, 'customer')} · ${
    summary.lastSyncAt ? `synced ${formatRelative(summary.lastSyncAt, now)}` : 'never synced'
  }`;

  return (
    <>
      <PageHeader
        title="Fleet overview"
        subtitle={subtitle}
        actions={<SearchInput action="/devices" className="w-[280px]" />}
      />

      <CollectionOutageBanner status={collection} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label="Total devices"
          value={formatNumber(summary.devices)}
          sub={`${formatNumber(summary.monitored)} monitored · ${formatNumber(summary.linked)} linked`}
        />
        <StatCard
          label="Needs toner"
          value={formatNumber(summary.needsToner)}
          tone={summary.needsToner > 0 ? 'warn' : 'muted'}
          sub={`${formatNumber(replenishment.awaitingReviewDevices)} awaiting review · ${formatNumber(replenishment.onOrderDevices)} on order`}
          href="/orders"
        />
        {/* Not "Offline": the number only says DRMS collected no counter set. While collection is
            behind, most of that number is devices the batch has not reached yet — a statement
            about DRMS, not about the devices — so the card refuses to quote a device count. */}
        <StatCard
          label="No meter reading"
          value={collection.outage ? '—' : formatNumber(summary.offline)}
          tone={collection.outage ? 'warn' : summary.offline > 0 ? 'critical' : 'muted'}
          sub={collection.outage ? 'collection behind' : 'in the last 24h'}
        />
        {/* Silent devices only: a machine that has never sent a meter reading can't be called silent. */}
        <StatCard
          label="Needs reconnecting"
          value={formatNumber(reconnect.silent)}
          tone={reconnect.newlySilent > 0 ? 'warn' : 'muted'}
          sub={`${formatNumber(reconnect.newlySilent)} went quiet in the last 30 days`}
          href="/reconnect"
        />
        <StatCard
          label="Consumable warnings"
          value={formatNumber(warningDevices)}
          tone={warningDevices > 0 ? 'warn' : 'muted'}
          sub="waste or parts alarm in 30 days"
        />
        <StatCard
          label="Open link issues"
          value={formatNumber(summary.openIssues)}
          tone={summary.openIssues > 0 ? 'warn' : 'muted'}
          sub={topIssue ? `most: ${issueTypeLabel(topIssue.type)} (${formatNumber(topIssue.count)})` : 'none open'}
        />
      </div>

      <TonerHealthCard
        className="mt-4"
        ok={health.healthy}
        low={health.low}
        critical={health.critical}
        total={health.cartridges}
        devicesWithCounters={health.devices}
      />

      <section className="mt-4 rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <h2 className="text-[15px] font-medium">Devices</h2>
          <TonerLegend />
        </div>
        <DeviceFilterBar basePath="/" filters={filters} options={options} className="px-5 pb-4" />
        <DeviceTable
          from="fleet"
          back={hrefWith('/', filterParams)}
          rows={preview.rows}
          now={now}
          emptyMessage={filtered ? 'No devices match these filters.' : 'No devices have been synced yet.'}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          <p className="text-sm text-muted-foreground">
            Showing {formatNumber(preview.rows.length)} of {formatNumber(preview.total)}{' '}
            {filtered ? `matching ${pluralise(preview.total, 'device')}` : pluralise(preview.total, 'device')}, customer A–Z
          </p>
          <Link href={hrefWith('/devices', filterParams)} className="text-sm font-medium text-brand hover:underline">
            View all devices
          </Link>
        </div>
      </section>
    </>
  );
}
