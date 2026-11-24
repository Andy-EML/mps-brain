'use client';

import { useActionState } from 'react';
import { cn } from 'cn';
import { savePlannerSettingsAction } from '@/app/(app)/settings/pm/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PlannerFormState, PlannerFormValues } from '@/lib/planner-settings-state';

type NumberName = 'nearMiles' | 'doneRetentionDays' | 'askedStaleDays';

const NUMBERS: { name: NumberName; label: string; unit: string; help: string }[] = [
  { name: 'nearMiles', label: 'Near a booked call', unit: 'miles', help: 'Upcoming jobs suggest PMs in the same postcode district or within this distance. 1 to 100.' },
  { name: 'doneRetentionDays', label: 'Keep Done cards', unit: 'days', help: 'How long a card stays in Done before it drops off the board. 1 to 90.' },
  { name: 'askedStaleDays', label: 'Asked-engineer warning after', unit: 'days', help: 'A card in Asked engineer longer than this shows “asked N days ago”. 1 to 60.' },
];

/** The region dealer fields; a blank name means we service that region ourselves. */
const DEALERS: { name: 'irelandDealer' | 'scotlandDealer'; label: string; help: string }[] = [
  { name: 'irelandDealer', label: 'Ireland dealer', help: 'Republic of Ireland (Eircode or Irish county) and Northern Ireland (BT postcodes).' },
  { name: 'scotlandDealer', label: 'Scotland dealer', help: 'Scottish postcode areas (AB, DD, DG, EH, FK, G, HS, IV, KA, KW, KY, ML, PA, PH, TD, ZE).' },
];

const IDLE: PlannerFormState = { status: 'idle' };

export interface PlannerSettingsCardProps {
  /** The stored settings as the fields show them. */
  initial: PlannerFormValues;
  /** The defaults, as text for the help lines. */
  defaults: PlannerFormValues;
  className?: string;
}

/**
 * The *Planner and other dealers* card on `/settings/pm`: its own form (so saving it never
 * re-saves the PM settings form), saved through `useActionState`. A refused save keeps every field
 * as typed — the multi-line patches especially — and shows the specific reason; a save shows
 * "Planner settings saved." and the stored (cleaned) values.
 */
export function PlannerSettingsCard({ initial, defaults, className }: PlannerSettingsCardProps) {
  const [state, formAction, pending] = useActionState(savePlannerSettingsAction, IDLE);
  const values = state.status === 'idle' ? initial : state.values;

  return (
    <form
      // Remount from the returned values after each save, so React's form reset cannot clear them.
      key={JSON.stringify([state.status, values])}
      action={formAction}
      id="planner"
      aria-labelledby="planner-title"
      className={cn('scroll-mt-6 rounded-xl border border-line bg-card px-5 py-4', className)}
    >
      <h2 id="planner-title" className="text-[15px] font-medium">
        Planner and other dealers
      </h2>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Sites in these regions are serviced by another dealer: their machines leave PM due and the planner (toner orders are
        not affected). A customer page can override this per site. Leave a name blank to service that region yourselves.
      </p>

      {state.status === 'error' ? (
        <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      ) : state.status === 'saved' ? (
        <p role="status" className="mt-3 rounded-lg bg-brand-soft px-3 py-2 text-sm">
          Planner settings saved.
        </p>
      ) : null}

      <div className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {DEALERS.map((d) => (
          <div key={d.name} className="flex flex-col gap-1.5">
            <label htmlFor={`planner-${d.name}`} className="text-sm font-medium">
              {d.label}
            </label>
            <Input
              id={`planner-${d.name}`}
              name={d.name}
              maxLength={60}
              defaultValue={values[d.name]}
              aria-describedby={`planner-${d.name}-help`}
              className="h-8 w-64"
            />
            <p id={`planner-${d.name}-help`} className="text-xs text-muted-foreground">
              {d.help} Default {defaults[d.name] || 'none'}.
            </p>
          </div>
        ))}
        {NUMBERS.map((f) => (
          <div key={f.name} className="flex flex-col gap-1.5">
            <label htmlFor={`planner-${f.name}`} className="text-sm font-medium">
              {f.label}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`planner-${f.name}`}
                name={f.name}
                inputMode="numeric"
                required
                defaultValue={values[f.name]}
                aria-describedby={`planner-${f.name}-help`}
                className="h-8 w-32 tabular"
              />
              <span className="text-[13px] text-muted-foreground">{f.unit}</span>
            </div>
            <p id={`planner-${f.name}-help`} className="text-xs text-muted-foreground">
              {f.help} Default {defaults[f.name]}.
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        <label htmlFor="planner-patches" className="text-sm font-medium">
          Patches
        </label>
        <p id="planner-patches-help" className="text-xs text-muted-foreground">
          Optional named groups of postcode districts on the planner, one per line, such as “Farnborough patch: GU14, GU11, GU51”.
          A district can be in one patch only.
        </p>
        <textarea
          id="planner-patches"
          name="patches"
          rows={5}
          defaultValue={values.patches}
          aria-describedby="planner-patches-help"
          placeholder="Farnborough patch: GU14, GU11, GU51"
          spellCheck={false}
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-[13px] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        />
      </div>

      <div className="mt-4 flex justify-end">
        <Button type="submit" disabled={pending} className="bg-brand hover:bg-brand/90">
          {pending ? 'Saving…' : 'Save planner settings'}
        </Button>
      </div>
    </form>
  );
}
