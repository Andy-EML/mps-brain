'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { SettingsError, dismissPm, markPmBooked, undoPmAction } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseBookedForm, parseDismissForm, parseUndoForm, pmErrorKey, pmReturnHref } from '@/lib/pm-action-form';

/**
 * `/pm` row actions: Mark booked, Dismiss, Undo. Recorded in the app only — nothing is written to
 * Vantage. Each calls `requireUser()` first (an action is a public POST endpoint) and takes the
 * user id from the session, never the form. Every form posts `return`, the list URL it came from;
 * the action goes back there with `?open=<machine>` so the row stays open. A refusal comes back as
 * `pmError=<key>` (see `pmErrorKey`), shown in that row; any other error (the database) is logged
 * and shown as "Couldn't save — try again" rather than the error page.
 */

/** The machine id as posted, read before the full parse so even a refused form reopens its row. */
function postedId(formData: FormData): number | null {
  const raw = formData.get('vantageEquipmentId');
  return typeof raw === 'string' && /^\d{1,10}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

/** Runs one action, then goes back to the list with the machine's row open. */
async function run(formData: FormData, work: (userId: number) => Promise<unknown>): Promise<void> {
  const user = await requireUser();
  const open = postedId(formData);
  const back = formData.get('return');
  let error: string | null = null;
  try {
    await work(user.userId);
  } catch (err) {
    if (!(err instanceof SettingsError)) console.error('[pm] action failed', err);
    error = pmErrorKey(err);
  }
  // redirect() throws, so it stays outside the try.
  if (error !== null) redirect(open === null ? '/pm' : pmReturnHref(back, open, error));
  revalidatePath('/pm');
  redirect(open === null ? '/pm' : pmReturnHref(back, open));
}

export async function markPmBookedAction(formData: FormData): Promise<void> {
  await run(formData, (userId) => markPmBooked(getDb(), { ...parseBookedForm(formData), userId }));
}

export async function dismissPmAction(formData: FormData): Promise<void> {
  await run(formData, (userId) => dismissPm(getDb(), { ...parseDismissForm(formData, new Date()), userId }));
}

export async function undoPmActionAction(formData: FormData): Promise<void> {
  // undoPmAction returns false when the action was already cleared (by someone else, or a visit was
  // seen): nothing left to undo, so the list simply reloads.
  await run(formData, (userId) => undoPmAction(getDb(), parseUndoForm(formData).actionId, userId));
}
