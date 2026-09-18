import { redirect } from 'next/navigation';
import { listDevices, type DeviceListOptions } from '@mps/db/queries';
import { DeviceTable } from '@/components/device-table';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { SearchInput } from '@/components/search-input';
import { TonerLegend } from '@/components/toner-bar';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { hrefWith } from '@/lib/href';

export const metadata = { title: 'Devices · MPS Dashboard' };

const PAGE_SIZE = 50;

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'needs-toner', label: 'Needs toner' },
  { value: 'offline', label: 'Offline' },
  { value: 'unlinked', label: 'Not linked' },
] as const satisfies readonly (FilterTab & { value: NonNullable<DeviceListOptions['filter']> })[];

type Filter = (typeof FILTERS)[number]['value'];

const EMPTY: Record<Filter, string> = {
  all: 'No devices have been synced yet.',
  'needs-toner': 'No device is under 20% on any cartridge.',
  offline: 'Every device that has reported before reported in the last 24 hours.',
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
  const page = Math.max(1, Number.parseInt(first(params.page) ?? '1', 10) || 1);

  const db = getDb();
  const now = new Date();
  const { rows, total } = await listDevices(db, {
    search,
    filter,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  // Carried on the tab links and the pager so switching one control keeps the others.
  const filterParam = filter === 'all' ? undefined : filter;

  // A page number past the end (a stale bookmark, or a search that shrank the result set) would
  // otherwise render the "nothing here" empty state over a list that does have rows.
  if (rows.length === 0 && total > 0 && page > 1) {
    const lastPage = Math.ceil(total / PAGE_SIZE);
    redirect(hrefWith('/devices', { search, filter: filterParam, page: lastPage > 1 ? lastPage : undefined }));
  }
  const counted = `${formatNumber(total)} ${pluralise(total, 'device')}`;
  const subtitle = search ? `${counted} matching “${search}”` : counted;

  return (
    <>
      <PageHeader
        title="Devices"
        subtitle={subtitle}
        actions={
          <SearchInput
            action="/devices"
            defaultValue={search}
            hiddenParams={{ filter: filterParam }}
            className="w-[320px]"
          />
        }
      />

      <section className="rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <FilterTabs basePath="/devices" current={filter} tabs={FILTERS} params={{ search }} />
          <TonerLegend />
        </div>

        <DeviceTable
          rows={rows}
          now={now}
          emptyMessage={search ? `No devices match “${search}”.` : EMPTY[filter]}
        />

        <div className="border-t border-line px-5 py-3.5">
          <Pagination
            basePath="/devices"
            params={{ search, filter: filterParam }}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
          />
        </div>
      </section>
    </>
  );
}
