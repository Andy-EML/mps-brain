import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';
import { getShelf } from '@mps/db/queries';
import { cn } from 'cn';
import { resetAutoReplenishAction } from '@/app/(app)/site-stock/actions';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageHeader } from '@/components/page-header';
import { coveredColours, coveredColoursText, eventAlarmText, eventOutcome, shelfStatus } from '@/components/shelf';
import { DeleteShelfDialog, HoldingsForm } from '@/components/shelf-forms';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceHref } from '@/lib/device-origin';
import { formatDateTime, formatNumber, pluralise } from '@/lib/format';
import { shelfErrorMessage } from '@/lib/shelf-form';

export const metadata = { title: 'Site stock shelf · MPS Dashboard' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The forms on this page that `?errorFor=` can name. */
const FORMS = ['holdings', 'correct', 'delete', 'reset'] as const;

/**
 * `/site-stock/<id>`: one shelf. Its holdings (a 0–20 stepper each, Save) and used counts (with an
 * audited *Correct counts*), the machines on it — derived: every monitored device at the site
 * whose model is in the family — and the log of every Empty considered, counted or not and why.
 * A banner offers to switch machines with their own auto-replenish Off back to inherited, so
 * consumables the shelf does not hold go back to normal replenishment. *Delete shelf* at the foot.
 *
 * `?error=<code>&errorFor=<form>` comes back from the actions and shows beside that form;
 * `?reset=<n>` reports how many machines *Switch back to inherited* changed.
 */
export default async function ShelfPage({ params, searchParams }: PageProps<'/site-stock/[id]'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page.
  await requireUser();
  const { id } = await params;
  const query = await searchParams;
  if (!/^\d{1,9}$/.test(id)) notFound();

  const shelf = await getShelf(getDb(), Number(id));
  if (!shelf) notFound();

  const errorCode = first(query.error);
  const errorForRaw = first(query.errorFor);
  const errorFor = FORMS.find((f) => f === errorForRaw);
  const errorIn = (form: (typeof FORMS)[number]) => (errorCode && errorFor === form ? shelfErrorMessage(errorCode) : null);
  const resetRaw = first(query.reset);
  const reset = resetRaw !== undefined && /^\d{1,6}$/.test(resetRaw) ? Number(resetRaw) : null;

  const status = shelfStatus(shelf.liveTopUp);
  const covered = coveredColours(shelf.isColour, shelf.holding);
  const title = `${shelf.siteName} · ${shelf.familyName}`;
  const subtitle = [shelf.headOfficeName, shelf.customerReference, shelf.postcode].filter(Boolean).join(' · ');
  const counted = shelf.events.filter((e) => e.counted).length;

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Site stock', href: '/site-stock' }, { label: title }]} />

      <PageHeader
        title={title}
        badge={<ToneBadge tone={status.tone}>{status.text}</ToneBadge>}
        subtitle={
[shelf.isColour ? 'Colour family' : 'Mono family', subtitle].filter(Boolean).join(' · ')
        }
        actions={
          shelf.liveTopUp ? (
            <Link href="/orders" className="text-sm font-medium text-brand hover:underline">
              See the top-up in Toner orders
            </Link>
          ) : null
        }
      />

      {reset !== null ? (
        <p role="status" className="mb-4 rounded-xl bg-ok/10 px-5 py-3 text-[13px] text-ok">
          {reset > 0
            ? `${formatNumber(reset)} ${pluralise(reset, 'machine')} switched back to inherited auto-replenish.`
            : 'No machine on this shelf had its own auto-replenish setting. It is off for this customer or by default: change it in Settings → Replenishment.'}
        </p>
      ) : null}

      {shelf.autoOffDevices > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn/5 px-5 py-3.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
            <div className="min-w-0 text-[13px]">
              <p className="font-medium">
                {formatNumber(shelf.autoOffDevices)} {pluralise(shelf.autoOffDevices, 'machine')} on this shelf{' '}
                {shelf.autoOffDevices === 1 ? 'has' : 'have'} auto-replenish off
              </p>
              <p className="mt-0.5 text-muted-foreground">
                Shelf top-ups ignore that setting, but consumables the shelf does not hold get no normal proposals while it is
                off.
              </p>
            </div>
          </div>
          <form action={resetAutoReplenishAction} className="shrink-0">
            <input type="hidden" name="shelfId" value={shelf.id} />
            <Button type="submit" variant="outline" size="sm">
              Switch back to inherited
            </Button>
          </form>
          {errorIn('reset') ? (
            <p role="alert" className="w-full rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorIn('reset')}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="grid gap-4">
          <HoldingsForm
            // Remounts from the saved values after a save; a refused save keeps what was entered.
            key={JSON.stringify([shelf.holding, shelf.used])}
            shelfId={shelf.id}
            isColour={shelf.isColour}
            holding={shelf.holding}
            used={shelf.used}
            error={errorIn('holdings')}
            correctError={errorIn('correct')}
          />

          <p className="px-1 text-[12px] text-muted-foreground">
            {covered.length > 0
              ? `Normal proposals are off for ${coveredColoursText(covered)} on these machines; the shelf's top-up covers them.`
              : 'Nothing held yet, so these machines are still on normal replenishment for everything.'}
          </p>
        </div>

        <div className="grid gap-4">
          <section className="rounded-xl border border-line bg-card px-5 py-4">
            <h2 className="text-[15px] font-medium">
              Machines on this shelf
              <span className="ml-3 text-[13px] font-normal text-muted-foreground">{formatNumber(shelf.machines)}</span>
            </h2>
            {shelf.devices.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted-foreground">
                No monitored machine at this site has a model in this family.
              </p>
            ) : (
              <ul className="mt-2">
                {shelf.devices.map((d) => (
                  <li key={d.drmsId} className="border-b border-dashed border-line py-1.5 text-[13px] last:border-b-0">
                    <Link href={deviceHref(d.drmsId, 'site-stock')} className="font-medium hover:text-brand hover:underline">
                      {d.displayName}
                    </Link>
                    <span className="text-muted-foreground">
                      {[d.model, d.serial].filter(Boolean).map((part) => ` · ${part}`)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[12px] text-muted-foreground">Added automatically: same site and same cartridge family.</p>
          </section>

          <section className="rounded-xl border border-line bg-card px-5 py-4">
            <h2 className="text-[15px] font-medium">
              Empties
              <span className="ml-3 text-[13px] font-normal text-muted-foreground">
                {shelf.events.length === 0 ? 'none yet' : `${formatNumber(counted)} counted of the last ${formatNumber(shelf.events.length)}`}
              </span>
            </h2>
            {shelf.events.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted-foreground">
                Every toner Empty and waste-bottle Full from these machines shows here, counted or not, from when the shelf was
                created.
              </p>
            ) : (
              <ul className="mt-2">
                {shelf.events.map((e, i) => (
                  <li
                    key={`${e.at.toISOString()}-${e.drmsId}-${e.colour}-${i}`}
                    className={cn('border-b border-dashed border-line py-1.5 text-[12px] last:border-b-0', !e.counted && 'text-muted-foreground')}
                  >
                    <span className="tabular">{formatDateTime(e.at)}</span>
                    {' · '}
                    {e.drmsId ? (
                      <Link href={deviceHref(e.drmsId, 'site-stock')} className="hover:text-brand hover:underline">
                        {e.displayName ?? e.drmsId}
                      </Link>
                    ) : (
                      'Unknown machine'
                    )}
                    {' · '}
                    {eventAlarmText(e.colour)}
                    {' — '}
                    <span className={e.counted ? 'font-medium' : undefined}>{eventOutcome(e)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <section className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-card px-5 py-4">
        <div>
          <h2 className="text-[15px] font-medium">Delete this shelf</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Its machines go back to normal replenishment. Recorded in the audit log.
          </p>
        </div>
        <DeleteShelfDialog shelfId={shelf.id} name={title} liveTopUp={shelf.liveTopUp} error={errorIn('delete')} />
      </section>
    </>
  );
}
