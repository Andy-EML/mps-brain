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

/** A field the dialog can edit: a colour's threshold, or one of the flags. */
export type SettingsField = ThresholdColour | FlagField;

type FlagField = 'autoReplenish' | 'alertsEnabled' | 'spareBlack';

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
  spareBlack: 'Spare black on site',
};

/** A line of help under a field's label, for a flag whose name does not say what it does. */
const HELP: Partial<Record<SettingsField, string>> = {
  spareBlack: 'When black toner is changed, propose 1 black to replace the spare.',
};

const CMY: readonly SettingsField[] = ['cyan', 'magenta', 'yellow'];

/** The native select, styled like `Input`; posts its value with the form, no JS needed. */
const SELECT =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-[13px] transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30';

function isThreshold(field: SettingsField): field is ThresholdColour {
  return field !== 'autoReplenish' && field !== 'alertsEnabled' && field !== 'spareBlack';
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
  const [thresholds, setThresholds] = useState<Partial<Record<ThresholdColour, ThresholdState>>>({});
  const stateOf = (colour: ThresholdColour) => thresholds[colour] ?? KEEP;
  const update = (colour: ThresholdColour, next: ThresholdState) => setThresholds((t) => ({ ...t, [colour]: next }));
  // Black is the one set first; "copy" saves opening three more selects to repeat it.
  const copyTargets = CMY.filter((f): f is ThresholdColour => shown.includes(f) && isThreshold(f));
  const canCopy = shown.includes('black') && copyTargets.length > 0;
  const copyBlack = () => {
    const black = stateOf('black');
    setThresholds((t) => ({ ...t, ...Object.fromEntries(copyTargets.map((c) => [c, { ...black }])) }));
  };
  return (
    <div className="flex flex-col divide-y divide-line/70">
      {shown.map((field) =>
        isThreshold(field) ? (
          <ThresholdField
            key={field}
            colour={field}
            hint={initial?.[field]}
            allowInherit={allowInherit}
            state={stateOf(field)}
            onChange={(next) => update(field, next)}
            onCopy={field === 'black' && canCopy ? copyBlack : undefined}
          />
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
  help,
  hint,
  extra,
  children,
}: {
  id: string;
  label: string;
  /** What the setting does, under the label. */
  help?: string;
  hint: SettingsHint | undefined;
  /** Shown under the hint, e.g. Black's "Copy to C, M, Y". */
  extra?: ReactNode;
  children: ReactNode;
}) {
  const text = hintText(hint);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-2.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
        {text ? <p className="text-xs text-muted-foreground">{text}</p> : null}
        {extra}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

interface ThresholdState {
  mode: 'keep' | 'inherit' | 'set';
  value: string;
}

const KEEP: ThresholdState = { mode: 'keep', value: '' };

/**
 * Keep / Inherit / Set to, and the percentage. Typing a number switches the mode to Set to.
 * Black's row carries "Copy to C, M, Y", which gives the other colours the same mode and value.
 */
function ThresholdField({
  colour,
  hint,
  allowInherit,
  state,
  onChange,
  onCopy,
}: {
  colour: ThresholdColour;
  hint: SettingsHint | undefined;
  allowInherit: boolean;
  state: ThresholdState;
  onChange: (next: ThresholdState) => void;
  onCopy?: () => void;
}) {
  const id = useId();
  const { mode, value } = state;
  return (
    <FieldShell
      id={id}
      label={LABELS[colour]}
      hint={hint}
      extra={
        onCopy ? (
          <button
            type="button"
            onClick={onCopy}
            disabled={mode === 'keep'}
            className="text-xs font-medium text-brand underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          >
            Copy to C, M, Y
          </button>
        ) : null
      }
    >
      <select
        id={id}
        name={`threshold-${colour}-mode`}
        value={mode}
        onChange={(e) => onChange({ mode: e.target.value as ThresholdState['mode'], value })}
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
          onChange={(e) => onChange({ mode: e.target.value !== '' ? 'set' : mode, value: e.target.value })}
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
  field: FlagField;
  hint: SettingsHint | undefined;
  allowInherit: boolean;
}) {
  const id = useId();
  return (
    <FieldShell id={id} label={LABELS[field]} help={HELP[field]} hint={hint}>
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
