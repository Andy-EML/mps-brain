'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { SettingsError, getPlannerSettings, savePlannerSettings, savePmSettings } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parsePlannerSettingsForm, plannerSettingsToValues } from '@/lib/planner-settings-form';
import { plannerFormValues, type PlannerFormState } from '@/lib/planner-settings-state';
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

/**
 * The *Planner and other dealers* card (a client form with `useActionState`): region dealer names,
 * the "near" distance, Done retention, the asked-engineer warning and the patches. `requireUser()`
 * first; the user id comes from the session. Returns a state instead of redirecting, so a refusal
 * keeps what was typed (the multi-line patches especially) and shows the specific sentence. Only
 * our own `SettingsError` messages (the parser's and `savePlannerSettings`') are shown; anything
 * else is logged and answered generically. `savePlannerSettings` validates again and audits.
 */
export async function savePlannerSettingsAction(_prev: PlannerFormState, formData: FormData): Promise<PlannerFormState> {
  const user = await requireUser();
  const values = plannerFormValues(formData);
  const db = getDb();
  try {
    await savePlannerSettings(db, parsePlannerSettingsForm(formData), user.userId);
  } catch (err) {
    if (err instanceof SettingsError) return { status: 'error', error: err.message, values };
    console.error('savePlannerSettingsAction failed', err);
    return { status: 'error', error: 'The planner settings were not saved. Refresh the page and try again.', values };
  }
  revalidatePath(PAGE);
  // Region dealer names change who is "other dealer": PM due, the planner and the Customers badges.
  revalidatePath('/pm');
  revalidatePath('/pm/planner');
  revalidatePath('/customers');
  revalidatePath('/customers/[id]', 'page');
  return { status: 'saved', values: plannerSettingsToValues(await getPlannerSettings(db)) };
}
