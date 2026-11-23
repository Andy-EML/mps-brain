import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  DEVICE_SORT_KEYS,
  HIDDEN_SORT_KEYS,
  countHiddenDevices,
  listDeviceFilterOptions,
  listDevices,
  listHiddenDevices,
  type DeviceListOptions,
} from '@mps/db/queries';
import { DeviceFilterBar } from '@/components/device-filter-bar';
import { BulkResultToast, BulkSettingsBar, DeviceSelectionProvider } from '@/components/device-selection';
import { DeviceTable } from '@/components/device-table';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { HiddenDeviceTable } from '@/components/hidden-device-table';
import { ListControls } from '@/components/list-controls';
import { PageHeader } from '@/components/page-header';
import { SearchInput } from '@/components/search-input';
import { TonerLegend } from '@/components/toner-bar';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceFilterParams, hasDeviceFilters, parseDeviceFilters } from '@/lib/device-filters';
import { formatNumber, pluralise } from '@/lib/format';
import { hideErrorMessage } from '@/lib/hide-device';
import { DEVICES_DEFAULT_ROWS, HIDDEN_DEFAULT_ROWS } from '@/lib/device-list';
import { lastPageOf, listHref, parseListState, rowsCookieName, sortSpec, stateParams } from '@/lib/list-state';
import { settingsErrorMessage } from '@/lib/settings-form';

export const metadata = { title: 'Devices · MPS Dashboard' };

// The `offline` value is the stored/URL one and stays put so existing links keep working; what it
// really selects is "DRMS collected no meter reading in 24h", which is what the label says.
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'needs-toner', label: 'Needs toner' },
  { value: 'manual', label: 'Manual replenishment' },
  { value: 'offline', label: 'No meter reading' },
  { value: 'unlinked', label: 'Not linked' },
] as const satisfies readonly (FilterTab & { value: NonNullable<DeviceListOptions['filter']> })[];

type Filter = (typeof FILTERS)[number]['value'];

/**
 * The *Hidden* tab sits beside the filters but is not one: it lists the devices every other tab
 * leaves out (`listHiddenDevices`), with who hid each and why, and has none of the list's filters,
 * toner bars or bulk bar.
 */
const HIDDEN = 'hidden';
type Tab = Filter | typeof HIDDEN;

const EMPTY: Record<Filter, string> = {
  all: 'No devices have been synced yet.',
  'needs-toner': 'No device is below its replenishment threshold.',
  manual: 'No device with auto-replenishment switched off is below its threshold.',
  offline: 'DRMS has collected a meter reading in the last 24 hours for every device that has ever reported one.',
  unlinked: 'Every DRMS device is linked to Vantage equipment.',
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DevicesPage({ searchParams }: PageProps<'/devices'>) {
  await requireUser();
  const params = await searchParams;

  const search = first(params.search)?.trim() || undefined;
  const requested = first(params.filter);
  const tab: Tab =
    requested === HIDDEN ? HIDDEN : FILTERS.some((f) => f.value === requested) ? (requested as Filter) : 'all';
  const filters = parseDeviceFilters((name) => first(params[name]));
  const get = (name: string) => first(params[name]);
  const cookieStore = await cookies();

  const db = getDb();
  const now = new Date();
  const hiddenCount = await countHiddenDevices(db);
  const tabs: FilterTab[] = [
    ...FILTERS,
    { value: HIDDEN, label: hiddenCount > 0 ? `Hidden (${formatNumber(hiddenCount)})` : 'Hidden' },
  ];

  // What the bulk actions and Unhide redirected back with; `BulkResultToast` reports and drops it.
  const count = (name: string) => {
    const n = Number.parseInt(first(params[name]) ?? '', 10);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const hideErrorCode = first(params.hideError);
  const hideError = hideErrorCode ? hideErrorMessage(hideErrorCode) : undefined;

  if (tab === HIDDEN) {
    const listKey = 'hidden';
    const defaultRows = HIDDEN_DEFAULT_ROWS;
    const state = parseListState(get, {
      listKey,
      defaultRows,
      sortKeys: HIDDEN_SORT_KEYS,
      cookieRows: cookieStore.get(rowsCookieName(listKey))?.value,
    });
    const hidden = await listHiddenDevices(db, {
      search,
      limit: state.rows,
      offset: (state.page - 1) * state.rows,
      sort: sortSpec(state),
    });
    const keep = { search, filter: HIDDEN };
    // A page past the end (a stale bookmark, a bigger page size, a search that shrank the list)
    // goes to the last page rather than showing the empty state over a list that has rows.
    const lastPage = lastPageOf(hidden.total, state.rows);
    if (state.page > lastPage) redirect(listHref('/devices', keep, state, { page: lastPage }, { defaultRows }));
    const listParams = stateParams(state, { defaultRows });
    const controls = { basePath: '/devices', keep, state, total: hidden.total, listKey, defaultRows };
    const counted = `${formatNumber(hidden.total)} hidden ${pluralise(hidden.total, 'device')}`;
    return (
      <>
        <PageHeader
          title="Devices"
          subtitle={search ? `${counted} matching “${search}”` : counted}
          actions={
            <SearchInput action="/devices" defaultValue={search} hiddenParams={{ filter: HIDDEN, ...listParams }} className="w-[320px]" />
          }
        />
        <BulkResultToast unhid={count('unhid')} error={hideError} />
        <section className="rounded-xl border border-line bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <FilterTabs basePath="/devices" current={HIDDEN} tabs={tabs} params={{ search, ...listParams }} />
          </div>
          <p className="px-5 pb-4 text-[13px] text-muted-foreground">
            Hidden devices are left out of every other list and count, and get no toner proposals or alerts. Unhide
            one to bring it back; the next evaluation run may propose toner for it again.
          </p>
          <ListControls {...controls} className="border-t border-line px-5 py-3.5" />
          <HiddenDeviceTable
            rows={hidden.rows}
            search={search}
            page={state.page}
            listParams={listParams}
            sorting={{ basePath: '/devices', keep, state, defaultRows }}
            back={listHref('/devices', keep, state, {}, { defaultRows })}
            emptyMessage={search ? `No hidden devices match “${search}”.` : 'No devices are hidden.'}
            className="border-t border-line"
          />
          <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
        </section>
      </>
    );
  }

  const filter: Filter = tab;
  const listKey = 'devices';
  const defaultRows = DEVICES_DEFAULT_ROWS;
  const state = parseListState(get, {
    listKey,
    defaultRows,
    sortKeys: DEVICE_SORT_KEYS,
    cookieRows: cookieStore.get(rowsCookieName(listKey))?.value,
  });
  const page = state.page;
  const [{ rows, total }, options] = await Promise.all([
    listDevices(db, {
      search,
      filter,
      ...filters,
      limit: state.rows,
      offset: (page - 1) * state.rows,
      sort: sortSpec(state),
    }),
    listDeviceFilterOptions(db),
  ]);

  // Carried on the tab links, the filter bar and the pager so changing one control keeps the others.
  const filterParam = filter === 'all' ? undefined : filter;
  const filterParams = deviceFilterParams(filters);
  const filtered = hasDeviceFilters(filters);
  // Sort, direction and page size survive a change of tab, filter or search; the page does not.
  const listParams = stateParams(state, { defaultRows });
  const keep = { search, filter: filterParam, ...filterParams };

  // A page number past the end (a stale bookmark, a bigger page size, or a search that shrank the
  // result set) would otherwise render the "nothing here" empty state over a list that has rows.
  const lastPage = lastPageOf(total, state.rows);
  if (page > lastPage) redirect(listHref('/devices', keep, state, { page: lastPage }, { defaultRows }));
  const controls = { basePath: '/devices', keep, state, total, listKey, defaultRows };
  const settingsErrorCode = first(params.settingsError);
  const settingsError = settingsErrorCode ? settingsErrorMessage(settingsErrorCode) : undefined;

  const counted = `${formatNumber(total)} ${pluralise(total, 'device')}`;
  const subtitle = search ? `${counted} matching “${search}”` : filtered ? `${counted} matching the filters` : counted;

  return (
    <>
      <PageHeader
        title="Devices"
        subtitle={subtitle}
        actions={
          <SearchInput
            action="/devices"
            defaultValue={search}
            hiddenParams={{ filter: filterParam, ...filterParams, ...listParams }}
            className="w-[320px]"
          />
        }
      />

      {/* Keyed on the view, so changing the search, tab, filters or page starts a fresh selection. */}
      <DeviceSelectionProvider
        key={JSON.stringify([search, filter, filterParams, page, listParams])}
        pageIds={rows.map((r) => r.drmsId)}
        total={total}
      >
        <BulkResultToast updated={count('updated')} hid={count('hid')} error={settingsError ?? hideError} />
        <section className="rounded-xl border border-line bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <FilterTabs
              basePath="/devices"
              current={filter}
              tabs={tabs}
              params={{ search, ...filterParams, ...listParams }}
            />
            <TonerLegend />
          </div>
          <DeviceFilterBar
            basePath="/devices"
            filters={filters}
            params={{ search, filter: filterParam, ...listParams }}
            options={options}
            className="px-5 pb-4"
          />

          <BulkSettingsBar search={search} filter={filter} filters={filters} page={page} listParams={listParams} />

          <ListControls {...controls} className="border-t border-line px-5 py-3.5" />
          <DeviceTable
            selectable
            from="devices"
            sorting={{ basePath: '/devices', keep, state, defaultRows }}
            back={listHref('/devices', keep, state, {}, { defaultRows })}
            rows={rows}
            now={now}
            emptyMessage={
              search ? `No devices match “${search}”.` : filtered ? 'No devices match these filters.' : EMPTY[filter]
            }
          />

          <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
        </section>
      </DeviceSelectionProvider>
    </>
  );
}
