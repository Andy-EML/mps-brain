import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ALERT_SORT_KEYS, countAlerts, getCollectionStatus, listAlertsPage, type AlertStatus } from '@mps/db/queries';
import { AlertTable } from '@/components/alert-table';
import { CollectionOutageBanner } from '@/components/collection-outage-banner';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { ListControls } from '@/components/list-controls';
import { PageHeader } from '@/components/page-header';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { ALERTS_DEFAULT_ROWS } from '@/lib/list-keep';
import { lastPageOf, listHref, parseListState, rowsCookieName, sortSpec, stateParams } from '@/lib/list-state';

export const metadata = { title: 'Alerts · MPS Dashboard' };

/** Alerts are one row per device per type; Cleared accumulates over time, so every tab is paged. */
const LIST_KEY = 'alerts';
const DEFAULT_ROWS = ALERTS_DEFAULT_ROWS;

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
  const cookieStore = await cookies();
  const state = parseListState((name) => first(params[name]), {
    listKey: LIST_KEY,
    defaultRows: DEFAULT_ROWS,
    sortKeys: ALERT_SORT_KEYS,
    cookieRows: cookieStore.get(rowsCookieName(LIST_KEY))?.value,
  });

  const db = getDb();
  const [{ rows, total }, counts, collection] = await Promise.all([
    listAlertsPage(db, { status, sort: sortSpec(state), limit: state.rows, offset: (state.page - 1) * state.rows }),
    countAlerts(db),
    getCollectionStatus(db),
  ]);

  const keep = { status: status === DEFAULT_STATUS ? undefined : status };
  const lastPage = lastPageOf(total, state.rows);
  if (state.page > lastPage) redirect(listHref('/alerts', keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  // Sort and page size survive a change of tab; the page does not.
  const listParams = stateParams(state, { defaultRows: DEFAULT_ROWS });
  const sorting = { basePath: '/alerts', keep, state, defaultRows: DEFAULT_ROWS };
  const controls = { ...sorting, total, listKey: LIST_KEY, noun: 'alert' };

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
            params={listParams}
          />
        }
      />

      <p className="mb-5 max-w-3xl rounded-xl border border-line bg-card px-5 py-4 text-sm text-muted-foreground">
        A device alerts when DRMS has collected a meter reading for it before but none in the last 24 hours. That means
        “no meter reading”, not “offline” — DRMS collects counters about once a day, so a device that misses one
        collection shows as 24–48 hours stale. When most of the reporting fleet is stale at once, no alerts are
        opened: the collection is behind, not the devices.
      </p>

      <section className="rounded-xl border border-line bg-card">
        <ListControls {...controls} className="border-b border-line px-5 py-3.5" />
        <AlertTable
          rows={rows}
          emptyMessage={EMPTY[status]}
          sorting={sorting}
          back={listHref('/alerts', keep, state, {}, { defaultRows: DEFAULT_ROWS })}
        />
        <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
      </section>
    </>
  );
}
