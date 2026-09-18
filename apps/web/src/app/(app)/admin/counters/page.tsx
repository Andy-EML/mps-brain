import { Wand2 } from 'lucide-react';
import { listCounterNames } from '@mps/db/queries';
import { AdminNav } from '@/components/admin-nav';
import { CounterNameTable } from '@/components/counter-name-table';
import { FilterTabs, type FilterTab } from '@/components/filter-tabs';
import { PageHeader } from '@/components/page-header';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { applyDefaultCountersAction } from '@/app/(app)/admin/actions';

export const metadata = { title: 'Counter names · Admin · MPS Dashboard' };

const FILTERS = ['all', 'meter', 'supply', 'other', 'unset'] as const;
type CounterFilter = (typeof FILTERS)[number];

const EMPTY: Record<CounterFilter, string> = {
  all: 'No counter names yet — they are catalogued by the DRMS counter snapshot job.',
  meter: 'No counter is marked as a meter. “Set defaults” marks the three billing meters.',
  supply: 'No counter is marked as a supply. “Set defaults” marks the four toner levels.',
  other: 'No counter is parked as “other”.',
  unset: 'Every counter name has a category.',
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminCountersPage({ searchParams }: PageProps<'/admin/counters'>) {
  // First statement — a server action and an admin page are both public endpoints until this runs.
  await requireAdmin();
  const params = await searchParams;

  const requested = first(params.category);
  const filter: CounterFilter = FILTERS.includes(requested as CounterFilter) ? (requested as CounterFilter) : 'all';

  const all = await listCounterNames(getDb());
  const counts = {
    all: all.length,
    meter: all.filter((row) => row.category === 'meter').length,
    supply: all.filter((row) => row.category === 'supply').length,
    other: all.filter((row) => row.category === 'other').length,
    unset: all.filter((row) => row.category == null).length,
  } satisfies Record<CounterFilter, number>;

  const rows = filter === 'all' ? all : all.filter((row) => (filter === 'unset' ? row.category == null : row.category === filter));

  const tabs: FilterTab[] = FILTERS.map((value) => ({
    value,
    label: (
      <>
        <span className="capitalize">{value}</span>
        <span className="ml-1.5 tabular-nums opacity-60">{formatNumber(counts[value])}</span>
      </>
    ),
  }));

  const categorised = counts.meter + counts.supply + counts.other;

  return (
    <>
      <PageHeader
        title="Counter names"
        subtitle={`${formatNumber(all.length)} ${pluralise(all.length, 'name')} reported by the fleet · ${formatNumber(
          categorised,
        )} categorised`}
        actions={
          <form action={applyDefaultCountersAction}>
            <button
              type="submit"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] whitespace-nowrap transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Wand2 aria-hidden className="size-3.5" />
              Set defaults
            </button>
          </form>
        }
      />

      <AdminNav current="counters" />

      <p className="mt-5 mb-5 max-w-3xl rounded-xl border border-line bg-card px-5 py-4 text-sm text-muted-foreground">
        DRMS reports whatever counters a model happens to have, so most of these names are paper sizes
        and internal tallies. The category is what the rest of the app reads: <strong>meter</strong> for
        the three counters billing uses, <strong>supply</strong> for the four toner levels.{' '}
        <em>Set defaults</em> applies exactly those seven — <code>Black:Total</code>,{' '}
        <code>Full Color:Total</code>, <code>Scanner/FAX:Scan</code> and the four{' '}
        <code>*TonerLevel</code> names — and leaves everything else alone.
      </p>

      <div className="mb-4">
        <FilterTabs
          basePath="/admin/counters"
          param="category"
          current={filter}
          tabs={tabs}
          defaultValue="all"
          ariaLabel="Filter counter names by category"
        />
      </div>

      <section className="rounded-xl border border-line bg-card">
        <CounterNameTable rows={rows} emptyMessage={EMPTY[filter]} />
      </section>
    </>
  );
}
