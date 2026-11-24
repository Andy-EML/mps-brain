import {
  DEFAULT_PLANNER_SETTINGS,
  DEFAULT_PM_SETTINGS,
  getPlannerSettings,
  getPmSettings,
  hasSavedPmSettings,
  listWorkCategories,
  type PmSettings,
} from '@mps/db/queries';
import { cn } from 'cn';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageHeader } from '@/components/page-header';
import { PlannerSettingsCard } from '@/components/planner-settings-card';
import { SettingsTabs } from '@/components/settings-tabs';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, pluralise } from '@/lib/format';
import { plannerSettingsToValues } from '@/lib/planner-settings-form';
import { suggestPmCategoryIds } from '@/lib/pm-settings-form';
import { settingsErrorMessage } from '@/lib/settings-form';
import { savePmSettingsAction } from './actions';

export const metadata = { title: 'PM settings · MPS Dashboard' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type FieldName = Exclude<keyof PmSettings, 'pmCategoryIds' | 'pmPartKeywords'>;

interface NumberField {
  name: FieldName;
  label: string;
  unit: string;
  help: string;
}

interface Group {
  title: string;
  fields: NumberField[];
  /** Extra explanation under the fields. */
  note?: (s: PmSettings) => string;
}

const GROUPS: Group[] = [
  {
    title: 'When PM is due',
    fields: [
      { name: 'intervalPages', label: 'PM interval', unit: 'pages', help: 'Pages between PM visits. A cartridge family can set its own.' },
      { name: 'timeCapMonths', label: 'Time cap', unit: 'months', help: 'Due after this long even if the pages are not reached.' },
      { name: 'dueSoonPct', label: 'Due soon at', unit: '% of the interval', help: 'A whole percentage from 50 to 100.' },
      { name: 'dueSoonDays', label: 'Due soon within', unit: 'days', help: 'Or when the estimated due date is this close.' },
    ],
  },
  {
    title: 'What resets the clock',
    fields: [
      { name: 'qualifyingMinutes', label: 'Qualifying visit', unit: 'minutes or longer', help: 'A field visit this long counts as a service.' },
    ],
    note: (s) =>
      `Only Field-type visits count toward the ${formatNumber(s.qualifyingMinutes)}-minute rule and toward frequent calls. ` +
      'A visit in a ticked PM category (below) resets the clock whatever its type or length.',
  },
  {
    title: 'Frequent calls',
    fields: [
      { name: 'frequentCount', label: 'Field visits', unit: 'or more', help: 'This many field visits…' },
      { name: 'frequentWindowDays', label: 'Within', unit: 'days', help: '…within this many days makes a machine a frequent caller.' },
      { name: 'holdDays', label: 'Hold PM for', unit: 'days after the last visit', help: 'A frequent caller is held off the due list this long.' },
    ],
  },
];

/** A stored value as the form shows it: the due-soon fraction as a whole percentage. */
function shown(s: PmSettings, name: FieldName): string {
  return name === 'dueSoonPct' ? String(Math.round(s.dueSoonPct * 100)) : String(s[name]);
}

function defaultText(name: FieldName): string {
  return name === 'dueSoonPct'
    ? `${Math.round(DEFAULT_PM_SETTINGS.dueSoonPct * 100)}%`
    : formatNumber(DEFAULT_PM_SETTINGS[name]);
}

const CARD = 'rounded-xl border border-line bg-card';

/**
 * `/settings/pm`, for every signed-in user: the global rules behind the PM due list — the page
 * interval and time cap, when a machine counts as due soon, which visits reset the clock, and when
 * frequent calls hold PM off. Per-family intervals are on the cartridge family dialog.
 *
 * While no PM category has been saved, categories whose name looks like maintenance are pre-ticked
 * and marked "suggested — save to confirm"; they are used until the form is saved.
 *
 * `?settingsError=<code>` comes back from the action; the sentence is looked up here, so a crafted
 * link cannot put arbitrary text on the page. `?saved=1` confirms a save.
 */
export default async function PmSettingsPage({ searchParams }: PageProps<'/settings/pm'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;

  const errorCode = first(params.settingsError);
  const error = errorCode ? settingsErrorMessage(errorCode) : null;
  const saved = !error && first(params.saved) === '1';

  const db = getDb();
  const [settings, categories, hasSaved, planner] = await Promise.all([
    getPmSettings(db),
    listWorkCategories(db),
    hasSavedPmSettings(db),
    getPlannerSettings(db),
  ]);

  // A saved id with no visits any more stays listed (and ticked), so saving does not quietly drop it.
  const seen = new Set(categories.map((c) => c.id));
  const allCategories = [
    ...categories,
    ...settings.pmCategoryIds
      .filter((id) => !seen.has(id))
      .map((id) => ({ id, name: `Category ${id}`, type: null, visits: 0 })),
  ];
  // Nothing saved yet: getPmSettings already applies the suggestion, shown here as "suggested — save to confirm".
  const suggesting = !hasSaved;
  const ticked = new Set(suggesting ? suggestPmCategoryIds(categories) : settings.pmCategoryIds);

  return (
    <>
      <Breadcrumb className="mb-3" items={[{ label: 'Fleet overview', href: '/' }, { label: 'PM settings' }]} />

      <PageHeader
        title="Preventive maintenance"
        subtitle="How the PM due list decides when a machine needs a service. Booking stays in Vantage."
      />

      <SettingsTabs current="/settings/pm" />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl bg-destructive/10 px-5 py-3.5 text-sm text-destructive">
          {error}
        </p>
      ) : saved ? (
        <p role="status" className="mb-4 rounded-xl bg-brand-soft px-5 py-3.5 text-sm">
          PM settings saved.
        </p>
      ) : null}

      {/* Keyed on the stored values, so a save re-renders the inputs from them. */}
      <form key={JSON.stringify(settings)} action={savePmSettingsAction} className="flex flex-col gap-5">
        {GROUPS.map((group) => (
          <section key={group.title} className={cn(CARD, 'px-5 py-4')}>
            <h2 className="text-[15px] font-medium">{group.title}</h2>
            <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {group.fields.map((f) => (
                <div key={f.name} className="flex flex-col gap-1.5">
                  <label htmlFor={`pm-${f.name}`} className="text-sm font-medium">
                    {f.label}
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`pm-${f.name}`}
                      name={f.name}
                      inputMode="numeric"
                      required
                      defaultValue={shown(settings, f.name)}
                      className="h-8 w-32 tabular"
                    />
                    <span className="text-[13px] text-muted-foreground">{f.unit}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {f.help} Default {defaultText(f.name)}.
                  </p>
                </div>
              ))}
            </div>
            {group.note ? <p className="mt-3 text-[13px] text-muted-foreground">{group.note(settings)}</p> : null}
          </section>
        ))}

        <section className={CARD} aria-labelledby="pm-parts">
          <h2 id="pm-parts" className="px-5 pt-4 pb-1 text-[15px] font-medium">
            Parts that reset the PM clock
          </h2>
          <p className="px-5 pb-3 text-[13px] text-muted-foreground">
            A visit where a used part&apos;s description contains one of these words resets the clock, whatever its type or length.
            Comma-separated, not case-sensitive. Leave empty to turn this off.
          </p>
          <div className="border-t border-line px-5 py-3">
            <input
              type="text"
              name="pmPartKeywords"
              defaultValue={settings.pmPartKeywords.join(', ')}
              aria-labelledby="pm-parts"
              className="w-full rounded-md border border-line bg-background px-3 py-1.5 text-[13px]"
            />
          </div>
        </section>

        <section className={CARD} aria-labelledby="pm-categories">
          <div className="flex flex-wrap items-center gap-3 px-5 pt-4 pb-1">
            <h2 id="pm-categories" className="text-[15px] font-medium">
              PM categories
            </h2>
            {suggesting && ticked.size > 0 ? <ToneBadge tone="warn">Suggested — save to confirm</ToneBadge> : null}
          </div>
          <p className="px-5 pb-3 text-[13px] text-muted-foreground">
            Vantage work categories that are a PM visit. A visit in one of these always resets the clock.
            {suggesting
              ? ' None saved yet: the ticks below are suggestions from the category names and are used until you save your own.'
              : null}
          </p>
          {allCategories.length === 0 ? (
            <p className="border-t border-line px-5 py-4 text-[13px] text-muted-foreground">
              No work categories seen yet. They appear once Vantage visits have synced.
            </p>
          ) : (
            <ul className="border-t border-line">
              {allCategories.map((c) => (
                <li key={c.id} className="border-b border-line last:border-b-0">
                  <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-[13px] hover:bg-muted/50">
                    <input
                      type="checkbox"
                      name="pmCategory"
                      value={c.id}
                      defaultChecked={ticked.has(c.id)}
                      className="size-4"
                    />
                    <span className="font-medium">{c.name}</span>
                    {suggesting && ticked.has(c.id) ? (
                      <span className="text-[12px] text-warn">suggested</span>
                    ) : null}
                    <span className="ml-auto flex items-center gap-3">
                      <ToneBadge tone="muted" dot={false} className="text-[12px]">
                        <span className="sr-only">Type: </span>
                        {c.type ?? 'No type'}
                      </ToneBadge>
                      <span className="w-20 text-right text-muted-foreground tabular">
                        {formatNumber(c.visits)} {pluralise(c.visits, 'visit')}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex justify-end">
          <Button type="submit" className="bg-brand hover:bg-brand/90">
            Save PM settings
          </Button>
        </div>
      </form>

      {/* A form of its own (client, useActionState), so saving one card never re-saves the other. */}
      <PlannerSettingsCard
        initial={plannerSettingsToValues(planner)}
        defaults={plannerSettingsToValues(DEFAULT_PLANNER_SETTINGS)}
        className="mt-5"
      />
    </>
  );
}
