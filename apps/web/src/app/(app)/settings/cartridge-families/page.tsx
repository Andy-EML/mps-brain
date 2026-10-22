import { REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import { listFamilies, listUnmappedModels } from '@mps/db/queries';
import { cn } from 'cn';
import { Breadcrumb } from '@/components/breadcrumb';
import { DeleteFamilyDialog, FamilyDialog } from '@/components/family-dialogs';
import { PageHeader } from '@/components/page-header';
import { SettingsTabs } from '@/components/settings-tabs';
import { ToneBadge } from '@/components/tone-badge';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { CONSUMABLE_LABELS, familyCarries } from '@/lib/family-fields';
import { familyErrorMessage } from '@/lib/family-form';
import { formatNumber, pluralise } from '@/lib/format';

export const metadata = { title: 'Cartridge families · MPS Dashboard' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Column heads for the yields: one letter, the full name for hover and screen readers. */
const YIELD_HEADS: Record<ReplenishColour, string> = { black: 'K', cyan: 'C', magenta: 'M', yellow: 'Y', waste: 'W' };

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-4 py-3 align-top text-[13px]';

/**
 * `/settings/cartridge-families`, for every signed-in user: which device models share cartridges
 * (a family), so a customer site's machines of one family share one shelf of spares. Lists each
 * family with its models, rated yields and how many shelves use it, and the monitored models that
 * are in no family yet.
 *
 * `?error=<code>&errorFor=<dialog>` comes back from the actions; the sentence is looked up here and
 * shown inside the dialog it belongs to (`add`, `family-<id>`, `delete-<id>`), or above the table
 * when that dialog is gone (the family was deleted meanwhile).
 */
export default async function CartridgeFamiliesPage({ searchParams }: PageProps<'/settings/cartridge-families'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const errorCode = first(params.error);
  const error = errorCode ? familyErrorMessage(errorCode) : null;
  const errorFor = error ? (first(params.errorFor) ?? '') : '';

  const db = getDb();
  const [families, unmapped] = await Promise.all([listFamilies(db), listUnmappedModels(db)]);

  const dialogs = new Set(['add', ...families.flatMap((f) => [`family-${f.id}`, `delete-${f.id}`])]);
  const pageError = error && !dialogs.has(errorFor) ? error : null;
  const errorIn = (dialog: string) => (errorFor === dialog ? error : null);
  const unmappedDevices = unmapped.reduce((sum, u) => sum + u.devices, 0);

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'Cartridge families' }]} />

      <PageHeader
        title="Cartridge families"
        subtitle="Models that take the same cartridges. A site's machines of one family share one shelf of spares."
      />

      <SettingsTabs current="/settings/cartridge-families" />

      {pageError ? (
        <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-5 py-3.5 text-sm text-destructive">
          {pageError}
        </p>
      ) : null}

      <section className="rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <div>
            <h2 className="text-[15px] font-medium">Families</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {families.length === 0
                ? 'None yet. Add one for each set of models that share cartridges.'
                : `${formatNumber(families.length)} ${pluralise(families.length, 'family', 'families')}. Rated yield is in pages; a blank is not known.`}
            </p>
          </div>
          <FamilyDialog unmapped={unmapped} error={errorIn('add')} />
        </div>

        {families.length > 0 ? (
          <div className="w-full overflow-x-auto border-t border-line">
            <table className="w-full min-w-[960px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className={HEAD}>Family</th>
                  <th scope="col" className={HEAD}>Type</th>
                  <th scope="col" className={HEAD}>Models</th>
                  {REPLENISH_COLOURS.map((c) => (
                    <th key={c} scope="col" className={cn(HEAD, 'text-right')}>
                      <abbr title={`${CONSUMABLE_LABELS[c]} rated yield`} className="no-underline">
                        {YIELD_HEADS[c]}
                      </abbr>
                    </th>
                  ))}
                  <th scope="col" className={cn(HEAD, 'text-right')}>Shelves</th>
                  <th scope="col" className={cn(HEAD, 'text-right')}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {families.map((f) => (
                  <tr key={f.id} id={`family-${f.id}`} className="scroll-mt-6 border-b border-line last:border-b-0 target:bg-brand-soft/40">
                    <td className={cn(CELL, 'max-w-[220px]')}>
                      <span className="font-medium">{f.name}</span>
                      {f.notes ? <p className="mt-0.5 text-[12px] text-muted-foreground">{f.notes}</p> : null}
                    </td>
                    <td className={CELL}>
                      <ToneBadge tone="muted" dot={false} className="text-[12px]">
                        {f.isColour ? 'Colour' : 'Mono'}
                      </ToneBadge>
                    </td>
                    <td className={cn(CELL, 'max-w-[360px]')}>
                      {f.models.length === 0 ? (
                        <span className="text-muted-foreground">No models</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1">
                          {f.models.map((m) => (
                            <li key={m} className="rounded-full bg-secondary px-2 py-0.5 text-[12px]">
                              {m}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    {REPLENISH_COLOURS.map((c) => (
                      <td key={c} className={cn(CELL, 'text-right tabular whitespace-nowrap')}>
                        {!familyCarries(f.isColour, c) ? (
                          <span className="text-muted-foreground/60" title="Not used by a mono family">
                            –
                          </span>
                        ) : f.ratedYield[c] !== undefined ? (
                          formatNumber(f.ratedYield[c])
                        ) : (
                          <span className="sr-only">Not known</span>
                        )}
                      </td>
                    ))}
                    <td className={cn(CELL, 'text-right tabular')}>{formatNumber(f.shelves)}</td>
                    <td className={cn(CELL, 'text-right')}>
                      <div className="flex items-center justify-end gap-2">
                        <FamilyDialog family={f} unmapped={unmapped} error={errorIn(`family-${f.id}`)} />
                        <DeleteFamilyDialog family={f} error={errorIn(`delete-${f.id}`)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="mt-5 rounded-xl border border-line bg-card px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-medium">Models with no family</h2>
          {unmapped.length > 0 ? (
            <ToneBadge tone="warn">
              {formatNumber(unmapped.length)} {pluralise(unmapped.length, 'model')}
            </ToneBadge>
          ) : null}
        </div>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {unmapped.length === 0
            ? 'Every monitored, linked device’s model is in a family.'
            : `${formatNumber(unmappedDevices)} monitored, linked ${pluralise(unmappedDevices, 'device')} cannot go on a shelf until their model is in a family. Add them through Add family or a family’s Edit.`}
        </p>
        {unmapped.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {unmapped.map((u) => (
              <li
                key={u.model}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px]"
              >
                <span className="font-medium">{u.model}</span>
                <span className="text-muted-foreground tabular">
                  {formatNumber(u.devices)} {pluralise(u.devices, 'device')}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
