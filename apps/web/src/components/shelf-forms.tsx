'use client';

import { useId, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Loader2, Minus, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { MAX_HOLDING, type ReplenishColour, type ShelfConsumableCounts } from '@mps/core';
import type { VantageCustomerMatch } from '@mps/db/queries';
import { cn } from 'cn';
import {
  correctCountsAction,
  createShelfAction,
  deleteShelfAction,
  searchShelfCustomersAction,
  updateHoldingsAction,
} from '@/app/(app)/site-stock/actions';
import { pillState, shelfColours } from '@/components/shelf';
import { ConsumablePill } from '@/components/shelf-pills';
import { ToneBadge } from '@/components/tone-badge';
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
import { CONSUMABLE_LABELS } from '@/lib/family-fields';

/** The native select, styled like `Input` (as on the cartridge families dialog). */
const SELECT =
  'h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

/** After a successful save: drop a stale `?error=` from an earlier attempt so the page stops showing it. */
function clearError(router: ReturnType<typeof useRouter>) {
  const url = new URL(window.location.href);
  if (url.searchParams.has('error') || url.searchParams.has('errorFor') || url.searchParams.has('reset')) {
    url.searchParams.delete('error');
    url.searchParams.delete('errorFor');
    url.searchParams.delete('reset');
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

function SubmitButton({
  label,
  pendingLabel,
  destructive,
  disabled,
}: {
  label: string;
  pendingLabel: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending || disabled}
      variant={destructive ? 'destructive' : 'default'}
      className={destructive ? undefined : 'bg-brand hover:bg-brand/90'}
    >
      {pending ? pendingLabel : label}
    </Button>
  );
}

function deviceCount(n: number): string {
  return `${n} linked ${n === 1 ? 'device' : 'devices'}`;
}

// ---- + New shelf ------------------------------------------------------------------------------

export interface NewShelfDialogProps {
  families: { id: number; name: string; isColour: boolean; models: string[] }[];
  /** A sentence for `?error=` when `errorFor=add`. */
  error?: string | null;
}

/**
 * *+ New shelf*: find the site (a Vantage customer with a linked device, the same search as a
 * customer override), pick the cartridge family, create. The shelf opens next, to set what it
 * holds; its machines are everything at that site whose model is in the family.
 */
export function NewShelfDialog({ families, error }: NewShelfDialogProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VantageCustomerMatch[] | null>(null);
  const [picked, setPicked] = useState<VantageCustomerMatch | null>(null);
  const [familyId, setFamilyId] = useState('');
  const [searching, startSearch] = useTransition();
  const familyField = useId();

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Closing forgets the search, so reopening starts clean rather than on a stale site.
    if (!next) {
      setQuery('');
      setResults(null);
      setPicked(null);
      setFamilyId('');
    }
  }

  function search(term: string) {
    startSearch(async () => setResults(await searchShelfCustomersAction(term)));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" className="bg-brand hover:bg-brand/90" />}>
        <Plus aria-hidden />
        New shelf
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New site stock shelf</DialogTitle>
          <DialogDescription>
            {picked
              ? 'Pick the cartridge family. Every machine at this site whose model is in it draws from the shelf.'
              : 'Find the site by name or Vantage reference. Only customers with a linked device are listed.'}
          </DialogDescription>
        </DialogHeader>

        {picked ? (
          // A known error comes back as a redirect, which rejects the action's await and keeps the
          // dialog open, with the picked site and family, and the error inside it.
          <form action={createShelfAction} className="flex flex-col gap-4">
            <input type="hidden" name="vantageCustomerId" value={picked.vantageId} />

            <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{picked.name ?? `Vantage ${picked.vantageId}`}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[picked.reference, deviceCount(picked.deviceCount)].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(null)}>
                Change
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={familyField} className="text-sm font-medium">
                Cartridge family
              </label>
              {families.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No cartridge families yet. Add them under Settings → Cartridge families first.
                </p>
              ) : (
                <select
                  id={familyField}
                  name="familyId"
                  required
                  value={familyId}
                  onChange={(e) => setFamilyId(e.target.value)}
                  className={SELECT}
                >
                  <option value="" disabled>
                    Choose a family…
                  </option>
                  {families.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.isColour ? 'colour' : 'mono'})
                    </option>
                  ))}
                </select>
              )}
              {familyId !== '' ? (
                <p className="text-xs text-muted-foreground">
                  Models: {families.find((f) => String(f.id) === familyId)?.models.join(', ') || 'none yet'}
                </p>
              ) : null}
            </div>

            <FormError error={error} />

            <DialogFooter>
              <SubmitButton label="Create shelf" pendingLabel="Creating…" disabled={familyId === ''} />
            </DialogFooter>
          </form>
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                search(query);
              }}
              className="relative"
            >
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Customer name or reference"
                aria-label="Search customers"
                className="h-10 w-full rounded-lg border border-line bg-card pr-20 pl-9 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={searching}
                className="absolute top-1/2 right-2 -translate-y-1/2"
              >
                Search
              </Button>
            </form>

            <div className="max-h-[300px] min-h-[120px] overflow-y-auto rounded-lg border border-line">
              {searching ? (
                <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                  Searching…
                </p>
              ) : results === null ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Type at least two characters and press Search.</p>
              ) : results.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No customer with a linked device matches “{query}”.</p>
              ) : (
                <ul>
                  {results.map((row) => (
                    <li key={row.vantageId} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{row.name ?? `Vantage ${row.vantageId}`}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[row.reference, deviceCount(row.deviceCount)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <Button size="sm" variant="outline" onClick={() => setPicked(row)}>
                        Choose
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- holdings ----------------------------------------------------------------------------------

export interface HoldingsFormProps {
  shelfId: number;
  isColour: boolean;
  holding: ShelfConsumableCounts;
  used: ShelfConsumableCounts;
  /** A sentence for `?error=` when `errorFor=holdings`. */
  error?: string | null;
  /** A sentence for `?error=` when `errorFor=correct`. */
  correctError?: string | null;
}

const clamp = (n: number) => Math.min(MAX_HOLDING, Math.max(0, Math.trunc(n)));

/**
 * The shelf page's *Holdings* card: a 0–20 stepper per consumable the family carries, the used
 * count beside it ("last one in" once it reaches the holding), Save, and *Correct counts*. The
 * page keys this on the saved values, so it starts again from them after a save; a refused save
 * keeps what the operator entered.
 */
export function HoldingsForm({ shelfId, isColour, holding, used, error, correctError }: HoldingsFormProps) {
  const colours = shelfColours(isColour);
  const [values, setValues] = useState<Record<ReplenishColour, number>>(() => ({ ...holding }));
  const router = useRouter();
  const dirty = colours.some((c) => values[c] !== holding[c]);

  async function save(formData: FormData) {
    await updateHoldingsAction(formData);
    clearError(router);
  }

  const set = (c: ReplenishColour, n: number) => setValues((v) => ({ ...v, [c]: clamp(Number.isFinite(n) ? n : 0) }));

  return (
    <section className="rounded-xl border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">Holdings</h2>
        <CorrectCountsDialog shelfId={shelfId} isColour={isColour} used={used} error={correctError} />
      </div>
      <p className="mt-0.5 text-[13px] text-muted-foreground">Spares kept on the shelf, and how many have gone in since the last top-up.</p>
      <form action={save} className="mt-2">
        <input type="hidden" name="shelfId" value={shelfId} />
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="py-2 pr-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                <span className="sr-only">Consumable</span>
              </th>
              <th scope="col" className="py-2 pr-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Held
              </th>
              <th scope="col" className="py-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Used since last top-up
              </th>
            </tr>
          </thead>
          <tbody>
            {colours.map((c) => {
              const full = pillState(holding[c], used[c]) === 'full';
              return (
                <tr key={c} className="border-b border-line/70 last:border-b-0">
                  <th scope="row" className="py-2 pr-3 font-normal">
                    <ConsumablePill colour={c} label={CONSUMABLE_LABELS[c]} text={c === 'waste' ? 'Waste' : undefined} />
                  </th>
                  <td className="py-2 pr-3">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={`One fewer ${CONSUMABLE_LABELS[c].toLowerCase()}`}
                        disabled={values[c] <= 0}
                        onClick={() => set(c, values[c] - 1)}
                      >
                        <Minus aria-hidden />
                      </Button>
                      <Input
                        name={`holding-${c}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAX_HOLDING}
                        step={1}
                        value={values[c]}
                        onChange={(e) => set(c, e.target.valueAsNumber)}
                        aria-label={`${CONSUMABLE_LABELS[c]} held`}
                        className="h-7 w-12 px-1 text-center tabular"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={`One more ${CONSUMABLE_LABELS[c].toLowerCase()}`}
                        disabled={values[c] >= MAX_HOLDING}
                        onClick={() => set(c, values[c] + 1)}
                      >
                        <Plus aria-hidden />
                      </Button>
                    </div>
                  </td>
                  <td className="py-2 tabular">
                    <span className={cn('font-medium', holding[c] === 0 && used[c] === 0 && 'text-muted-foreground')}>
                      {used[c]}
                    </span>
                    {full ? (
                      <ToneBadge tone="critical" dot={false} className="ml-2 px-2 py-0.5 text-[11px]">
                        last one in
                      </ToneBadge>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!isColour ? <p className="mt-2 text-xs text-muted-foreground">A mono shelf holds black and waste toner only.</p> : null}
        <div className="mt-3">
          <FormError error={error} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SubmitButton label="Save holdings" pendingLabel="Saving…" disabled={!dirty} />
          <span className="text-xs text-muted-foreground">Correct a used count by hand if a site tells you otherwise.</span>
        </div>
      </form>
    </section>
  );
}

// ---- correct counts ----------------------------------------------------------------------------

interface CorrectCountsDialogProps {
  shelfId: number;
  isColour: boolean;
  used: ShelfConsumableCounts;
  error?: string | null;
}

/**
 * *Correct counts*: set what has been used since the last top-up by hand, confirmed and audited.
 * Opens with the error inside it after a refused save. Sits in the box header, outside the
 * holdings form, so the two never submit together.
 */
function CorrectCountsDialog({ shelfId, isColour, used, error }: CorrectCountsDialogProps) {
  const colours = shelfColours(isColour);
  const [open, setOpen] = useState(error != null);
  const [values, setValues] = useState<Record<ReplenishColour, string>>(() => strings(used));
  const router = useRouter();
  const dirty = colours.some((c) => values[c].trim() !== String(used[c]));

  function onOpenChange(next: boolean) {
    if (next) setValues(strings(used));
    setOpen(next);
  }

  async function save(formData: FormData) {
    await correctCountsAction(formData);
    setOpen(false);
    clearError(router);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Pencil aria-hidden />
        Correct counts
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Correct the used counts?</DialogTitle>
          <DialogDescription>
            How many spares have gone in since the last top-up. The next top-up orders these amounts, and it fires once a
            count reaches its holding. The change is recorded in the audit log with your name.
          </DialogDescription>
        </DialogHeader>
        <form action={save} className="flex flex-col gap-4">
          <input type="hidden" name="shelfId" value={shelfId} />
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
            {colours.map((c) => (
              <label key={c} className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                {CONSUMABLE_LABELS[c]} <span className="sr-only">used</span>
                <Input
                  name={`used-${c}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={values[c]}
                  onChange={(e) => setValues((v) => ({ ...v, [c]: e.target.value }))}
                  className="h-8 tabular"
                />
              </label>
            ))}
          </div>
          <FormError error={error} />
          <DialogFooter>
            <SubmitButton label="Save corrected counts" pendingLabel="Saving…" disabled={!dirty} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function strings(counts: ShelfConsumableCounts): Record<ReplenishColour, string> {
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, String(v)])) as Record<ReplenishColour, string>;
}

// ---- delete ------------------------------------------------------------------------------------

export interface DeleteShelfDialogProps {
  shelfId: number;
  name: string;
  liveTopUp: boolean;
  error?: string | null;
}

/**
 * *Delete shelf*, confirmed first. A pending top-up is withdrawn with it; an approved one blocks
 * the delete (`in_use`), and the error shows in here.
 */
export function DeleteShelfDialog({ shelfId, name, liveTopUp, error }: DeleteShelfDialogProps) {
  const [open, setOpen] = useState(error != null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Trash2 aria-hidden />
        Delete shelf
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete the {name} shelf?</DialogTitle>
          <DialogDescription>
            Its machines go back to normal replenishment for every consumable, and its log of Empties is removed.
            {liveTopUp ? ' Its pending top-up is withdrawn; an approved one has to be settled on Toner orders first.' : ''}
          </DialogDescription>
        </DialogHeader>
        <form action={deleteShelfAction} className="flex flex-col gap-4">
          <input type="hidden" name="shelfId" value={shelfId} />
          <FormError error={error} />
          <DialogFooter>
            <SubmitButton label="Delete shelf" pendingLabel="Deleting…" destructive />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
