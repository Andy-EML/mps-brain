import Link from 'next/link';
import { Download, TriangleAlert, Upload } from 'lucide-react';
import { listFamilies, listShelves, listUnmappedModels } from '@mps/db/queries';
import { cn } from 'cn';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageHeader } from '@/components/page-header';
import { SearchInput } from '@/components/search-input';
import { shelfStatus } from '@/components/shelf';
import { NewShelfDialog } from '@/components/shelf-forms';
import { ShelfPills } from '@/components/shelf-pills';
import { ToneBadge } from '@/components/tone-badge';
import { buttonVariants } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { shelfErrorMessage } from '@/lib/shelf-form';

export const metadata = { title: 'Site stock · MPS Dashboard' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-4 py-3 align-middle text-[13px]';

/**
 * `/site-stock`, for every signed-in user: every customer-site shelf (one site + one cartridge
 * family), how many spares of each consumable it has used of how many it holds — a red ring once
 * the last one has gone in — and whether a top-up is on its way. Search, *+ New shelf*, and the
 * CSV export / import (Task 12's routes). Machines whose model is in no family cannot be on a
 * shelf, so they show as a warning pointing at the families page.
 *
 * `?error=<code>&errorFor=add` comes back from *+ New shelf* and shows inside that dialog.
 */
export default async function SiteStockPage({ searchParams }: PageProps<'/site-stock'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;
  const search = first(params.search)?.trim() ?? '';
  const errorCode = first(params.error);
  const addError = errorCode && first(params.errorFor) === 'add' ? shelfErrorMessage(errorCode) : null;

  const db = getDb();
  const [shelves, families, unmapped] = await Promise.all([
    listShelves(db, { search: search || undefined }),
    listFamilies(db),
    listUnmappedModels(db),
  ]);
  const unmappedDevices = unmapped.reduce((sum, u) => sum + u.devices, 0);
  const proposed = shelves.filter((s) => s.liveTopUp).length;

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'Site stock' }]} />

      <PageHeader
        title="Site stock"
        subtitle="Spares kept at customer sites. When a consumable's last spare goes in, the whole shelf is topped up."
        actions={
          <>
            {/* A route handler download, not a page: a plain link, so the router does not try to render it. */}
            <a href="/site-stock/export" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <Download aria-hidden />
              Export CSV
            </a>
            <Link href="/site-stock/import" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <Upload aria-hidden />
              Import CSV
            </Link>
            <NewShelfDialog
              families={families.map((f) => ({ id: f.id, name: f.name, isColour: f.isColour, models: f.models }))}
              error={addError}
            />
          </>
        }
      />

      {unmapped.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-warn/30 bg-warn/5 px-5 py-3 text-[13px]">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />
          <span>
            {formatNumber(unmappedDevices)} monitored {pluralise(unmappedDevices, 'machine')} ({formatNumber(unmapped.length)}{' '}
            {pluralise(unmapped.length, 'model')}) cannot go on a shelf until {unmapped.length === 1 ? 'its model is' : 'their models are'} in
            a cartridge family.
          </span>
          <Link href="/settings/cartridge-families" className="font-medium text-brand hover:underline">
            Cartridge families
          </Link>
        </div>
      ) : null}

      <section className="rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <p className="text-[13px] text-muted-foreground">
            {search
              ? `${formatNumber(shelves.length)} ${pluralise(shelves.length, 'shelf', 'shelves')} matching “${search}”`
              : shelves.length === 0
                ? 'No shelves yet.'
                : `${formatNumber(shelves.length)} ${pluralise(shelves.length, 'shelf', 'shelves')}${
                    proposed > 0 ? ` · ${formatNumber(proposed)} with a top-up proposed` : ''
                  }`}
          </p>
          <SearchInput action="/site-stock" defaultValue={search} placeholder="Search site, customer, postcode…" className="w-full sm:w-80" />
        </div>

        {shelves.length > 0 ? (
          <div className="w-full overflow-x-auto border-t border-line">
            <table className="w-full min-w-[880px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={HEAD}>Site</th>
                  <th scope="col" className={HEAD}>Cartridge family</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>Machines</th>
                  <th scope="col" className={HEAD}>Spares used / held</th>
                  <th scope="col" className={HEAD}>Status</th>
                </tr>
              </thead>
              <tbody>
                {shelves.map((s) => {
                  const status = shelfStatus(s.liveTopUp);
                  const sub = [s.headOfficeName, s.customerReference, s.postcode].filter(Boolean).join(' · ');
                  return (
                    <tr key={s.id} className="border-b border-line last:border-b-0 hover:bg-muted/40">
                      <td className={cn(CELL, 'max-w-[300px]')}>
                        <Link href={`/site-stock/${s.id}`} className="font-medium hover:text-brand hover:underline">
                          {s.siteName}
                        </Link>
                        {sub ? <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{sub}</p> : null}
                      </td>
                      <td className={CELL}>{s.familyName}</td>
                      <td className={cn(CELL, 'text-right tabular')}>{formatNumber(s.machines)}</td>
                      <td className={CELL}>
                        <ShelfPills shelf={s} />
                      </td>
                      <td className={CELL}>
                        <ToneBadge tone={status.tone} dot={false} className="px-2 py-0.5 text-[12px]">
                          {status.text}
                        </ToneBadge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="border-t border-line px-5 py-10 text-center text-sm text-muted-foreground">
            {search
              ? 'No shelf matches that search.'
              : 'Add a shelf for each site that keeps spares on hand, or import them from a CSV.'}
          </p>
        )}
      </section>

      {shelves.length > 0 ? (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Red ring: that consumable&apos;s last spare has gone in, so the whole shelf gets topped up.
        </p>
      ) : null}
    </>
  );
}
