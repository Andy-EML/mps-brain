'use server';

import { revalidatePath } from 'next/cache';
import {
  manualLink,
  searchVantageEquipment,
  setIssueStatus,
  unlinkDevice,
  type VantageMatch,
} from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';

/**
 * The write actions behind `/issues`. Every one of them calls `requireUser()` first — the `(app)`
 * layout does not gate a server action, and an action is a public POST endpoint. The operator's id
 * is always taken from the session; nothing user-shaped is ever read out of the form.
 *
 * The logic itself lives in `@mps/db/queries` (`issue-actions.ts`) so it can be tested without
 * React; these wrappers only authenticate, validate the input and revalidate the affected pages.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Pages whose contents change when a link or an issue does. */
function revalidateLinkViews(drmsId?: string): void {
  revalidatePath('/issues');
  revalidatePath('/devices');
  revalidatePath('/');
  if (drmsId) revalidatePath(`/devices/${drmsId}`);
}

/** Shortest query worth hitting the database with — one character matches most of the fleet. */
const MIN_QUERY = 2;

/** Typeahead for the link picker: Vantage equipment by serial, asset number or customer name. */
export async function searchVantageAction(query: string): Promise<VantageMatch[]> {
  await requireUser();
  const q = query.trim();
  if (q.length < MIN_QUERY) return [];
  return searchVantageEquipment(getDb(), q, 20);
}

/** Links a DRMS device to a Vantage record by hand, resolving the issues that asked for it. */
export async function linkDeviceAction(drmsId: string, vantageId: number): Promise<ActionResult> {
  const user = await requireUser();

  if (!drmsId || !Number.isInteger(vantageId)) {
    return { ok: false, message: 'That link request was incomplete — nothing was changed.' };
  }

  try {
    await manualLink(getDb(), { drmsId, vantageId, userId: user.userId });
  } catch {
    // Most likely a device or Vantage record that has since been deleted (a foreign key), or two
    // operators linking the same record at once. The detail belongs in the server log, not on a
    // toast, so the operator just gets told to look again.
    return { ok: false, message: 'Could not link that device — refresh the queue and try again.' };
  }

  revalidateLinkViews(drmsId);
  return { ok: true, message: `Linked to Vantage ${vantageId}.` };
}

/** Closes a device's active link. The issue stays open — unlinking is not the same as fixing. */
export async function unlinkDeviceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const drmsId = String(formData.get('drmsId') ?? '');
  if (!drmsId) return;

  // No reason is passed: `unlinkDevice` stamps `manual_unlink`, which is exactly what this is and
  // is already distinct from every reason `link-run` writes (`relinked`, `drms_missing`, …).
  await unlinkDevice(getDb(), { drmsId, userId: user.userId });
  revalidateLinkViews(drmsId);
}

const STATUSES = new Set(['open', 'ignored', 'resolved']);

/** Ignore / resolve / reopen one issue. */
export async function setIssueStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const issueId = Number(formData.get('issueId'));
  const status = String(formData.get('status') ?? '');
  if (!Number.isInteger(issueId) || !STATUSES.has(status)) return;

  await setIssueStatus(getDb(), {
    issueId,
    status: status as 'open' | 'ignored' | 'resolved',
    userId: user.userId,
  });
  revalidateLinkViews();
}
