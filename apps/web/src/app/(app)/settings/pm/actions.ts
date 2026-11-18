'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { SettingsError, savePmSettings } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parsePmSettingsForm } from '@/lib/pm-settings-form';

/**
 * `/settings/pm`: the global preventive-maintenance settings. The action calls `requireUser()`
 * first — an action is a public POST endpoint — and takes the user id from the session, never the
 * form. Any signed-in user may change settings. `savePmSettings` validates again and writes the
 * audit row.
 *
 * A `SettingsError` comes back as `?settingsError=<code>`; the page turns the code into a sentence.
 * A save lands on `?saved=1`, which also drops an earlier error from the URL.
 */

const PAGE = '/settings/pm';

export async function savePmSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await savePmSettings(getDb(), parsePmSettingsForm(formData), user.userId);
  } catch (err) {
    if (err instanceof SettingsError) redirect(`${PAGE}?settingsError=${encodeURIComponent(err.code)}`);
    throw err;
  }
  revalidatePath(PAGE);
  revalidatePath('/pm');
  redirect(`${PAGE}?saved=1`);
}
