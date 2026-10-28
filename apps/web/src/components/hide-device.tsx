'use client';

import { useFormStatus } from 'react-dom';
import { EyeOff } from 'lucide-react';
import { hideDeviceAction, unhideDeviceAction } from '@/app/(app)/devices/[id]/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Same cap as `HIDE_REASON_MAX` in @mps/db; the server refuses anything longer. */
const REASON_MAX = 500;

/** What hiding does, said the same way on the device page and in the bulk bar. */
export const HIDE_EXPLANATION =
  'Hidden devices leave the devices list, Fleet overview, Needs reconnecting and Link issues. They get no toner proposals or alerts — pending proposals are withdrawn and open alerts cleared. Nothing is sent to DRMS, and you can unhide them from the Hidden tab.';

/** The reason field both hide dialogs share. Enter would submit, which is fine: Hide is the only button. */
export function HideReasonField({ id }: { id: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Reason (optional)</Label>
      <Input id={id} name="reason" maxLength={REASON_MAX} placeholder="e.g. Contract ended March 2026" />
    </div>
  );
}

/** Where the device page was opened from, so the action can bring its Back link along. */
interface Origin {
  from?: string;
  back?: string;
}

function OriginFields({ from, back }: Origin) {
  return (
    <>
      {from ? <input type="hidden" name="from" value={from} /> : null}
      {back ? <input type="hidden" name="back" value={back} /> : null}
    </>
  );
}

/**
 * *Hide…* in the device page header: a short dialog with an optional reason, posting to
 * `hideDeviceAction`. A plain form, so a refused hide comes back as `?hideError=` on the page.
 */
export function HideDeviceDialog({ drmsId, name, ...origin }: { drmsId: string; name: string } & Origin) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <EyeOff aria-hidden />
        Hide…
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form action={hideDeviceAction} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Hide {name}?</DialogTitle>
            <DialogDescription>{HIDE_EXPLANATION}</DialogDescription>
          </DialogHeader>
          <input type="hidden" name="drmsId" value={drmsId} />
          <OriginFields {...origin} />
          <HideReasonField id={`hide-reason-${drmsId}`} />
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <SubmitButton label="Hide device" pendingLabel="Hiding…" />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** *Unhide* on the device page's hidden banner. */
export function UnhideDeviceButton({ drmsId, ...origin }: { drmsId: string } & Origin) {
  return (
    <form action={unhideDeviceAction} className="shrink-0">
      <input type="hidden" name="drmsId" value={drmsId} />
      <OriginFields {...origin} />
      <SubmitButton label="Unhide" pendingLabel="Unhiding…" variant="outline" />
    </form>
  );
}

/** Inside a form so `useFormStatus` can see it submitting. */
export function SubmitButton({
  label,
  pendingLabel,
  variant = 'default',
  size,
}: {
  label: string;
  pendingLabel: string;
  variant?: 'default' | 'outline';
  size?: 'sm';
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      disabled={pending}
      className={variant === 'default' ? 'bg-brand hover:bg-brand/90' : undefined}
    >
      {pending ? pendingLabel : label}
    </Button>
  );
}
