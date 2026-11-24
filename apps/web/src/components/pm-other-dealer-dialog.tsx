'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
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
import { OTHER_DEALER_NAME_MAX } from '@/lib/other-dealer-form';

export interface PmOtherDealerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vantageCustomerId: number;
  /** "C&LC, Altrincham" — the site whose machines leave PM. */
  siteLabel: string;
  /** Dealer names to suggest (the planner's region dealers). */
  suggestions: string[];
}

/**
 * PM due row menu → *Other dealer…*: sets this machine's site to another dealer (the same manual
 * flag as *PM by* on the customer page, `setOtherDealerAction` with mode `dealer`), so every machine
 * at the site leaves PM due and the planner. Undo is *Mark as ours* on the Other dealer tab.
 */
export function PmOtherDealerDialog({ open, onOpenChange, vantageCustomerId, siteLabel, suggestions }: PmOtherDealerDialogProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const listId = `${baseId}-suggest`;

  function change(next: boolean) {
    if (pending) return;
    if (!next) setError(null);
    onOpenChange(next);
  }

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setOtherDealerAction(formData);
        if (result.ok) {
          onOpenChange(false);
          router.refresh();
        } else setError(result.error);
      } catch {
        setError('The change was not saved. Refresh the page and try again.');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md">
        <form action={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Another dealer does PM for {siteLabel}?</DialogTitle>
            <DialogDescription>
              Every machine at this site leaves PM due and the planner. Toner orders are not affected. Undo it from the Other
              dealer tab (Mark as ours) or the customer page.
            </DialogDescription>
          </DialogHeader>

          <input type="hidden" name="vantageCustomerId" value={vantageCustomerId} />
          <input type="hidden" name="mode" value="dealer" />

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
              placeholder="e.g. MJ Flood"
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

          {error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Mark as other dealer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
