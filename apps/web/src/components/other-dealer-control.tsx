'use client';

import { useId, useState, useTransition } from 'react';
// Types only from @mps/db: its values would pull the database client into the browser bundle.
import type { OtherDealerInfo } from '@mps/db/queries';
import { setOtherDealerAction } from '@/app/(app)/customers/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OTHER_DEALER_NAME_MAX, otherDealerBadgeText, type OtherDealerMode } from '@/lib/other-dealer-form';

export interface OtherDealerControlProps {
  vantageCustomerId: number;
  customerName: string;
  /** This customer's own manual state; null = none (head office / region decide). */
  ownOverride: 'ours' | 'dealer' | null;
  /** The name on its own `dealer` flag. */
  ownDealerName: string | null;
  /** Who services it now. */
  effective: Pick<OtherDealerInfo, 'dealer' | 'source'>;
  /** What "Default" gives (head office flag, else the region rule). */
  defaultInfo: Pick<OtherDealerInfo, 'dealer' | 'source'>;
  /** Dealer names to suggest: the region dealers from the planner settings. */
  suggestions: string[];
  /** A head office's flag covers its sites (except a site set on its own). */
  isHeadOffice: boolean;
}

function defaultText(d: Pick<OtherDealerInfo, 'dealer' | 'source'>): string {
  if (d.dealer === null) return 'Us';
  return d.source === 'head_office' ? `${d.dealer}, via the head office` : `${d.dealer}, by region`;
}

const RADIO = 'mt-0.5 size-4 shrink-0 accent-brand';

/**
 * *PM by* on the customer page, beside *Self-managed stock*: who services this site for PM. A
 * button opens a dialog with Default (head office, else the region rule) / Ours (undoes a region
 * or head-office flag for this site) / Other dealer + name (the region dealers suggested). It never
 * changes by itself; the dialog says what it does. PM only — toner orders are not affected.
 */
export function OtherDealerControl({
  vantageCustomerId,
  customerName,
  ownOverride,
  ownDealerName,
  effective,
  defaultInfo,
  suggestions,
  isHeadOffice,
}: OtherDealerControlProps) {
  const initialMode: OtherDealerMode = ownOverride ?? 'default';
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<OtherDealerMode>(initialMode);
  const [name, setName] = useState(ownDealerName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const baseId = useId();
  const statusId = `${baseId}-status`;
  const nameId = `${baseId}-name`;
  const listId = `${baseId}-suggest`;
  const current = otherDealerBadgeText(effective) ?? 'Us';

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (next) {
      // Start from the saved state each time the dialog opens.
      setMode(initialMode);
      setName(ownDealerName ?? '');
    }
    if (!next) setError(null);
  }

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setOtherDealerAction(formData);
        if (result.ok) setOpen(false);
        else setError(result.error);
      } catch {
        setError('The change was not saved. Refresh the page and try again.');
      }
    });
  }

  const options: { value: OtherDealerMode; label: string; help: string }[] = [
    { value: 'default', label: 'Default', help: `Now: ${defaultText(defaultInfo)}.` },
    {
      value: 'ours',
      label: 'Ours',
      help: 'We do its PM, even if its region or head office says another dealer.',
    },
    { value: 'dealer', label: 'Other dealer', help: 'Another dealer does its PM.' },
  ];

  return (
    <>
      <div className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
        <span className="text-[13px] font-medium">PM by</span>
        <span id={statusId} className="text-[12px] text-muted-foreground">
          {current}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onOpenChange(true)}
          aria-describedby={statusId}
          className="h-7 px-2.5"
        >
          Change
        </Button>
      </div>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <form action={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Who does PM for {customerName}?</DialogTitle>
              <DialogDescription>
                Another dealer removes this site’s machines
                {isHeadOffice ? ' (and its sites’, unless a site is set on its own)' : ''} from PM due and the planner. Does not
                affect toner orders.
              </DialogDescription>
            </DialogHeader>

            <input type="hidden" name="vantageCustomerId" value={vantageCustomerId} />

            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">PM by</legend>
              {options.map((o) => {
                const id = `${baseId}-${o.value}`;
                return (
                  <label
                    key={o.value}
                    htmlFor={id}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
                  >
                    <input
                      id={id}
                      type="radio"
                      name="mode"
                      value={o.value}
                      checked={mode === o.value}
                      onChange={() => setMode(o.value)}
                      aria-describedby={`${id}-help`}
                      className={RADIO}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{o.label}</span>
                      <span id={`${id}-help`} className="block text-[12px] text-muted-foreground">
                        {o.help}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            {mode === 'dealer' ? (
              <div className="grid gap-1.5">
                <Label htmlFor={nameId}>Dealer’s name</Label>
                <Input
                  id={nameId}
                  name="name"
                  required
                  maxLength={OTHER_DEALER_NAME_MAX}
                  list={suggestions.length > 0 ? listId : undefined}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={suggestions[0] ? `e.g. ${suggestions[0]}` : 'e.g. MJ Flood'}
                  autoComplete="off"
                />
                {suggestions.length > 0 ? (
                  <datalist id={listId}>
                    {suggestions.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
              <Button type="submit" disabled={pending} className="bg-brand hover:bg-brand/90">
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
