import { SettingsError, suggestPmCategoryIds, type PmSettings } from '@mps/db/queries';

// One definition of the suggestion rule lives in @mps/db (PM_CATEGORY_SUGGEST); re-exported for the page.
export { suggestPmCategoryIds };

/**
 * Turns the `/settings/pm` form into `PmSettings`. The page posts:
 *
 * - one field per whole-number setting, named as in `PmSettings` (`intervalPages`, `timeCapMonths`,
 *   `qualifyingMinutes`, `frequentCount`, `frequentWindowDays`, `holdDays`, `dueSoonDays`);
 *   thousands separators are allowed (`100,000`);
 * - `dueSoonPct` as a whole percentage, 50–100, stored as a fraction (85 → 0.85);
 * - one `pmCategory` per ticked work category (its id).
 *
 * Pure. Throws `SettingsError('invalid_pm_setting')`, the same code as `savePmSettings`, so the
 * action handles both alike; `savePmSettings` validates again.
 */

const WHOLE_KEYS = [
  'intervalPages',
  'timeCapMonths',
  'qualifyingMinutes',
  'frequentCount',
  'frequentWindowDays',
  'holdDays',
  'dueSoonDays',
] as const;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function bad(message: string): never {
  throw new SettingsError(message, 'invalid_pm_setting');
}

/** A whole number, 1 or more, written as digits (thousands separators allowed). */
function whole(raw: string, label: string): number {
  const digits = raw.replace(/[,\s]/g, '');
  if (!/^\d{1,9}$/.test(digits) || Number(digits) < 1) bad(`${label} must be a whole number of at least 1.`);
  return Number(digits);
}

export function parsePmSettingsForm(formData: FormData): PmSettings {
  const values = {} as Record<(typeof WHOLE_KEYS)[number], number>;
  for (const key of WHOLE_KEYS) values[key] = whole(text(formData, key), key);

  const pct = text(formData, 'dueSoonPct');
  if (!/^\d{1,3}$/.test(pct) || Number(pct) < 50 || Number(pct) > 100) {
    bad('The due-soon percentage must be a whole number from 50 to 100.');
  }

  const ids: number[] = [];
  for (const raw of formData.getAll('pmCategory')) {
    if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw.trim())) bad('That PM category no longer exists.');
    const id = Number(raw.trim());
    if (!ids.includes(id)) ids.push(id);
  }

  const keywords = [...new Set(text(formData, 'pmPartKeywords').split(',').map((k) => k.trim().toLowerCase()).filter((k) => k !== ''))];

  return { ...values, dueSoonPct: Number(pct) / 100, pmCategoryIds: ids, pmPartKeywords: keywords };
}
