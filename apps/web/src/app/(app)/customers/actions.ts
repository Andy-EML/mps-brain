'use server';

import { revalidatePath } from 'next/cache';
import { isFlaggableCustomer, setSelfManaged } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseSelfManagedForm, type SelfManagedResult } from '@/lib/self-managed-form';

/**
 * The customer page's *Self-managed stock* switch. `requireUser()` first — an action is a public
 * POST endpoint — and the user id comes from the session, never the form. Any signed-in user may
 * flip it. Turning it on supersedes the pending proposals in scope (inside `setSelfManaged`, which
 * also writes the audit row); turning it off changes nothing else.
 *
 * Returns a result rather than redirecting, so the switch's dialog can show a refusal in place.
 */
export async function setSelfManagedAction(formData: FormData): Promise<SelfManagedResult> {
  const user = await requireUser();
  const parsed = parseSelfManagedForm(formData);
  if (!parsed.ok) return parsed;

  const db = getDb();
  // A customer deleted in Vantage is accepted only when it already has a flag row (its page is
  // shown so a flag left on it can be turned off); any other deleted or unknown id is refused.
  if (!(await isFlaggableCustomer(db, parsed.vantageCustomerId))) {
    return { ok: false, error: 'That customer no longer exists. Refresh the page.' };
  }

  const { superseded } = await setSelfManaged(db, {
    vantageCustomerId: parsed.vantageCustomerId,
    on: parsed.on,
    note: parsed.note,
    userId: user.userId,
  });

  // The list's Stock column and counts, every customer page (a head office's flag shows on its
  // sites), the device pages and Toner orders (proposals just went).
  revalidatePath('/customers');
  revalidatePath('/customers/[id]', 'page');
  revalidatePath('/orders');
  revalidatePath('/devices', 'layout');
  revalidatePath('/');
  return { ok: true, superseded };
}
