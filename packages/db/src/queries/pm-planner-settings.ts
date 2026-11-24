import type { DealerRegion } from '@mps/core';
import type { Db } from '../client';
import { getAppState, setAppState } from '../app-state';
import { auditLog } from '../schema';
import { SettingsError } from './settings';

const KEY = 'pm_planner_settings';

export interface PmPatch {
  name: string;
  districts: string[];
}

export interface PlannerSettings {
  regionDealers: Record<DealerRegion, string | null>;
  nearMiles: number;
  doneRetentionDays: number;
  askedStaleDays: number;
  patches: PmPatch[];
}

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  regionDealers: { ireland: 'MJ Flood', scotland: 'CMYK' },
  nearMiles: 10,
  doneRetentionDays: 14,
  askedStaleDays: 7,
  patches: [],
};

const DISTRICT = /^[A-Z]{1,2}\d[A-Z\d]?$/;

/** Saved settings (missing keys filled from the defaults), or the defaults. */
export async function getPlannerSettings(db: Db): Promise<PlannerSettings> {
  const stored = await getAppState<Partial<PlannerSettings>>(db, KEY);
  if (stored == null) return { ...DEFAULT_PLANNER_SETTINGS, regionDealers: { ...DEFAULT_PLANNER_SETTINGS.regionDealers }, patches: [] };
  return {
    ...DEFAULT_PLANNER_SETTINGS,
    ...stored,
    regionDealers: { ...DEFAULT_PLANNER_SETTINGS.regionDealers, ...(stored.regionDealers ?? {}) },
    patches: Array.isArray(stored.patches) ? stored.patches : [],
  };
}

function bad(message: string): never {
  throw new SettingsError(message, 'invalid_planner_setting');
}

function wholeBetween(label: string, v: unknown, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) bad(`${label} must be a whole number from ${lo} to ${hi}.`);
  return v;
}

function dealerName(label: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') bad(`${label} must be text.`);
  const t = v.trim();
  if (t.length > 60) bad(`${label} must be at most 60 characters.`);
  return t === '' ? null : t;
}

/** Validates, trims and saves the planner settings; writes an audit row when a user is known. */
export async function savePlannerSettings(db: Db, s: PlannerSettings, userId: number | null): Promise<void> {
  const nearMiles = wholeBetween('Near distance (miles)', s.nearMiles, 1, 100);
  const doneRetentionDays = wholeBetween('Done retention (days)', s.doneRetentionDays, 1, 90);
  const askedStaleDays = wholeBetween('Asked-engineer warning (days)', s.askedStaleDays, 1, 60);
  const regionDealers: Record<DealerRegion, string | null> = {
    ireland: dealerName('Ireland dealer', s.regionDealers?.ireland),
    scotland: dealerName('Scotland dealer', s.regionDealers?.scotland),
  };
  if (!Array.isArray(s.patches)) bad('Patches must be a list.');
  const names = new Set<string>();
  const seenDistricts = new Map<string, string>();
  const patches: PmPatch[] = s.patches.map((p) => {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (name === '') bad('Every patch needs a name.');
    if (name.length > 40) bad(`Patch name "${name}" is over 40 characters.`);
    if (names.has(name.toLowerCase())) bad(`Patch name "${name}" is used twice.`);
    names.add(name.toLowerCase());
    if (!Array.isArray(p.districts)) bad(`Patch "${name}" needs a list of districts.`);
    const districts: string[] = [];
    for (const raw of p.districts) {
      const d = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
      if (!DISTRICT.test(d)) bad(`"${String(raw)}" in patch "${name}" is not a postcode district such as GU14.`);
      const other = seenDistricts.get(d);
      if (other !== undefined && other !== name) bad(`District ${d} is in both "${other}" and "${name}".`);
      seenDistricts.set(d, name);
      if (!districts.includes(d)) districts.push(d);
    }
    return { name, districts };
  });
  const clean: PlannerSettings = { regionDealers, nearMiles, doneRetentionDays, askedStaleDays, patches };
  await setAppState(db, KEY, clean);
  if (userId !== null) {
    await db.insert(auditLog).values({ userId, action: 'pm_planner_settings.update', entity: 'pm_planner_settings', entityIds: [], details: { settings: clean } });
  }
}
