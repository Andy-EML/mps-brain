import { REPLENISH_COLOURS, type ReplenishColour } from '@mps/core';
import { SiteStockError, type SaveFamilyArgs, type SiteStockErrorCode } from '@mps/db/queries';
import { familyCarries, parseModels } from './family-fields';

/**
 * Turns the cartridge-family dialog's form into `saveFamily` arguments (all but `userId`, which
 * the action takes from the session). The dialog posts:
 *
 * - `id` (absent for a new family), `name`, `kind` = `colour` | `mono`, `notes`;
 * - one `model` per chip, plus `modelsText` — whatever is still typed in the box, which may be a
 *   pasted list (comma, semicolon or newline separated);
 * - `yield-<consumable>` for each consumable: blank for "not known", otherwise whole pages.
 *
 * Pure. Throws `SiteStockError` with the queries' own codes, so the action handles both alike;
 * `saveFamily` validates again.
 */

/** Blank is "not known"; otherwise a whole number of pages, 1 or more, written as plain digits. */
export function parseYield(raw: string): number | null {
  const text = raw.trim().replace(/[,\s]/g, '');
  if (text === '') return null;
  if (!/^\d{1,9}$/.test(text) || Number(text) < 1) {
    throw new SiteStockError('A rated yield is a whole number of pages, 1 or more.', 'bad_value');
  }
  return Number(text);
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** The posted `id`: undefined for a new family; a stale or crafted one is `not_found`. */
export function parseFamilyId(formData: FormData): number | undefined {
  const raw = text(formData, 'id');
  if (raw === '') return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw new SiteStockError('That family no longer exists.', 'not_found');
  return Number(raw);
}

export function parseFamilyForm(formData: FormData): Omit<SaveFamilyArgs, 'userId' | 'now'> {
  const isColour = text(formData, 'kind') !== 'mono';
  const chips = formData.getAll('model').filter((v): v is string => typeof v === 'string');
  const models = parseModels([...chips, text(formData, 'modelsText')].join('\n'));

  const ratedYield: Partial<Record<ReplenishColour, number | null>> = {};
  for (const c of REPLENISH_COLOURS) {
    // A mono family's cyan/magenta/yellow are cleared whatever the form says.
    ratedYield[c] = familyCarries(isColour, c) ? parseYield(text(formData, `yield-${c}`)) : null;
  }

  const id = parseFamilyId(formData);
  return { ...(id === undefined ? {} : { id }), name: text(formData, 'name'), isColour, models, ratedYield, notes: text(formData, 'notes') };
}

const FAMILY_ERRORS: Record<SiteStockErrorCode, string> = {
  not_found: 'That family no longer exists. Refresh the page and try again.',
  bad_value: 'Check the form: a family needs a name, and a rated yield is a whole number of pages, 1 or more.',
  duplicate: 'Another family already has that name, or one of those models already belongs to another family.',
  in_use: 'Shelves still use this family. Delete them first; to make it mono, set their cyan, magenta and yellow to 0 first.',
  empty: 'Nothing was changed.',
};

/** `?error=<code>` as a sentence; looked up, so a crafted link cannot put text on the page. */
export function familyErrorMessage(code: string): string {
  return (FAMILY_ERRORS as Record<string, string>)[code] ?? 'The family was not saved. Refresh the page and try again.';
}
