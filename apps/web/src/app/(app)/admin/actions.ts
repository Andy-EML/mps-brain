'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  AdminActionError,
  applyDefaultCounterCategories,
  createUser,
  resetPassword,
  setCounterCategory,
  setUserActive,
  type CounterCategory,
  type UserRole,
} from '@mps/db/queries';
import { isQueueName, sendJob } from '@mps/queue';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requiredEnv } from '@/lib/env';

/**
 * The write actions behind `/admin`.
 *
 * **`await requireAdmin()` is the first statement in every one of them.** A server action is a
 * public POST endpoint: the `(app)` layout does not gate it, and hiding the Admin link in the
 * sidebar gates nothing at all. An operator who posts one of these by hand is redirected to `/`
 * before any argument is read.
 *
 * The logic itself lives in `@mps/db/queries` (`admin-actions.ts`) so it can be tested against a
 * real Postgres without React; these wrappers authenticate, validate the form input and
 * revalidate the affected pages.
 *
 * Nothing here logs a password or the DRMS token.
 */

export interface AdminFormState {
  error?: string;
  /** A confirmation the dialog shows before it closes. Never contains a password. */
  ok?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

const ROLES: UserRole[] = ['admin', 'operator'];
const CATEGORIES: CounterCategory[] = ['meter', 'supply', 'other'];

/** Anything the admin can fix is shown; anything else is a bug and stays in the server log. */
function present(err: unknown, fallback: string): string {
  if (err instanceof AdminActionError) return err.message;
  console.error('[admin]', err);
  return fallback;
}

export async function createUserAction(_prev: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin();

  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? '');
  if (!ROLES.includes(role as UserRole)) return { error: 'Pick a role.' };

  try {
    await createUser(getDb(), { username, password, role: role as UserRole });
  } catch (err) {
    return { error: present(err, 'The user could not be created.') };
  }

  revalidatePath('/admin/users');
  revalidatePath('/admin');
  return { ok: `${username.trim().toLowerCase()} can now sign in.` };
}

/**
 * Activate / deactivate, as a plain form so it works without JavaScript. The happy path's feedback
 * is the row's own Status cell changing; the only way to reach the error path is a forged POST
 * (the button is not rendered for your own row), so that message is carried back on the URL
 * rather than thrown at the operator as a stack trace.
 */
export async function setUserActiveAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const userId = Number(formData.get('userId'));
  const active = formData.get('active') === 'true';
  if (!Number.isInteger(userId) || userId <= 0) return;

  try {
    // `actorUserId` comes from the session, never from the form: this is what stops an admin
    // deactivating themselves even if the hidden input is edited.
    await setUserActive(getDb(), { userId, active, actorUserId: admin.userId });
  } catch (err) {
    // A *code*, not the sentence. The page looks the wording up, so nobody can hand an admin a
    // link that puts words of their choosing into a trusted-looking error box.
    if (!(err instanceof AdminActionError)) console.error('[admin]', err);
    redirect(`/admin/users?error=${err instanceof AdminActionError ? err.code : 'failed'}`);
  }

  revalidatePath('/admin/users');
  revalidatePath('/admin');
}

export async function resetPasswordAction(_prev: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin();

  const userId = Number(formData.get('userId'));
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  if (!Number.isInteger(userId) || userId <= 0) return { error: 'That user no longer exists.' };
  if (password !== confirm) return { error: 'The two passwords do not match.' };

  try {
    await resetPassword(getDb(), { userId, password });
  } catch (err) {
    return { error: present(err, 'The password could not be changed.') };
  }

  revalidatePath('/admin/users');
  // Deliberately says nothing about the password itself — not its length, not a preview.
  return { ok: 'Password changed. The old one no longer works.' };
}

/** Called from the category dropdown on `/admin/counters`, one counter at a time. */
export async function setCounterCategoryAction(name: string, category: string): Promise<ActionResult> {
  await requireAdmin();

  if (!name) return { ok: false, message: 'No counter given.' };
  const value: CounterCategory | null = CATEGORIES.includes(category as CounterCategory)
    ? (category as CounterCategory)
    : null;
  if (category !== '' && value === null) return { ok: false, message: 'Unknown category.' };

  try {
    await setCounterCategory(getDb(), { name, category: value });
  } catch (err) {
    return { ok: false, message: present(err, 'That category could not be saved.') };
  }

  revalidatePath('/admin/counters');
  // The device page reads `counter_names.category` when it lists a device's latest counters.
  revalidatePath('/devices', 'layout');
  return { ok: true, message: value ? `${name} is now a ${value} counter.` : `${name} is no longer categorised.` };
}

/** The "Set defaults" button: the spec's three meters and four toner levels, nothing else. */
export async function applyDefaultCountersAction(): Promise<void> {
  await requireAdmin();
  await applyDefaultCounterCategories(getDb());
  revalidatePath('/admin/counters');
  revalidatePath('/devices', 'layout');
  revalidatePath('/admin');
}

/**
 * Queues one job by name. The queue name is checked against `QUEUES` before it reaches pg-boss,
 * so the form cannot name an arbitrary queue.
 *
 * `DATABASE_URL` comes from `requiredEnv`, which reads `process.env` first and only falls back to
 * the repo-root `.env` in development — `next dev` never loads that file itself.
 */
export async function triggerJobAction(queue: string): Promise<ActionResult> {
  const admin = await requireAdmin();

  if (!isQueueName(queue)) return { ok: false, message: 'Unknown job.' };

  try {
    const jobId = await sendJob(requiredEnv('DATABASE_URL'), queue);
    console.log(`[admin] ${admin.username ?? admin.userId} queued ${queue}${jobId ? ` (${jobId})` : ''}`);
    revalidatePath('/admin/jobs');
    revalidatePath('/admin');
    return jobId
      ? { ok: true, message: `${queue} queued. It starts as soon as the worker picks it up.` }
      : { ok: true, message: `${queue} is already queued or running — this run was folded into it.` };
  } catch (err) {
    return { ok: false, message: present(err, `${queue} could not be queued.`) };
  }
}
