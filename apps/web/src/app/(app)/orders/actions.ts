'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ReplenishmentError,
  approveProposals,
  deleteOrder,
  getReviewDeviceDetail,
  markOrderOrdered,
  rejectProposals,
  returnOrderToReview,
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

/** Where a refused decision lands: see `decisionBackPath`; the device page also posts its own from/back. */
function backFrom(formData: FormData): string {
  return decisionBackPath(formData.get('back'), formData.get('drmsId'), {
    from: formData.get('deviceFrom'),
    back: formData.get('deviceBack'),
  });
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
  }, backFrom(formData));
  revalidateDevice(formData);
}

export async function rejectAction(formData: FormData): Promise<void> {
  const proposalIds = formData.getAll('proposalId').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || undefined;
  const back = backFrom(formData);
  await run(async (userId) => {
    await rejectProposals(getDb(), { proposalIds, userId, note });
  }, back);
  revalidateDevice(formData);
}

/** *Mark ordered*: a person raised this queued order by hand in Vantage and gives its reference. */
export async function markOrderedAction(formData: FormData): Promise<void> {
  const orderId = idFrom(formData, 'orderId');
  const reference = String(formData.get('reference') ?? '').trim().slice(0, 100) || undefined;
  const back = backFrom(formData);
  await run((userId) => markOrderOrdered(getDb(), { orderId: requireId(orderId), reference, userId }), back);
  revalidateDevice(formData);
}

/** *Back to review*: undoes the approval of a queued order. */
export async function returnToReviewAction(formData: FormData): Promise<void> {
  const orderId = idFrom(formData, 'orderId');
  const back = backFrom(formData);
  await run((userId) => returnOrderToReview(getDb(), { orderId: requireId(orderId), userId }), back);
  revalidateDevice(formData);
}

/** *Delete*: rejects a queued order's proposals, with the dialog's optional reason. */
export async function deleteOrderAction(formData: FormData): Promise<void> {
  const orderId = idFrom(formData, 'orderId');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || undefined;
  const back = backFrom(formData);
  await run((userId) => deleteOrder(getDb(), { orderId: requireId(orderId), userId, note }), back);
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
