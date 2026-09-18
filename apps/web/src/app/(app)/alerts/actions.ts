'use server';

import { revalidatePath } from 'next/cache';
import { acknowledgeAlert } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

/**
 * The write action behind `/alerts`. `requireUser()` is the first statement: the `(app)` layout
 * does not gate a server action, and an action is a public POST endpoint. The operator's id comes
 * from the session and is never read out of the form — the form carries only the alert id.
 *
 * The logic lives in `@mps/db/queries` (`alert-actions.ts`) so it can be tested without React;
 * this wrapper only authenticates, validates the input and revalidates the affected pages.
 */
export async function acknowledgeAlertAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const alertId = Number(formData.get('alertId'));
  if (!Number.isInteger(alertId) || alertId <= 0) return;

  await acknowledgeAlert(getDb(), { alertId, userId: user.userId });

  // `/alerts` moves the row from Open to Acknowledged, and the device page's offline banner swaps
  // its Acknowledge button for "acknowledged by …". The sidebar badge counts *uncleared* alerts,
  // which acknowledging does not change, so it is deliberately not revalidated.
  revalidatePath('/alerts');
  const drmsId = String(formData.get('drmsId') ?? '');
  if (drmsId) revalidatePath(`/devices/${drmsId}`);
}
