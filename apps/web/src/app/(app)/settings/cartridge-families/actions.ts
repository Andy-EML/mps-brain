'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { SiteStockError, deleteFamily, saveFamily } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseFamilyForm, parseFamilyId } from '@/lib/family-form';

/**
 * `/settings/cartridge-families`: add, edit and delete a cartridge family. Every action calls
 * `requireUser()` first — an action is a public POST endpoint — and takes the user id from the
 * session, never the form. The query functions validate again and write the audit row.
 *
 * A `SiteStockError` comes back as `?error=<code>&errorFor=<dialog>`: the page turns the code into
 * a sentence and shows it inside the dialog it came from (`add`, `family-<id>` or `delete-<id>`),
 * which stays open, or above the table when that dialog is gone.
 */

const PAGE = '/settings/cartridge-families';

function fail(code: string, dialog: string): never {
  redirect(`${PAGE}?error=${encodeURIComponent(code)}&errorFor=${encodeURIComponent(dialog)}`);
}

/** *Add family* and a row's *Edit*: the same form, with `id` for an edit. */
export async function saveFamilyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  let dialog = 'add';
  try {
    const args = parseFamilyForm(formData);
    if (args.id !== undefined) dialog = `family-${args.id}`;
    await saveFamily(getDb(), { ...args, userId: user.userId });
  } catch (err) {
    if (err instanceof SiteStockError) fail(err.code, dialog);
    throw err;
  }
  revalidatePath(PAGE);
}

/** A row's *Delete*, offered only for a family no shelf uses; `deleteFamily` checks again. */
export async function deleteFamilyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  let dialog = 'delete';
  try {
    const id = parseFamilyId(formData);
    if (id === undefined) throw new SiteStockError('That family no longer exists.', 'not_found');
    dialog = `delete-${id}`;
    await deleteFamily(getDb(), { id, userId: user.userId });
  } catch (err) {
    if (err instanceof SiteStockError) fail(err.code, dialog);
    throw err;
  }
  revalidatePath(PAGE);
}
