import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Info } from 'lucide-react';
import { UNDER_YIELD_PCT_THRESHOLD, YIELD_SORT_KEYS, listUnderYielding } from '@mps/db/queries';
import { cn } from 'cn';
import { Breadcrumb } from '@/components/breadcrumb';
import { colourLabel } from '@/components/colour-chip';
import { ListControls } from '@/components/list-controls';
import { PageHeader } from '@/components/page-header';
import { Swatch } from '@/components/review-detail-panel';
import { SortHeader } from '@/components/sort-header';
import { CARTRIDGE_FAMILIES_HREF, sharePercent } from '@/components/toner-yield';
import { ToneBadge } from '@/components/tone-badge';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceHref } from '@/lib/device-origin';
import { formatDate, formatNumber, pluralise } from '@/lib/format';
import { TONER_YIELD_DEFAULT_ROWS } from '@/lib/list-keep';
import { lastPageOf, listHref, parseListState, rowsCookieName, sortSpec } from '@/lib/list-state';

export const metadata = { title: 'Toner yield · MPS Dashboard' };

const LIST_KEY = 'toner-yield';
const DEFAULT_ROWS = TONER_YIELD_DEFAULT_ROWS;
const BASE = '/orders/yield';

const HEAD = 'px-5 py-2.5 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-5 py-3 align-top text-[13px]';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `/orders/yield`: every linked device and colour whose cartridges average under 70% of the rated
 * yield (over its last few measured cartridges), worst first. Needs rated yields on the cartridge
 * families, so with none entered the list is empty and says why.
 */
export default async function TonerYieldPage({ searchParams }: PageProps<'/orders/yield'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;
  const cookieStore = await cookies();
  const state = parseListState((name) => first(params[name]), {
    listKey: LIST_KEY,
    defaultRows: DEFAULT_ROWS,
    sortKeys: YIELD_SORT_KEYS,
    cookieRows: cookieStore.get(rowsCookieName(LIST_KEY))?.value,
  });
  const rows = await listUnderYielding(getDb(), new Date(), sortSpec(state));
  const devices = new Set(rows.map((r) => r.drmsEquipmentId)).size;

  const keep = {};
  const lastPage = lastPageOf(rows.length, state.rows);
  if (state.page > lastPage) redirect(listHref(BASE, keep, state, { page: lastPage }, { defaultRows: DEFAULT_ROWS }));
  const shown = rows.slice((state.page - 1) * state.rows, state.page * state.rows);
  const sorting = { basePath: BASE, keep, state, defaultRows: DEFAULT_ROWS };
  const controls = { ...sorting, total: rows.length, listKey: LIST_KEY, noun: 'cartridge colour' };
  // This list's own URL, so the device page's Back link returns to the same page and sort.
  const back = listHref(BASE, keep, state, {}, { defaultRows: DEFAULT_ROWS });

  return (
    <>
      <Breadcrumb
        className="mb-3"
        items={[{ label: 'Fleet overview', href: '/' }, { label: 'Toner orders', href: '/orders' }, { label: 'Toner yield' }]}
      />

      <PageHeader
        title="Toner yield"
        subtitle={
          rows.length > 0
            ? `${formatNumber(rows.length)} ${pluralise(rows.length, 'cartridge colour')} on ${formatNumber(devices)} ${pluralise(devices, 'device')} under ${sharePercent(UNDER_YIELD_PCT_THRESHOLD)} of rated yield`
            : `Devices whose cartridges average under ${sharePercent(UNDER_YIELD_PCT_THRESHOLD)} of the rated yield`
        }
      />

      <div role="note" className="mb-4 flex items-start gap-3 rounded-xl border border-line bg-muted/30 px-5 py-4">
        <Info aria-hidden className="mt-0.5 size-[18px] shrink-0 text-muted-foreground" />
        <p className="text-[14px] text-muted-foreground">
          Pages per cartridge are the meter movement between one Vantage toner order and the next, averaged over the
          last few measured cartridges (two at least). Order-to-order is approximate — a cartridge goes in some days
          after it is delivered — so treat a single device as a prompt to look, not proof.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-card">
        {rows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-sm text-muted-foreground">No device is flagged as under-yielding.</p>
            <p className="mx-auto mt-2 max-w-xl text-[13px] text-muted-foreground">
              A device can only be flagged once its cartridge family has rated yields and it has at least two measured
              cartridges. Rated yields are entered per family on{' '}
              <Link href={CARTRIDGE_FAMILIES_HREF} className="font-medium text-brand hover:underline">
                Cartridge families
              </Link>
              ; meter history fills in nightly. Each device page shows the pages its cartridges have done so far.
            </p>
          </div>
        ) : (
          <>
          <ListControls {...controls} className="border-b border-line px-5 py-3.5" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <SortHeader label="Customer" sortKey="customer" className={HEAD} {...sorting} />
                  <SortHeader label="Serial" sortKey="serial" className={HEAD} {...sorting} />
                  <SortHeader label="Model" sortKey="model" className={HEAD} {...sorting} />
                  <SortHeader label="Family" sortKey="family" className={HEAD} {...sorting} />
                  <SortHeader label="Colour" sortKey="colour" className={HEAD} {...sorting} />
                  <SortHeader label="Avg achieved" sortKey="achieved" className={HEAD} {...sorting} />
                  <SortHeader label="Cartridges" sortKey="cartridges" className={HEAD} {...sorting} />
                  <SortHeader label="Last order" sortKey="lastOrder" className={HEAD} {...sorting} />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const href = deviceHref(r.drmsEquipmentId, 'toner-yield', back);
                  return (
                    <tr key={`${r.drmsEquipmentId}-${r.colour}`} className="border-t border-line/70">
                      <td className={CELL}>
                        <Link href={href} className="font-medium text-brand hover:underline">
                          {r.customerName ?? 'Unknown customer'}
                        </Link>
                      </td>
                      <td className={cn(CELL, 'font-mono text-[12px]')}>
                        <Link href={href} className="hover:underline">
                          {r.serial ?? '—'}
                        </Link>
                      </td>
                      <td className={CELL}>{r.model ?? '—'}</td>
                      <td className={cn(CELL, 'text-muted-foreground')}>{r.family ?? '—'}</td>
                      <td className={cn(CELL, 'whitespace-nowrap')}>
                        <span className="flex items-center gap-2">
                          <Swatch colour={r.colour} />
                          {colourLabel(r.colour)}
                        </span>
                      </td>
                      <td className={cn(CELL, 'tabular-nums')}>
                        <span className="font-medium text-critical">{sharePercent(r.avgPctOfRated)}</span>
                        <span className="block text-[12px] text-muted-foreground">
                          {formatNumber(Math.round(r.avgAchieved))} of {formatNumber(r.ratedYield)}
                        </span>
                      </td>
                      <td className={cn(CELL, 'tabular-nums')}>{formatNumber(r.cartridgesCounted)}</td>
                      <td className={cn(CELL, 'whitespace-nowrap tabular-nums')}>
                        {formatDate(r.lastOrderDate)}
                        {r.stale ? (
                          <ToneBadge tone="muted" dot={false} className="ml-2 px-2 py-0 text-[11px]">
                            Stale meters
                          </ToneBadge>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListControls {...controls} position="bottom" className="border-t border-line px-5 py-3.5" />
          </>
        )}
      </section>
    </>
  );
}
