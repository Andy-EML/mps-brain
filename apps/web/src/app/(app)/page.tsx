import Link from 'next/link';
import {
  getCollectionStatus,
  getConsumableWarnings,
  getCustomerCount,
  getFleetSummary,
  getIssueCounts,
  getTonerHealth,
  listDevices,
} from '@mps/db/queries';
import { CollectionOutageBanner } from '@/components/collection-outage-banner';
import { DeviceTable } from '@/components/device-table';
import { PageHeader } from '@/components/page-header';
import { SearchInput } from '@/components/search-input';
import { StatCard } from '@/components/stat-card';
import { issueTypeLabel, topIssueType } from '@/components/toner';
import { TonerLegend } from '@/components/toner-bar';
import { TonerHealthCard } from '@/components/toner-health-card';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, formatRelative, pluralise } from '@/lib/format';

export const metadata = { title: 'Fleet overview · MPS Dashboard' };

/** Rows shown on the overview before you have to go to /devices. */
const PREVIEW_ROWS = 8;

export default async function FleetOverviewPage() {
  await requireUser();
  const db = getDb();
  const now = new Date();

  const [summary, health, customers, issueCounts, preview, warnings, collection] = await Promise.all([
    getFleetSummary(db),
    getTonerHealth(db),
    getCustomerCount(db),
    getIssueCounts(db, { status: 'open' }),
    listDevices(db, { limit: PREVIEW_ROWS, sort: 'urgent' }),
    getConsumableWarnings(db),
    getCollectionStatus(db),
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Total devices"
          value={formatNumber(summary.devices)}
          sub={`${formatNumber(summary.monitored)} monitored · ${formatNumber(summary.linked)} linked`}
        />
        <StatCard
          label="Needs toner"
          value={formatNumber(summary.needsToner)}
          tone={summary.needsToner > 0 ? 'warn' : 'muted'}
          sub={`${formatNumber(summary.criticalToner)} critical · ${formatNumber(summary.lowToner)} low`}
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
        <DeviceTable rows={preview.rows} now={now} emptyMessage="No devices have been synced yet." />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3.5">
          <p className="text-sm text-muted-foreground">
            Showing {formatNumber(preview.rows.length)} of {formatNumber(summary.devices)}{' '}
            {pluralise(summary.devices, 'device')}, most urgent first
          </p>
          <Link href="/devices" className="text-sm font-medium text-brand hover:underline">
            View all devices
          </Link>
        </div>
      </section>
    </>
  );
}
