'use client';

import { useId, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from 'cn';
import type { ThresholdColour } from '@/lib/settings-form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/** A field the dialog can edit: a colour's threshold, or one of the two flags. */
export type SettingsField = ThresholdColour | 'autoReplenish' | 'alertsEnabled';

/** What applies now, shown as a hint beside the field: `Now 15% · default`. */
export interface SettingsHint {
  value: number | boolean;
  /** Where it came from, e.g. `customer setting · by jo, 3 Aug 2026`. */
  origin?: string;
}

export interface SettingsDialogProps {
  title: string;
  description?: ReactNode;
  /** Which fields to offer, in order. Cyan/magenta/yellow are dropped when `isColour` is false. */
  fields: SettingsField[];
  /** The effective value per field, shown as a hint; nothing is pre-filled. */
  initial?: Partial<Record<SettingsField, SettingsHint>>;
  /** Offer "Inherit" (reset to the level above). False for the default settings. */
  allowInherit: boolean;
  isColour: boolean;
  /**
   * Reads the form with `parseSettingsForm`: a server action, or (the devices-list bulk bar) a
   * client function that moves on to a confirmation step. Resolving `false` keeps the dialog open.
   */
  action: (formData: FormData) => Promise<void | boolean>;
  /** Hidden inputs posted with the form, e.g. `{ drmsId }`; an array posts one input per value. */
  hidden?: Record<string, string | string[]>;
  /** A sentence for an error the action sent back (`?settingsError=`), shown inside the dialog. */
  error?: string | null;
  triggerLabel?: string;
  submitLabel?: string;
  /** The submit button's text while the action runs. */
  pendingLabel?: string;
}

const LABELS: Record<SettingsField, string> = {
  black: 'Black threshold',
  cyan: 'Cyan threshold',
  magenta: 'Magenta threshold',
  yellow: 'Yellow threshold',
  autoReplenish: 'Auto-replenish',
  alertsEnabled: 'No-meter-reading alerts',
};

const CMY: readonly SettingsField[] = ['cyan', 'magenta', 'yellow'];

/** The native select, styled like `Input`; posts its value with the form, no JS needed. */
const SELECT =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-[13px] transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30';

function isThreshold(field: SettingsField): field is ThresholdColour {
  return field !== 'autoReplenish' && field !== 'alertsEnabled';
}

function hintText(hint: SettingsHint | undefined): string | null {
  if (!hint) return null;
  const value = typeof hint.value === 'boolean' ? (hint.value ? 'on' : 'off') : `${hint.value}%`;
  return hint.origin ? `Now ${value} · ${hint.origin}` : `Now ${value}`;
}

/**
 * The replenishment-settings editor, shared by the device page (one device), the devices-list bulk
 * bar and `/settings/replenishment` (customer and default rows). Every field starts on *Keep*, so
 * saving writes only what the operator actually changed; *Inherit* clears the override so the
 * level above applies again. The field names are the ones `parseSettingsForm` reads.
 *
 * Errors: a server action sends a `SettingsError` back as a redirect to `?settingsError=<code>`;
 * the page turns the code into a sentence with `settingsErrorMessage` and passes it in as `error`,
 * shown inside the dialog. A successful save closes the dialog and drops a stale `settingsError`.
 */
export function SettingsDialog({
  title,
  description,
  fields,
  initial,
  allowInherit,
  isColour,
  action,
  hidden,
  error,
  triggerLabel = 'Edit',
  submitLabel = 'Save',
  pendingLabel = 'Saving…',
}: SettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function submit(formData: FormData) {
    // A known error comes back as a redirect, which rejects this await and leaves the dialog open
    // with the error inside it. Getting here means it saved (or, resolving `false`, that the action
    // wants the dialog left open).
    if ((await action(formData)) === false) return;
    setOpen(false);
    clearSettingsError(router);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <SlidersHorizontal aria-hidden />
        {triggerLabel}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ??
              (allowInherit
                ? 'Leave a field on Keep to leave it as it is. Inherit removes the override, so the customer or default value applies again.'
                : 'Leave a field on Keep to leave it as it is.')}
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="flex flex-col gap-4">
          {Object.entries(hidden ?? {}).flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value]).map((v, i) => (
              <input key={`${name}-${i}`} type="hidden" name={name} value={v} />
            )),
          )}

          <SettingsFields fields={fields} initial={initial} allowInherit={allowInherit} isColour={isColour} />

          <SettingsFormError error={error} />

          <DialogFooter>
            <SettingsSubmitButton label={submitLabel} pendingLabel={pendingLabel} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * After a successful save: drop a stale `?settingsError=` from an earlier attempt so the page stops
 * showing it (and `settingsFor=`, which `/settings/replenishment` adds to say which of its dialogs
 * the error belongs to). Shared with that page's add-customer-override dialog.
 */
export function clearSettingsError(router: ReturnType<typeof useRouter>) {
  const url = new URL(window.location.href);
  if (url.searchParams.has('settingsError') || url.searchParams.has('settingsFor')) {
    url.searchParams.delete('settingsError');
    url.searchParams.delete('settingsFor');
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }
}

/**
 * The field rows alone, for a form that is not this dialog (the add-customer-override dialog puts
 * a customer picker in front of them). Posts the same names `parseSettingsForm` reads.
 */
export function SettingsFields({
  fields,
  initial,
  allowInherit,
  isColour,
}: Pick<SettingsDialogProps, 'fields' | 'initial' | 'allowInherit' | 'isColour'>) {
  const shown = fields.filter((f) => isColour || !CMY.includes(f));
  return (
    <div className="flex flex-col divide-y divide-line/70">
      {shown.map((field) =>
        isThreshold(field) ? (
          <ThresholdField key={field} colour={field} hint={initial?.[field]} allowInherit={allowInherit} />
        ) : (
          <FlagField key={field} field={field} hint={initial?.[field]} allowInherit={allowInherit} />
        ),
      )}
    </div>
  );
}

export function SettingsFormError({ error }: { error?: string | null }) {
  return error ? (
    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

function FieldShell({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: SettingsHint | undefined;
  children: ReactNode;
}) {
  const text = hintText(hint);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {text ? <p className="text-xs text-muted-foreground">{text}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Keep / Inherit / Set to, and the percentage. Typing a number switches the mode to Set to. */
function ThresholdField({
  colour,
  hint,
  allowInherit,
}: {
  colour: ThresholdColour;
  hint: SettingsHint | undefined;
  allowInherit: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<'keep' | 'inherit' | 'set'>('keep');
  const [value, setValue] = useState('');
  return (
    <FieldShell id={id} label={LABELS[colour]} hint={hint}>
      <select
        id={id}
        name={`threshold-${colour}-mode`}
        value={mode}
        onChange={(e) => setMode(e.target.value as typeof mode)}
        className={cn(SELECT, 'w-28')}
      >
        <option value="keep">Keep</option>
        {allowInherit ? <option value="inherit">Inherit</option> : null}
        <option value="set">Set to</option>
      </select>
      <div className="relative">
        <Input
          aria-label={`${LABELS[colour]} percentage`}
          name={`threshold-${colour}`}
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          required={mode === 'set'}
          placeholder={typeof hint?.value === 'number' ? String(hint.value) : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (e.target.value !== '') setMode('set');
          }}
          className={cn('h-8 w-20 pr-6 tabular', mode !== 'set' && 'opacity-50')}
        />
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[13px] text-muted-foreground">
          %
        </span>
      </div>
    </FieldShell>
  );
}

/** Keep / Inherit / On / Off. */
function FlagField({
  field,
  hint,
  allowInherit,
}: {
  field: 'autoReplenish' | 'alertsEnabled';
  hint: SettingsHint | undefined;
  allowInherit: boolean;
}) {
  const id = useId();
  return (
    <FieldShell id={id} label={LABELS[field]} hint={hint}>
      <select id={id} name={field} defaultValue="keep" className={cn(SELECT, 'w-28')}>
        <option value="keep">Keep</option>
        {allowInherit ? <option value="inherit">Inherit</option> : null}
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </FieldShell>
  );
}

export function SettingsSubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="bg-brand hover:bg-brand/90">
      {pending ? pendingLabel : label}
    </Button>
  );
}
