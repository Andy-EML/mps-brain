'use client';

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { setSelfManagedAction } from '@/app/(app)/customers/actions';
import { customerHref, selfManagedPreviewText } from '@/components/customers';
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
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SELF_MANAGED_NOTE_MAX } from '@/lib/self-managed-form';

export interface SelfManagedSwitchProps {
  vantageCustomerId: number;
  customerName: string;
  /** This customer's own flag. */
  on: boolean;
  /** Set when the customer is self-managed through its head office: the switch is then locked here. */
  viaHeadOffice: { vantageId: number; name: string | null } | null;
  /** `previewSelfManaged`, read when the page rendered: what turning it on would clear. */
  preview: { pending: number; devices: number; sites: number };
}

/**
 * *Self-managed stock* on the customer page. The switch never flips by itself: off → on opens a
 * confirm dialog saying how many pending proposals it clears, with an optional note; on → off is a
 * plain confirm. A site whose head office is self-managed shows the switch on and locked, with a
 * link to the head office — the head office's flag covers every site, with no exceptions.
 */
export function SelfManagedSwitch({ vantageCustomerId, customerName, on, viaHeadOffice, preview }: SelfManagedSwitchProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const switchId = useId();
  const noteId = useId();

  if (viaHeadOffice && !on) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
        <Switch id={switchId} checked disabled aria-describedby={`${switchId}-via`} />
        <Label htmlFor={switchId} className="text-[13px] font-medium">
          Self-managed stock
        </Label>
        <span id={`${switchId}-via`} className="text-[12px] text-muted-foreground">
          via head office{' '}
          <Link href={customerHref(viaHeadOffice.vantageId)} className="font-medium text-brand hover:underline">
            {viaHeadOffice.name ?? `Customer ${viaHeadOffice.vantageId}`}
          </Link>
        </span>
      </div>
    );
  }

  const turningOn = !on;

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) setError(null);
  }

  function submit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setSelfManagedAction(formData);
        if (result.ok) setOpen(false);
        else setError(result.error);
      } catch {
        setError('The change was not saved. Refresh the page and try again.');
      }
    });
  }

  return (
    <>
      <div className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
        <Switch id={switchId} checked={on} onCheckedChange={() => onOpenChange(true)} />
        <Label htmlFor={switchId} className="text-[13px] font-medium">
          Self-managed stock
        </Label>
        <span className="text-[12px] text-muted-foreground">{on ? 'On' : 'Off'}</span>
      </div>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <form action={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                {turningOn ? `Make ${customerName} self-managed?` : `Turn self-managed off for ${customerName}?`}
              </DialogTitle>
              <DialogDescription>
                {turningOn
                  ? 'The customer keeps its own toner: no toner proposals are raised for its machines (and its sites’ machines, for a head office). Approved orders and in-progress proposals are left alone.'
                  : 'Toner proposals start again from the machines’ current levels at the next evaluation. Nothing cleared earlier comes back.'}
              </DialogDescription>
            </DialogHeader>

            <input type="hidden" name="vantageCustomerId" value={vantageCustomerId} />
            <input type="hidden" name="on" value={turningOn ? 'true' : 'false'} />

            {turningOn ? (
              <>
                <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm font-medium">{selfManagedPreviewText(preview)}</p>
                <div className="grid gap-1.5">
                  <Label htmlFor={noteId}>Note (optional)</Label>
                  <textarea
                    id={noteId}
                    name="note"
                    rows={3}
                    maxLength={SELF_MANAGED_NOTE_MAX}
                    placeholder="e.g. Buys toner direct from KM since March 2026"
                    className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  />
                </div>
              </>
            ) : null}

            {error ? (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
              <Button type="submit" disabled={pending} className="bg-brand hover:bg-brand/90">
                {pending ? 'Saving…' : turningOn ? 'Turn on' : 'Turn off'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
