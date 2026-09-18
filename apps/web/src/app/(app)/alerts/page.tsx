import { countAlerts, listAlerts, type AlertStatus } from '@mps/db/queries';
import { AlertTable } from '@/components/alert-table';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';

export const metadata = { title: 'Alerts · MPS Dashboard' };

/**
 * Alerts are one row per device per type, so the list is bounded by the fleet (~1,000). Cleared
 * alerts accumulate over time, which is the one tab that could outgrow this; 200 is well clear of
 * anything the worker can produce in a year and keeps the page a single query with no pager.
 */
const LIMIT = 200;

const TABS = [
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'cleared', label: 'Cleared' },
] as const satisfies readonly { value: AlertStatus; label: string }[];

const DEFAULT_STATUS: AlertStatus = 'open';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** An empty tab should read as an answer, not as a failure. */
const EMPTY: Record<AlertStatus, string> = {
  open: 'No open alerts — every device that has reported counters before has reported recently.',
  acknowledged: 'No alerts have been acknowledged.',
  cleared: 'No alerts have cleared yet. An alert clears by itself when the device reports again.',
};

export default async function AlertsPage({ searchParams }: PageProps<'/alerts'>) {
  // First statement, before anything else touches the request: the (app) layout's own
  // requireUser() does not gate this page, because Next fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const requested = first(params.status);
  const status: AlertStatus = TABS.some((t) => t.value === requested) ? (requested as AlertStatus) : DEFAULT_STATUS;

  const db = getDb();
  const [rows, counts] = await Promise.all([listAlerts(db, { status, limit: LIMIT }), countAlerts(db)]);

  const tabs: FilterTab[] = TABS.map((tab) => ({
    value: tab.value,
    label: (
      <>
        {tab.label}
        <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(counts[tab.value])}</span>
      </>
    ),
  }));

  // Counted as alerts, not as devices: the fleet page's "offline" figure is a live reading of
  // `last_counter_received_time`, whereas an alert is a row the worker opened and has not cleared.
  // The two are usually the same number, but saying "N devices" here would claim they always are.
  const unresolved = counts.open + counts.acknowledged;
  const subtitle = `${formatNumber(unresolved)} ${pluralise(unresolved, 'alert')} not yet cleared · ${formatNumber(
    counts.acknowledged,
  )} acknowledged`;

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={subtitle}
        actions={
          <FilterTabs
            basePath="/alerts"
            param="status"
            current={status}
            tabs={tabs}
            defaultValue={DEFAULT_STATUS}
            ariaLabel="Filter alerts by status"
          />
        }
      />

      <p className="mb-5 max-w-3xl rounded-xl border border-line bg-card px-5 py-4 text-sm text-muted-foreground">
        A device alerts when it has reported counters before but hasn’t for more than 24 hours. DRMS collects counters
        once a day, so a device that misses one collection can show as 24–48 hours stale.
      </p>

      <section className="rounded-xl border border-line bg-card">
        <AlertTable rows={rows} emptyMessage={EMPTY[status]} />
        {rows.length === LIMIT ? (
          <p className="border-t border-line px-5 py-3.5 text-xs text-muted-foreground">
            Showing the {formatNumber(LIMIT)} most recent alerts.
          </p>
        ) : null}
      </section>
    </>
  );
}
