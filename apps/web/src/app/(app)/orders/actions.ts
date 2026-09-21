'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ReplenishmentError, approveProposals, rejectProposals, resolveOrder, retryOrder } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

/**
 * The write actions behind `/orders`. Each one calls `requireUser()` first — an action is a public
 * POST endpoint and the `(app)` layout does not gate it — and takes the user id from the session,
 * never from the form. Any signed-in user may decide proposals.
 *
 * The logic lives in `@mps/db/queries` (`replenishment-actions.ts`); a `ReplenishmentError` comes
 * back to the page as `?error=<code>`, which the page turns into a sentence.
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

export async function approveAction(formData: FormData): Promise<void> {
  const drmsId = String(formData.get('drmsId') ?? '');
  const ids = formData.getAll('proposalId').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const items = ids.map((proposalId) => ({ proposalId, quantity: Number(formData.get(`qty-${proposalId}`) ?? 1) }));
  await run(async (userId) => {
    await approveProposals(getDb(), { drmsId, items, userId });
    // Task 8 wakes the Vantage order sender here.
  }, '/orders');
  revalidatePath(`/devices/${drmsId}`);
}

export async function rejectAction(formData: FormData): Promise<void> {
  const proposalIds = formData.getAll('proposalId').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || undefined;
  const back = formData.get('back') === 'in-progress' ? '/orders?tab=in-progress' : '/orders';
  await run(async (userId) => {
    await rejectProposals(getDb(), { proposalIds, userId, note });
  }, back);
  const drmsId = String(formData.get('drmsId') ?? '');
  if (drmsId) revalidatePath(`/devices/${drmsId}`);
}

export async function resolveOrderAction(formData: FormData): Promise<void> {
  const orderId = Number(formData.get('orderId'));
  const outcome = formData.get('outcome') === 'ordered' ? 'ordered' : 'failed';
  const reference = String(formData.get('reference') ?? '').trim().slice(0, 100) || undefined;
  await run((userId) => resolveOrder(getDb(), { orderId, outcome, reference, userId }), '/orders?tab=in-progress');
}

export async function retryOrderAction(formData: FormData): Promise<void> {
  const orderId = Number(formData.get('orderId'));
  await run(async (userId) => {
    await retryOrder(getDb(), { orderId, userId });
    // Task 8 wakes the Vantage order sender here.
  }, '/orders?tab=in-progress');
}
