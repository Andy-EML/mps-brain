'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { vantageCustomers } from '@mps/db';
import {
  SettingsError,
  searchVantageCustomers,
  updateCustomerSettings,
  updateDefaultSettings,
  type SettingsPatch,
  type VantageCustomerMatch,
} from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseSettingsForm } from '@/lib/settings-form';

/**
 * `/settings/replenishment`: the default row and per-customer overrides. Every action calls
 * `requireUser()` first — an action is a public POST endpoint — and takes the user id from the
 * session, never the form. Any signed-in user may change settings. The query functions write the
 * audit row.
 *
 * A `SettingsError` comes back as `?settingsError=<code>&settingsFor=<dialog>`: the page turns the
 * code into a sentence and shows it inside the dialog it came from (`default`, `add`, or
 * `customer-<id>`), which stays open.
 */

const PAGE = '/settings/replenishment';

/** Shortest query worth hitting the database with — one character matches most customers. */
const MIN_QUERY = 2;

/** Every setting back to Inherit: the customer's row goes, so its devices follow the defaults. */
const RESET_ALL: SettingsPatch = {
  thresholdBlack: null,
  thresholdCyan: null,
  thresholdMagenta: null,
  thresholdYellow: null,
  autoReplenish: null,
  alertsEnabled: null,
};

function fail(code: string, dialog: string): never {
  redirect(`${PAGE}?settingsError=${encodeURIComponent(code)}&settingsFor=${encodeURIComponent(dialog)}`);
}

/** The settings page itself, and everything that counts "Needs toner" / "Manual replenishment". */
function revalidate() {
  revalidatePath(PAGE);
  revalidatePath('/');
  revalidatePath('/orders');
  revalidatePath('/devices');
}

/**
 * The posted `vantageCustomerId`, if it is a whole number naming a customer we hold. Otherwise
 * null — a stale or crafted form, which writes nothing.
 */
async function customerId(formData: FormData): Promise<number | null> {
  const raw = String(formData.get('vantageCustomerId') ?? '').trim();
  if (!/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  const [row] = await getDb()
    .select({ id: vantageCustomers.vantageId })
    .from(vantageCustomers)
    .where(eq(vantageCustomers.vantageId, id));
  return row ? id : null;
}

/** The customer picker in *Add customer override*: customers with a linked device, by name or reference. */
export async function searchCustomersAction(query: string): Promise<VantageCustomerMatch[]> {
  await requireUser();
  const q = String(query ?? '').trim();
  if (q.length < MIN_QUERY) return [];
  return searchVantageCustomers(getDb(), q, 20);
}

/** *Defaults* → Edit. Nothing to inherit from, so every field is Keep or a value. */
export async function updateDefaultsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    const patch = parseSettingsForm(formData, { allowInherit: false, isColour: true });
    await updateDefaultSettings(getDb(), { patch, userId: user.userId });
  } catch (err) {
    if (err instanceof SettingsError) fail(err.code, 'default');
    throw err;
  }
  revalidate();
}

/**
 * A customer override's Edit, and *Add customer override* (the same upsert — adding one for a
 * customer that already has one edits it). `settingsFor` is posted by the dialog so an error lands
 * back in it; it only picks where the message shows.
 */
export async function updateCustomerAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const dialog = String(formData.get('settingsFor') ?? '') === 'add' ? 'add' : null;
  const id = await customerId(formData);
  if (id === null) fail('unknown_customer', dialog ?? 'customer');

  try {
    // Customer settings reach colour and mono devices alike; mono devices ignore CMY.
    const patch = parseSettingsForm(formData, { allowInherit: true, isColour: true });
    await updateCustomerSettings(getDb(), { vantageCustomerId: id, patch, userId: user.userId });
  } catch (err) {
    if (err instanceof SettingsError) fail(err.code, dialog ?? `customer-${id}`);
    throw err;
  }
  revalidate();
}

/** *Reset*: every field back to Inherit, which deletes the customer's row (audited like any edit). */
export async function resetCustomerAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = await customerId(formData);
  if (id === null) fail('unknown_customer', 'reset');
  await updateCustomerSettings(getDb(), { vantageCustomerId: id, patch: RESET_ALL, userId: user.userId });
  revalidate();
}
