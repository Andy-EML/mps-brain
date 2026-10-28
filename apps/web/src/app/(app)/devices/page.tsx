import { redirect } from 'next/navigation';
import { listDeviceFilterOptions, listDevices, type DeviceListOptions } from '@mps/db/queries';
import { DeviceFilterBar } from '@/components/device-filter-bar';
import { BulkResultToast, BulkSettingsBar, DeviceSelectionProvider } from '@/components/device-selection';
import { DeviceTable } from '@/components/device-table';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { SearchInput } from '@/components/search-input';
import { TonerLegend } from '@/components/toner-bar';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceFilterParams, hasDeviceFilters, parseDeviceFilters } from '@/lib/device-filters';
import { formatNumber, pluralise } from '@/lib/format';
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
  const filter: Filter = FILTERS.some((f) => f.value === requested) ? (requested as Filter) : 'all';
  const filters = parseDeviceFilters((name) => first(params[name]));
  const page = Math.max(1, Number.parseInt(first(params.page) ?? '1', 10) || 1);

  const db = getDb();
  const now = new Date();
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
  // What `bulkUpdateSettingsAction` redirected back with; `BulkResultToast` reports and drops it.
  const updatedParam = Number.parseInt(first(params.updated) ?? '', 10);
  const updated = Number.isInteger(updatedParam) && updatedParam >= 0 ? updatedParam : undefined;
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
        <BulkResultToast updated={updated} error={settingsError} />
        <section className="rounded-xl border border-line bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <FilterTabs basePath="/devices" current={filter} tabs={FILTERS} params={{ search, ...filterParams }} />
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
