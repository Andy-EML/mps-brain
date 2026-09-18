import { countAlerts, getCollectionStatus, listAlerts, type AlertStatus } from '@mps/db/queries';
import { AlertTable } from '@/components/alert-table';
import { CollectionOutageBanner } from '@/components/collection-outage-banner';
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
  open: 'No open alerts — every device that has reported a meter reading before has reported recently.',
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
  const [rows, counts, collection] = await Promise.all([
    listAlerts(db, { status, limit: LIMIT }),
    countAlerts(db),
    getCollectionStatus(db),
  ]);

  const tabs: FilterTab[] = TABS.map((tab) => ({
    value: tab.value,
    label: (
      <>
        {tab.label}
        <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(counts[tab.value])}</span>
      </>
    ),
  }));

  // Counted as alerts, not as devices: the fleet page's "no meter reading" figure is a live
  // reading of `last_counter_received_time`, whereas an alert is a row the worker opened and has
  // not cleared. The two are usually the same number, but saying "N devices" here would claim
  // they always are — and during a collection outage the worker opens nothing at all.
  const unresolved = counts.open + counts.acknowledged;
  const subtitle = `${formatNumber(unresolved)} ${pluralise(unresolved, 'alert')} not yet cleared · ${formatNumber(
    counts.acknowledged,
  )} acknowledged`;

  return (
    <>
      {/* Above the tabs on purpose: during an outage the Open tab is expected to stay empty, and
          that only makes sense once you have read why. */}
      <CollectionOutageBanner status={collection} />

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
        A device alerts when DRMS has collected a meter reading for it before but none in the last 24 hours. That means
        “no meter reading”, not “offline” — DRMS collects counters about once a day, so a device that misses one
        collection shows as 24–48 hours stale. When every reporting device goes quiet at once, no alerts are opened:
        that is a collection outage, not a fleet of broken devices.
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
