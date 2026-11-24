import { SettingsError, type PlannerSettings, type PmPatch } from '@mps/db/queries';
import type { PlannerFormValues } from './planner-settings-state';

/**
 * The *Planner and other dealers* card on `/settings/pm`. It posts `irelandDealer`,
 * `scotlandDealer`, `nearMiles`, `doneRetentionDays`, `askedStaleDays` and `patches` (one patch per
 * line, `Name: GU14, GU11`). Pure; throws `SettingsError('invalid_planner_setting')`, the code
 * `savePlannerSettings` uses, so the action handles both alike. `savePlannerSettings` checks the
 * ranges, lengths and duplicate districts again — this only turns strings into values.
 */

const DISTRICT = /^[A-Z]{1,2}\d[A-Z\d]?$/;

function bad(message: string): never {
  throw new SettingsError(message, 'invalid_planner_setting');
}

function text(fd: FormData, name: string): string {
  const value = fd.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Digits only (`10`); anything else (`ten`, `2.5`, `1e1`, `-3`, blank) is refused. */
function whole(fd: FormData, name: string, label: string): number {
  const raw = text(fd, name);
  if (!/^\d{1,4}$/.test(raw)) bad(`${label} must be a whole number.`);
  return Number(raw);
}

/**
 * `Farnborough patch: GU14, gu11 ,GU51` lines → patches; blank lines and empty items (a trailing
 * or doubled comma) are skipped, districts trimmed and uppercased.
 */
export function parsePatches(input: string): PmPatch[] {
  const patches: PmPatch[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) bad('Write each patch as “Name: GU14, GU11”.');
    const name = line.slice(0, colon).trim();
    if (name === '') bad('Every patch needs a name before the colon.');
    const districts = line
      .slice(colon + 1)
      .split(',')
      .map((d) => d.trim().toUpperCase())
      .filter((d) => d !== '');
    if (districts.length === 0) bad(`Patch “${name}” has no districts.`);
    for (const d of districts) if (!DISTRICT.test(d)) bad(`Patch “${name}” has a district that is not like GU14.`);
    patches.push({ name, districts });
  }
  return patches;
}

/** The inverse of `parsePatches`: one `Name: GU14, GU11` line per patch. */
export function formatPatches(p: PmPatch[]): string {
  return p.map((x) => `${x.name}: ${x.districts.join(', ')}`).join('\n');
}

export function parsePlannerSettingsForm(fd: FormData): PlannerSettings {
  const dealer = (name: string): string | null => text(fd, name) || null;
  return {
    regionDealers: { ireland: dealer('irelandDealer'), scotland: dealer('scotlandDealer') },
    nearMiles: whole(fd, 'nearMiles', 'Near distance'),
    doneRetentionDays: whole(fd, 'doneRetentionDays', 'Done retention'),
    askedStaleDays: whole(fd, 'askedStaleDays', 'Asked-engineer warning'),
    patches: parsePatches(text(fd, 'patches')),
  };
}

/** Stored settings as the card's fields show them (blank dealer for none, patches one per line). */
export function plannerSettingsToValues(s: PlannerSettings): PlannerFormValues {
  return {
    irelandDealer: s.regionDealers.ireland ?? '',
    scotlandDealer: s.regionDealers.scotland ?? '',
    nearMiles: String(s.nearMiles),
    doneRetentionDays: String(s.doneRetentionDays),
    askedStaleDays: String(s.askedStaleDays),
    patches: formatPatches(s.patches),
  };
}
