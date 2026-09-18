'use client';

import { useActionState, useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { createUserAction, type AdminFormState } from '@/app/(app)/admin/actions';
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

/**
 * "Add user". A client component because the dialog has to close itself and report what happened;
 * the password never leaves the form — it is posted straight to the server action, which hashes it
 * and returns only a confirmation sentence.
 */
export function AddUserDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createUserAction, initialState);

  useEffect(() => {
    if (state.ok) {
      setOpen(false);
      toast.success(state.ok);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <UserPlus aria-hidden />
        Add user
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a user</DialogTitle>
          <DialogDescription>
            The username is stored in lower case and has to be unique. Admins can reach this section;
            operators can see everything else.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-username">Username</Label>
            <Input id="new-username" name="username" autoComplete="off" required className="h-10" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">Password</Label>
            <Input
              id="new-password"
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
            <Label htmlFor="new-role">Role</Label>
            <select
              id="new-role"
              name="role"
              defaultValue="operator"
              className="h-10 rounded-lg border border-input bg-transparent px-2.5 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          {state.error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
