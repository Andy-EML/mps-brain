'use client';

import { useActionState, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { resetPasswordAction, type AdminFormState } from '@/app/(app)/admin/actions';
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
import { Label } from '@/components/ui/label';

const initialState: AdminFormState = {};

/** Must match `MIN_PASSWORD_LENGTH` in `@mps/db/queries`, which is what actually enforces it. */
const MIN_PASSWORD = 12;

export interface ResetPasswordDialogProps {
  userId: number;
  username: string;
  /** Resetting your own password is allowed; the wording changes so it is obviously deliberate. */
  isSelf?: boolean;
}

/**
 * "Reset password". The admin types the new password twice; only the hash is stored, and the
 * action's reply never repeats or describes it.
 */
export function ResetPasswordDialog({ userId, username, isSelf }: ResetPasswordDialogProps) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(resetPasswordAction, initialState);

  useEffect(() => {
    if (state.ok) {
      setOpen(false);
      toast.success(`${username}: ${state.ok.toLowerCase()}`);
    }
  }, [state, username]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <KeyRound aria-hidden />
        Reset password
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset the password for {username}</DialogTitle>
          <DialogDescription>
            The old password stops working immediately.{' '}
            {isSelf
              ? 'This is your own account — you will need the new password next time you sign in.'
              : 'Any browser they are already signed in on keeps its session until the cookie expires (12 hours).'}
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="userId" value={userId} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`pw-${userId}`}>New password</Label>
            <Input
              id={`pw-${userId}`}
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              required
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD} characters.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`pw2-${userId}`}>Repeat it</Label>
            <Input
              id={`pw2-${userId}`}
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              required
              className="h-10"
            />
          </div>

          {state.error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Change password'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
