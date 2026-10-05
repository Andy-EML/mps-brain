'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ReplenishmentError,
  approveProposals,
  getReviewDeviceDetail,
  rejectProposals,
  resolveOrder,
  retryOrder,
  type ReviewDeviceDetail,
} from '@mps/db/queries';
import { decisionBackPath } from '@/components/replenishment';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

/**
 * The write actions behind `/orders`. Each one calls `requireUser()` first — an action is a public
 * POST endpoint and the `(app)` layout does not gate it — and takes the user id from the session,
 * never from the form. Any signed-in user may decide proposals.
 *
 * The logic lives in `@mps/db/queries` (`replenishment-actions.ts`); a `ReplenishmentError` comes
 * back to the page as `?error=<code>`, which the page turns into a sentence. Approve and reject also
 * run from the device page's Replenishment card, whose form says so with `back=device`.
 */
async function run(fn: (userId: number) => Promise<void>, back: string): Promise<void> {
  const user = await requireUser();
  try {
    await fn(user.userId);
  } catch (err) {
    if (err instanceof ReplenishmentError) redirect(`${back}${back.includes('?') ? '&' : '?'}error=${err.code}`);
    throw err;
  }
  revalidatePath('/orders');
  revalidatePath('/');
}

/** The device page shows this device's proposals and orders; refresh it when the form names one. */
function revalidateDevice(formData: FormData): void {
  const drmsId = formData.get('drmsId');
  if (typeof drmsId === 'string' && drmsId !== '') revalidatePath(`/devices/${drmsId}`);
}

/** A positive integer id from the form, or null. */
function idFrom(formData: FormData, key: string): number | null {
  const n = Number(formData.get(key));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Thrown inside `run` so a bad id still goes through `requireUser()` and back as `?error=not_found`. */
function requireId(id: number | null): number {
  if (id === null) throw new ReplenishmentError('No such order.', 'not_found');
  return id;
}

export async function approveAction(formData: FormData): Promise<void> {
  await run(async (userId) => {
    const drmsId = String(formData.get('drmsId') ?? '');
    const ids = formData.getAll('proposalId').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const items = ids.map((proposalId) => ({ proposalId, quantity: Number(formData.get(`qty-${proposalId}`) ?? 1) }));
    await approveProposals(getDb(), { drmsId, items, userId });
    // Task 8 wakes the Vantage order sender here.
  }, decisionBackPath(formData.get('back'), String(formData.get('drmsId') ?? '')));
  revalidateDevice(formData);
}

export async function rejectAction(formData: FormData): Promise<void> {
  const proposalIds = formData.getAll('proposalId').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || undefined;
  const back = decisionBackPath(formData.get('back'), formData.get('drmsId'));
  await run(async (userId) => {
    await rejectProposals(getDb(), { proposalIds, userId, note });
  }, back);
  revalidateDevice(formData);
}

export async function resolveOrderAction(formData: FormData): Promise<void> {
  const orderId = idFrom(formData, 'orderId');
  const outcome = formData.get('outcome') === 'ordered' ? 'ordered' : 'failed';
  const reference = String(formData.get('reference') ?? '').trim().slice(0, 100) || undefined;
  await run(
    (userId) => resolveOrder(getDb(), { orderId: requireId(orderId), outcome, reference, userId }),
    '/orders?tab=in-progress',
  );
  revalidateDevice(formData);
}

export async function retryOrderAction(formData: FormData): Promise<void> {
  const orderId = idFrom(formData, 'orderId');
  await run(async (userId) => {
    await retryOrder(getDb(), { orderId: requireId(orderId), userId });
    // Task 8 wakes the Vantage order sender here.
  }, '/orders?tab=in-progress');
  revalidateDevice(formData);
}

/**
 * The Review tab's device detail panel, fetched when a row is first opened. Read-only, but still a
 * public POST endpoint, so it checks the session like the write actions above.
 */
export async function loadReviewDetail(drmsId: string): Promise<ReviewDeviceDetail | null> {
  await requireUser();
  if (typeof drmsId !== 'string' || drmsId === '' || drmsId.length > 200) return null;
  return getReviewDeviceDetail(getDb(), drmsId);
}
