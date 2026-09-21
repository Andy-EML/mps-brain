'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { drmsEquipment } from '@mps/db';
import { SettingsError, updateDeviceSettings } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
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
