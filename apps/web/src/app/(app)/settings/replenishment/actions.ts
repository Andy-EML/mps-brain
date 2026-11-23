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
import { customerReturn } from '@/lib/customer-return';
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
 * `customer-<id>`), which stays open. A dialog on a customer page posts `returnTo=/customers/<id>`,
 * and its error goes back there instead (as `settingsError=<code>`, beside the page's own `back`).
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
  spareBlack: null,
};

/** `page` (a customer page, which may already carry `?back=`) with `settingsError` added. */
function withSettingsError(page: string, code: string): string {
  const url = new URL(page, 'http://settings.invalid');
  url.searchParams.set('settingsError', code);
  return `${url.pathname}${url.search}`;
}

function fail(code: string, dialog: string, returnTo: string | null = null): never {
  if (returnTo) redirect(withSettingsError(returnTo, code));
  redirect(`${PAGE}?settingsError=${encodeURIComponent(code)}&settingsFor=${encodeURIComponent(dialog)}`);
}

/**
 * The settings page itself, everything that counts "Needs toner" / "Manual replenishment", and the
 * customer pages, whose Settings card shows the customer's override.
 */
function revalidate() {
  revalidatePath(PAGE);
  revalidatePath('/');
  revalidatePath('/orders');
  revalidatePath('/devices');
  revalidatePath('/customers', 'layout');
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
  const returnTo = customerReturn(formData);
  const id = await customerId(formData);
  if (id === null) fail('unknown_customer', dialog ?? 'customer', returnTo);

  try {
    // Customer settings reach colour and mono devices alike; mono devices ignore CMY.
    const patch = parseSettingsForm(formData, { allowInherit: true, isColour: true });
    await updateCustomerSettings(getDb(), { vantageCustomerId: id, patch, userId: user.userId });
  } catch (err) {
    if (err instanceof SettingsError) fail(err.code, dialog ?? `customer-${id}`, returnTo);
    throw err;
  }
  revalidate();
}

/** *Reset*: every field back to Inherit, which deletes the customer's row (audited like any edit). */
export async function resetCustomerAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = await customerId(formData);
  if (id === null) fail('unknown_customer', 'reset', customerReturn(formData));
  await updateCustomerSettings(getDb(), { vantageCustomerId: id, patch: RESET_ALL, userId: user.userId });
  revalidate();
}
