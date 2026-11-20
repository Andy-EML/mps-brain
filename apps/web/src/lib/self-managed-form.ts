/**
 * The *Self-managed stock* switch's form: `vantageCustomerId`, `on` (`'true'` / `'false'`) and an
 * optional `note`. Pure, so it is tested without a database; the action checks the customer exists.
 */

/** Longest note kept; the dialog's field stops here too. */
export const SELF_MANAGED_NOTE_MAX = 500;

export type SelfManagedResult = { ok: true; superseded: number } | { ok: false; error: string };

export type ParsedSelfManagedForm =
  | { ok: true; vantageCustomerId: number; on: boolean; note: string | null }
  | { ok: false; error: string };

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export function parseSelfManagedForm(formData: FormData): ParsedSelfManagedForm {
  const id = text(formData, 'vantageCustomerId');
  if (!/^\d{1,9}$/.test(id)) return { ok: false, error: 'That customer no longer exists. Refresh the page.' };
  const on = text(formData, 'on');
  if (on !== 'true' && on !== 'false') return { ok: false, error: 'Something went wrong. Refresh the page and try again.' };
  const note = text(formData, 'note');
  if (note.length > SELF_MANAGED_NOTE_MAX) {
    return { ok: false, error: `Keep the note to ${SELF_MANAGED_NOTE_MAX} characters.` };
  }
  return { ok: true, vantageCustomerId: Number(id), on: on === 'true', note: note === '' ? null : note };
}
