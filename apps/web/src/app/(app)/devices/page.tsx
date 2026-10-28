import { redirect } from 'next/navigation';
import {
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
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { SearchInput } from '@/components/search-input';
import { TonerLegend } from '@/components/toner-bar';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceFilterParams, hasDeviceFilters, parseDeviceFilters } from '@/lib/device-filters';
import { formatNumber, pluralise } from '@/lib/format';
import { hideErrorMessage } from '@/lib/hide-device';
import { hrefWith } from '@/lib/href';
import { settingsErrorMessage } from '@/lib/settings-form';

export const metadata = { title: 'Devices · MPS Dashboard' };

const PAGE_SIZE = 50;

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
  const page = Math.max(1, Number.parseInt(first(params.page) ?? '1', 10) || 1);

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
    const hidden = await listHiddenDevices(db, { search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    if (hidden.rows.length === 0 && hidden.total > 0 && page > 1) {
      const lastPage = Math.ceil(hidden.total / PAGE_SIZE);
      redirect(hrefWith('/devices', { search, filter: HIDDEN, page: lastPage > 1 ? lastPage : undefined }));
    }
    const counted = `${formatNumber(hidden.total)} hidden ${pluralise(hidden.total, 'device')}`;
    return (
      <>
        <PageHeader
          title="Devices"
          subtitle={search ? `${counted} matching “${search}”` : counted}
          actions={
            <SearchInput action="/devices" defaultValue={search} hiddenParams={{ filter: HIDDEN }} className="w-[320px]" />
          }
        />
        <BulkResultToast unhid={count('unhid')} error={hideError} />
        <section className="rounded-xl border border-line bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <FilterTabs basePath="/devices" current={HIDDEN} tabs={tabs} params={{ search }} />
          </div>
          <p className="px-5 pb-4 text-[13px] text-muted-foreground">
            Hidden devices are left out of every other list and count, and get no toner proposals or alerts. Unhide
            one to bring it back; the next evaluation run may propose toner for it again.
          </p>
          <HiddenDeviceTable
            rows={hidden.rows}
            search={search}
            page={page}
            back={hrefWith('/devices', { search, filter: HIDDEN, page: page > 1 ? page : undefined })}
            emptyMessage={search ? `No hidden devices match “${search}”.` : 'No devices are hidden.'}
            className="border-t border-line"
          />
          <div className="border-t border-line px-5 py-3.5">
            <Pagination
              basePath="/devices"
              params={{ search, filter: HIDDEN }}
              page={page}
              pageSize={PAGE_SIZE}
              total={hidden.total}
            />
          </div>
        </section>
      </>
    );
  }

  const filter: Filter = tab;
  const [{ rows, total }, options] = await Promise.all([
    listDevices(db, {
      search,
      filter,
      ...filters,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    listDeviceFilterOptions(db),
  ]);

  // Carried on the tab links, the filter bar and the pager so changing one control keeps the others.
  const filterParam = filter === 'all' ? undefined : filter;
  const filterParams = deviceFilterParams(filters);
  const filtered = hasDeviceFilters(filters);

  // A page number past the end (a stale bookmark, or a search that shrank the result set) would
  // otherwise render the "nothing here" empty state over a list that does have rows.
  if (rows.length === 0 && total > 0 && page > 1) {
    const lastPage = Math.ceil(total / PAGE_SIZE);
    redirect(hrefWith('/devices', { search, filter: filterParam, ...filterParams, page: lastPage > 1 ? lastPage : undefined }));
  }
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
            hiddenParams={{ filter: filterParam, ...filterParams }}
            className="w-[320px]"
          />
        }
      />

      {/* Keyed on the view, so changing the search, tab, filters or page starts a fresh selection. */}
      <DeviceSelectionProvider
        key={JSON.stringify([search, filter, filterParams, page])}
        pageIds={rows.map((r) => r.drmsId)}
        total={total}
      >
        <BulkResultToast updated={count('updated')} hid={count('hid')} error={settingsError ?? hideError} />
        <section className="rounded-xl border border-line bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <FilterTabs basePath="/devices" current={filter} tabs={tabs} params={{ search, ...filterParams }} />
            <TonerLegend />
          </div>
          <DeviceFilterBar
            basePath="/devices"
            filters={filters}
            params={{ search, filter: filterParam }}
            options={options}
            className="px-5 pb-4"
          />

          <BulkSettingsBar search={search} filter={filter} filters={filters} page={page} />

          <DeviceTable
            selectable
            from="devices"
            back={hrefWith('/devices', { search, filter: filterParam, ...filterParams, page: page > 1 ? page : undefined })}
            rows={rows}
            now={now}
            emptyMessage={
              search ? `No devices match “${search}”.` : filtered ? 'No devices match these filters.' : EMPTY[filter]
            }
          />

          <div className="border-t border-line px-5 py-3.5">
            <Pagination
              basePath="/devices"
              params={{ search, filter: filterParam, ...filterParams }}
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
            />
          </div>
        </section>
      </DeviceSelectionProvider>
    </>
  );
}
