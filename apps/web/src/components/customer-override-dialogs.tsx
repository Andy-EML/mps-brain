'use client';

import { useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Loader2, Plus, RotateCcw, Search } from 'lucide-react';
import type { VantageCustomerMatch } from '@mps/db/queries';
import {
  resetCustomerAction,
  searchCustomersAction,
  updateCustomerAction,
} from '@/app/(app)/settings/replenishment/actions';
import {
  clearSettingsError,
  SettingsFields,
  SettingsFormError,
  SettingsSubmitButton,
  type SettingsField,
  type SettingsHint,
} from '@/components/settings-dialog';
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

const FIELDS: SettingsField[] = ['black', 'cyan', 'magenta', 'yellow', 'autoReplenish', 'alertsEnabled'];

function deviceCount(n: number): string {
  return `${n} linked ${n === 1 ? 'device' : 'devices'}`;
}

export interface AddCustomerOverrideDialogProps {
  /** The defaults, shown as each field's hint: what the customer's devices get today. */
  initial: Partial<Record<SettingsField, SettingsHint>>;
  /** Customers that already have an override; picking one edits it. */
  existingIds: number[];
  /** A sentence for `?settingsError=` when `settingsFor=add`. */
  error?: string | null;
}

/**
 * *Add customer override*: find a Vantage customer (only those with a linked DRMS device — an
 * override on anyone else reaches no machine), then the same controls as every other settings
 * dialog. Saving posts to `updateCustomerAction`, the same upsert the row's Edit uses.
 */
export function AddCustomerOverrideDialog({ initial, existingIds, error }: AddCustomerOverrideDialogProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VantageCustomerMatch[] | null>(null);
  const [picked, setPicked] = useState<VantageCustomerMatch | null>(null);
  const [searching, startSearch] = useTransition();
  const router = useRouter();

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Closing forgets the search, so reopening starts clean rather than on a stale customer.
    if (!next) {
      setQuery('');
      setResults(null);
      setPicked(null);
    }
  }

  function search(term: string) {
    startSearch(async () => setResults(await searchCustomersAction(term)));
  }

  async function save(formData: FormData) {
    // A known error comes back as a redirect, which rejects this await and keeps the dialog open
    // (with the picked customer) and the error inside it.
    await updateCustomerAction(formData);
    onOpenChange(false);
    clearSettingsError(router);
  }

  const alreadyHasOverride = picked !== null && existingIds.includes(picked.vantageId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" className="bg-brand hover:bg-brand/90" />}>
        <Plus aria-hidden />
        Add customer override
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a customer override</DialogTitle>
          <DialogDescription>
            {picked
              ? 'Leave a field on Keep to leave it as it is. Inherit uses the default again.'
              : 'Find the customer by name or Vantage reference. Only customers with a linked device are listed.'}
          </DialogDescription>
        </DialogHeader>

        {picked ? (
          <form action={save} className="flex flex-col gap-4">
            <input type="hidden" name="vantageCustomerId" value={picked.vantageId} />
            <input type="hidden" name="settingsFor" value="add" />

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
            {alreadyHasOverride ? (
              <p className="text-xs text-muted-foreground">
                This customer already has an override. Saving changes it.
              </p>
            ) : null}

            <SettingsFields fields={FIELDS} initial={initial} allowInherit isColour />

            <SettingsFormError error={error} />

            <DialogFooter>
              <SettingsSubmitButton label="Save" pendingLabel="Saving…" />
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
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Type at least two characters and press Search.
                </p>
              ) : results.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No customer with a linked device matches “{query}”.
                </p>
              ) : (
                <ul>
                  {results.map((row) => (
                    <li key={row.vantageId} className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{row.name ?? `Vantage ${row.vantageId}`}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[row.reference, deviceCount(row.deviceCount)].filter(Boolean).join(' · ')}
                          {existingIds.includes(row.vantageId) ? ' · has an override' : ''}
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

export interface ResetCustomerDialogProps {
  vantageCustomerId: number;
  customerName: string;
  deviceCount: number;
}

/**
 * A customer override's *Reset*: every field back to Inherit, which deletes the row. Confirmed
 * first — it changes what a whole site's machines do. Device-level settings are untouched.
 */
export function ResetCustomerDialog({ vantageCustomerId, customerName, deviceCount: devices }: ResetCustomerDialogProps) {
  const [open, setOpen] = useState(false);

  async function reset(formData: FormData) {
    await resetCustomerAction(formData);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <RotateCcw aria-hidden />
        Reset
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset {customerName} to the defaults?</DialogTitle>
          <DialogDescription>
            This removes every override for this customer, so{' '}
            {devices === 1 ? 'its linked device follows' : `its ${devices} linked devices follow`} the default
            settings again. Settings made on an individual device still apply.
          </DialogDescription>
        </DialogHeader>
        <form action={reset}>
          <input type="hidden" name="vantageCustomerId" value={vantageCustomerId} />
          <DialogFooter>
            <ResetButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? 'Resetting…' : 'Reset to defaults'}
    </Button>
  );
}
