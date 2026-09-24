'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  RegistrationError,
  approveRegistrations,
  rejectRegistrations,
  requestRetry,
  unrejectRegistration,
} from '@mps/db/queries';
import { QUEUES, sendJob } from '@mps/queue';
import { parseRegistrationTab, selectedIds } from '@/components/registrations';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requiredEnv } from '@/lib/env';

/**
 * The write actions behind `/registrations`. Each calls `requireUser()` first — an action is a
 * public POST endpoint and the `(app)` layout does not gate it — and takes the user id from the
 * session, never from the form. Any signed-in user may decide.
 *
 * Nothing here calls DRMS. Approving (or retrying) marks rows `approved` and wakes the worker's
 * `drms-registration-submit` job, which registers them one at a time; its 10-minute sweep picks
 * them up anyway if the wake-up cannot be queued.
 *
 * A `RegistrationError` comes back to the page as `?error=<code>`, which the page turns into a
 * sentence.
 */
async function run(fn: (userId: number) => Promise<unknown>, back: string): Promise<void> {
  const user = await requireUser();
  try {
    await fn(user.userId);
  } catch (err) {
    if (err instanceof RegistrationError) redirect(`${back}${back.includes('?') ? '&' : '?'}error=${err.code}`);
    throw err;
  }
  revalidatePath('/registrations');
}

/** Back to the tab the form was posted from. */
function backTo(formData: FormData): string {
  const tab = parseRegistrationTab(String(formData.get('tab') ?? ''));
  return tab === 'awaiting' ? '/registrations' : `/registrations?tab=${tab}`;
}

/** Thrown inside `run` so a bad id still goes through `requireUser()` and back as `?error=not_found`. */
function oneId(formData: FormData): number {
  const n = Number(formData.get('id'));
  if (!Number.isInteger(n) || n <= 0) throw new RegistrationError('No such registration.', 'not_found');
  return n;
}

/** Wakes the sender. Not fatal: the approval is saved, and the sweep sends it within 10 minutes. */
async function wakeSubmit(): Promise<void> {
  try {
    await sendJob(requiredEnv('DATABASE_URL'), QUEUES.drmsRegistrationSubmit);
  } catch (err) {
    console.error('[registrations] could not queue drms-registration-submit; the sweep will pick it up', err);
  }
}

export async function approveRegistrationsAction(formData: FormData): Promise<void> {
  await run(async (userId) => {
    const ids = selectedIds(formData);
    await approveRegistrations(getDb(), { ids, userId });
    await wakeSubmit();
  }, backTo(formData));
}

export async function rejectRegistrationsAction(formData: FormData): Promise<void> {
  await run((userId) => {
    const ids = selectedIds(formData);
    const note = String(formData.get('note') ?? '').trim().slice(0, 500) || undefined;
    return rejectRegistrations(getDb(), { ids, userId, note });
  }, backTo(formData));
}

export async function unrejectRegistrationAction(formData: FormData): Promise<void> {
  await run((userId) => unrejectRegistration(getDb(), { registrationId: oneId(formData), userId }), backTo(formData));
}

export async function retryRegistrationAction(formData: FormData): Promise<void> {
  await run(async (userId) => {
    await requestRetry(getDb(), { registrationId: oneId(formData), userId });
    await wakeSubmit();
  }, backTo(formData));
}
