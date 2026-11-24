'use server';

import { revalidatePath } from 'next/cache';
import {
  SettingsError,
  isFlaggableCustomer,
  listCustomerMachineStatus,
  listCustomerSiteStatus,
  setOtherDealer,
  setSelfManaged,
  type MachineStatusRow,
  type SiteStatusRow,
} from '@mps/db/queries';
import { parseCustomerIdArg } from '@/components/customer-status';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { OtherDealerFormError, parseOtherDealerForm, type OtherDealerResult } from '@/lib/other-dealer-form';
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

const BAD_ID = 'That customer no longer exists. Refresh the page.';

/**
 * The customer page's *PM by* control: Default / Ours / Other dealer + name. `requireUser()` first
 * — an action is a public POST endpoint — and the user id comes from the session, never the form.
 * Any signed-in user may change it. PM only: it changes which machines PM due and the planner
 * show (and the Customers PM warnings), never toner proposals; `setOtherDealer` writes the audit row.
 *
 * Returns a result rather than redirecting, so the dialog can show a refusal in place. The only
 * messages shown are our own (the form parser's and `setOtherDealer`'s), never echoed input.
 */
export async function setOtherDealerAction(formData: FormData): Promise<OtherDealerResult> {
  const user = await requireUser();
  let parsed: ReturnType<typeof parseOtherDealerForm>;
  try {
    parsed = parseOtherDealerForm(formData);
  } catch (err) {
    if (err instanceof OtherDealerFormError) return { ok: false, error: err.message };
    throw err;
  }

  const db = getDb();
  // As the self-managed switch: a deleted customer only when it already has a flag row.
  if (!(await isFlaggableCustomer(db, parsed.vantageCustomerId))) {
    return { ok: false, error: BAD_ID };
  }
  try {
    await setOtherDealer(db, { vantageCustomerId: parsed.vantageCustomerId, mode: parsed.mode, name: parsed.name, userId: user.userId });
  } catch (err) {
    if (err instanceof SettingsError) return { ok: false, error: err.message };
    throw err;
  }

  // The badges on the list and every customer page (a head office's flag shows on its sites), and
  // the PM lists the site leaves or rejoins.
  revalidatePath('/customers');
  revalidatePath('/customers/[id]', 'page');
  revalidatePath('/pm');
  revalidatePath('/pm/planner');
  return { ok: true };
}

/**
 * The `/customers` accordion's machine lines for one customer (its own devices, not its sites'),
 * loaded on first expand. Writes nothing of its own, but the PM figures come from
 * `listPmForEquipment`, which clears PM actions that have run their course (as the PM page does).
 * `requireUser()` first — an action is a public POST endpoint — and the id must be a plain
 * digit string.
 */
export async function loadCustomerMachinesAction(customerId: unknown): Promise<MachineStatusRow[] | { error: string }> {
  await requireUser();
  const id = parseCustomerIdArg(customerId);
  if (id === null) return { error: BAD_ID };
  try {
    return await listCustomerMachineStatus(getDb(), id);
  } catch (err) {
    console.error('loadCustomerMachinesAction failed', err);
    return { error: "Couldn't load machines — try again" };
  }
}

/**
 * A head office's site lines (figures + warnings) for the accordion. Like the machines action, it
 * may clear finished PM actions through `listPmForEquipment`; nothing else is written.
 */
export async function loadCustomerSitesAction(headOfficeId: unknown): Promise<SiteStatusRow[] | { error: string }> {
  await requireUser();
  const id = parseCustomerIdArg(headOfficeId);
  if (id === null) return { error: BAD_ID };
  try {
    return await listCustomerSiteStatus(getDb(), id);
  } catch (err) {
    console.error('loadCustomerSitesAction failed', err);
    return { error: "Couldn't load sites — try again" };
  }
}
