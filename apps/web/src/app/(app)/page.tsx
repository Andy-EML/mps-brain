import Link from 'next/link';
import { getConsumableWarnings, getCustomerCount, getFleetSummary, getIssueCounts, getTonerHealth, listDevices } from '@mps/db/queries';
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

  const [summary, health, customers, issueCounts, preview, warnings] = await Promise.all([
    getFleetSummary(db),
    getTonerHealth(db),
    getCustomerCount(db),
    getIssueCounts(db, { status: 'open' }),
    listDevices(db, { limit: PREVIEW_ROWS, sort: 'urgent' }),
    getConsumableWarnings(db),
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
        <StatCard
          label="Offline"
          value={formatNumber(summary.offline)}
          tone={summary.offline > 0 ? 'critical' : 'muted'}
          sub="not reported in 24h"
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
