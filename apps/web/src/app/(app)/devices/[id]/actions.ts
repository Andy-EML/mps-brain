'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { drmsEquipment } from '@mps/db';
import { HideError, hideDevices, SettingsError, unhideDevices, updateDeviceSettings } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { hrefWith } from '@/lib/href';
import { parseSettingsForm } from '@/lib/settings-form';

/**
 * The device page's Edit dialog: device-level replenishment settings, including reset to
 * inherited. `requireUser()` comes first — an action is a public POST endpoint — and the user id
 * comes from the session, never the form. Any signed-in user may change settings.
 *
 * Whether the device is colour is read from `drms_equipment`, not the form, so a mono device
 * cannot be given cyan/magenta/yellow overrides by a crafted post. A `SettingsError` comes back as
 * `?settingsError=<code>`, which the page turns into a sentence.
 */
export async function updateDeviceSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const drmsId = String(formData.get('drmsId') ?? '');

  const db = getDb();
  const [device] = drmsId
    ? await db.select({ isColour: drmsEquipment.isColour }).from(drmsEquipment).where(eq(drmsEquipment.drmsId, drmsId))
    : [];
  if (!device) redirect('/devices');

  const page = `/devices/${encodeURIComponent(drmsId)}`;
  try {
    const patch = parseSettingsForm(formData, { allowInherit: true, isColour: device.isColour });
    await updateDeviceSettings(db, { drmsIds: [drmsId], patch, userId: user.userId });
  } catch (err) {
    if (err instanceof SettingsError) redirect(`${page}?settingsError=${err.code}`);
    throw err;
  }

  // The card itself, and everything that counts "Needs toner" / "Manual replenishment".
  revalidatePath(page);
  revalidatePath('/orders');
  revalidatePath('/');
  revalidatePath('/devices');
}

/**
 * *Hide* on the device page, with the dialog's optional reason. `hideDevices` withdraws the
 * device's pending proposals and clears its open alerts; nothing is sent to DRMS. Back to the
 * device page, which now carries the hidden banner, or `?hideError=<code>`.
 */
export async function hideDeviceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const drmsId = String(formData.get('drmsId') ?? '');
  if (!drmsId) redirect('/devices');
  const page = devicePage(drmsId, formData);
  try {
    await hideDevices(getDb(), { drmsIds: [drmsId], userId: user.userId, reason: String(formData.get('reason') ?? '') });
  } catch (err) {
    if (err instanceof HideError) redirect(hrefWith(page.path, { ...page.params, hideError: err.code }));
    throw err;
  }
  // Every list and count that leaves hidden devices out, and the sidebar badges in the layout.
  revalidatePath('/', 'layout');
  redirect(hrefWith(page.path, page.params));
}

/** *Unhide* on the hidden banner. The next evaluate and alerts runs treat the device as normal again. */
export async function unhideDeviceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const drmsId = String(formData.get('drmsId') ?? '');
  if (!drmsId) redirect('/devices');
  const page = devicePage(drmsId, formData);
  try {
    await unhideDevices(getDb(), { drmsIds: [drmsId], userId: user.userId });
  } catch (err) {
    if (err instanceof HideError) redirect(hrefWith(page.path, { ...page.params, hideError: err.code }));
    throw err;
  }
  revalidatePath('/', 'layout');
  redirect(hrefWith(page.path, page.params));
}

/**
 * The device page's own URL, keeping `from` / `back` so its breadcrumb and Back link survive the
 * round trip. The page re-validates both (`resolveDeviceOrigin`), so a crafted value is harmless.
 */
function devicePage(drmsId: string, formData: FormData): { path: string; params: Record<string, string | undefined> } {
  const value = (name: string) => {
    const v = formData.get(name);
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  return { path: `/devices/${encodeURIComponent(drmsId)}`, params: { from: value('from'), back: value('back') } };
}
