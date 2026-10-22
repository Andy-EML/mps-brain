'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import type { FamilySummary } from '@mps/db/queries';
import { cn } from 'cn';
import { deleteFamilyAction, saveFamilyAction } from '@/app/(app)/settings/cartridge-families/actions';
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
import { CONSUMABLE_LABELS, familyCarries, parseModels } from '@/lib/family-fields';

/** How many unmapped models to offer as one-click suggestions under the models box. */
const MAX_SUGGESTIONS = 12;

/** The native select, styled like `Input` (the same as the replenishment settings dialog). */
const SELECT =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-[13px] transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30';

/**
 * After a successful save or delete: drop a stale `?error=` from an earlier attempt so the page
 * stops showing it.
 */
function clearError(router: ReturnType<typeof useRouter>) {
  const url = new URL(window.location.href);
  if (url.searchParams.has('error') || url.searchParams.has('errorFor')) {
    url.searchParams.delete('error');
    url.searchParams.delete('errorFor');
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }
}

function FormError({ error }: { error?: string | null }) {
  return error ? (
    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

function SubmitButton({ label, pendingLabel, destructive }: { label: string; pendingLabel: string; destructive?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      variant={destructive ? 'destructive' : 'default'}
      className={destructive ? undefined : 'bg-brand hover:bg-brand/90'}
    >
      {pending ? pendingLabel : label}
    </Button>
  );
}

interface FamilyState {
  name: string;
  isColour: boolean;
  models: string[];
  yields: Record<ReplenishColour, string>;
  notes: string;
}

function initialState(family: FamilySummary | undefined): FamilyState {
  const yields = {} as Record<ReplenishColour, string>;
  for (const c of REPLENISH_COLOURS) {
    const v = family?.ratedYield[c];
    yields[c] = v === undefined ? '' : String(v);
  }
  return {
    name: family?.name ?? '',
    isColour: family?.isColour ?? true,
    models: family?.models ?? [],
    yields,
    notes: family?.notes ?? '',
  };
}

export interface FamilyDialogProps {
  /** The family to edit; none for *Add family*. */
  family?: FamilySummary;
  /** Models of linked devices that are in no family: the suggestions under the models box. */
  unmapped: { model: string; devices: number }[];
  /** A sentence for `?error=` when it belongs to this dialog. */
  error?: string | null;
}

/**
 * *Add family* and a row's *Edit*. Every field is controlled, so a refused save (a redirect back
 * with `?error=`, which keeps the dialog open) leaves what the operator typed in place. Models are
 * chips: type one and press Enter or comma, paste a list, or pick a suggestion; anything still in
 * the box when saving is posted too. A mono family hides its cyan, magenta and yellow yields and
 * the action clears them.
 */
export function FamilyDialog({ family, unmapped, error }: FamilyDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FamilyState>(() => initialState(family));
  const [typed, setTyped] = useState('');
  const router = useRouter();
  const ids = { name: useId(), kind: useId(), models: useId(), list: useId(), notes: useId() };

  function onOpenChange(next: boolean) {
    // Opening starts from the saved family (or a blank one), not from an abandoned edit.
    if (next) {
      setState(initialState(family));
      setTyped('');
    }
    setOpen(next);
  }

  async function save(formData: FormData) {
    await saveFamilyAction(formData);
    setOpen(false);
    clearError(router);
  }

  function addModels(raw: string) {
    const more = parseModels(raw).filter((m) => !state.models.includes(m));
    if (more.length > 0) setState((s) => ({ ...s, models: [...s.models, ...more] }));
  }

  function removeModel(model: string) {
    setState((s) => ({ ...s, models: s.models.filter((m) => m !== model) }));
  }

  function onModelKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addModels(typed);
      setTyped('');
    } else if (event.key === 'Backspace' && typed === '' && state.models.length > 0) {
      removeModel(state.models.at(-1)!);
    }
  }

  const needle = typed.trim().toLowerCase();
  const suggestions = unmapped
    .filter((u) => !state.models.includes(u.model) && (needle === '' || u.model.toLowerCase().includes(needle)))
    .slice(0, MAX_SUGGESTIONS);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {family ? (
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <Pencil aria-hidden />
          Edit
        </DialogTrigger>
      ) : (
        <DialogTrigger render={<Button size="sm" className="bg-brand hover:bg-brand/90" />}>
          <Plus aria-hidden />
          Add family
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{family ? `Edit ${family.name}` : 'Add a cartridge family'}</DialogTitle>
          <DialogDescription>
            Models in one family share cartridges, so their sites share one shelf of spares.
          </DialogDescription>
        </DialogHeader>

        <form action={save} className="flex flex-col gap-4">
          {family ? <input type="hidden" name="id" value={family.id} /> : null}
          {state.models.map((m) => (
            <input key={m} type="hidden" name="model" value={m} />
          ))}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.name} className="text-sm font-medium">
                Name
              </label>
              <Input
                id={ids.name}
                name="name"
                required
                maxLength={120}
                value={state.name}
                onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
                placeholder="e.g. bizhub C300i series"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.kind} className="text-sm font-medium">
                Type
              </label>
              <select
                id={ids.kind}
                name="kind"
                value={state.isColour ? 'colour' : 'mono'}
                onChange={(e) => setState((s) => ({ ...s, isColour: e.target.value === 'colour' }))}
                className={cn(SELECT, 'w-28')}
              >
                <option value="colour">Colour</option>
                <option value="mono">Mono</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.models} className="text-sm font-medium">
              Models
            </label>
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
              {state.models.map((m) => (
                <span key={m} className="inline-flex items-center gap-1 rounded-full bg-secondary py-0.5 pr-1 pl-2.5 text-[12px] font-medium">
                  {m}
                  <button
                    type="button"
                    onClick={() => removeModel(m)}
                    aria-label={`Remove ${m}`}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </span>
              ))}
              <input
                id={ids.models}
                name="modelsText"
                list={ids.list}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={onModelKey}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  if (/[,;\r\n]/.test(text)) {
                    e.preventDefault();
                    addModels(text);
                  }
                }}
                placeholder={state.models.length === 0 ? 'Type a model and press Enter' : ''}
                className="h-6 min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <datalist id={ids.list}>
                {unmapped.map((u) => (
                  <option key={u.model} value={u.model} />
                ))}
              </datalist>
            </div>
            <p className="text-xs text-muted-foreground">
              The exact model name DRMS reports. Separate several with commas, or paste a list.
            </p>
            {suggestions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">No family yet:</span>
                {suggestions.map((u) => (
                  <button
                    key={u.model}
                    type="button"
                    onClick={() => {
                      addModels(u.model);
                      setTyped('');
                    }}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-[12px] text-muted-foreground hover:border-solid hover:bg-muted hover:text-foreground"
                  >
                    <Plus aria-hidden className="size-3" />
                    {u.model}
                    <span className="tabular">· {u.devices}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">Rated yield (pages)</legend>
            <p className="text-xs text-muted-foreground">Optional. Leave blank when not known.</p>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
              {REPLENISH_COLOURS.filter((c) => familyCarries(state.isColour, c)).map((c) => (
                <label key={c} className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                  {CONSUMABLE_LABELS[c]}
                  <Input
                    name={`yield-${c}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    value={state.yields[c]}
                    onChange={(e) => setState((s) => ({ ...s, yields: { ...s.yields, [c]: e.target.value } }))}
                    className="h-8 tabular"
                  />
                </label>
              ))}
            </div>
            {!state.isColour ? (
              <p className="text-xs text-muted-foreground">A mono family holds black and waste toner only.</p>
            ) : null}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.notes} className="text-sm font-medium">
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id={ids.notes}
              name="notes"
              rows={2}
              maxLength={500}
              value={state.notes}
              onChange={(e) => setState((s) => ({ ...s, notes: e.target.value }))}
              placeholder="Cartridge part numbers, anything worth knowing"
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30"
            />
          </div>

          <FormError error={error} />

          <DialogFooter>
            <SubmitButton label={family ? 'Save' : 'Add family'} pendingLabel="Saving…" />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface DeleteFamilyDialogProps {
  family: Pick<FamilySummary, 'id' | 'name' | 'shelves'>;
  error?: string | null;
}

/**
 * A row's *Delete*, confirmed first. Disabled while any shelf uses the family — those must go
 * first; `deleteFamily` refuses it too (`in_use`) in case a shelf appeared since the page loaded.
 */
export function DeleteFamilyDialog({ family, error }: DeleteFamilyDialogProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function remove(formData: FormData) {
    await deleteFamilyAction(formData);
    setOpen(false);
    clearError(router);
  }

  if (family.shelves > 0) {
    return (
      <span title={`${family.shelves} ${family.shelves === 1 ? 'shelf uses' : 'shelves use'} this family`}>
        <Button variant="outline" size="sm" disabled>
          <Trash2 aria-hidden />
          Delete
        </Button>
      </span>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Trash2 aria-hidden />
        Delete
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {family.name}?</DialogTitle>
          <DialogDescription>
            Its models go back to having no family. No shelf uses it, so no site stock is affected.
          </DialogDescription>
        </DialogHeader>
        <form action={remove} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={family.id} />
          <FormError error={error} />
          <DialogFooter>
            <SubmitButton label="Delete family" pendingLabel="Deleting…" destructive />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
