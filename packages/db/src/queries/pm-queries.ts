import { and, asc, desc, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { getAppState, setAppState } from '../app-state';
import {
  auditLog,
  cartridgeFamilies,
  cartridgeFamilyModels,
  deviceLinks,
  drmsEquipment,
  vantageCustomers,
  vantageEquipment,
  vantageEquipmentContracts,
  vantageWorkVisits,
} from '../schema';
import { loadCombinedMeters } from './meter-history';
import { clearPmActions, loadManualResets, loadOpenPmActions, resolvePmAction, type PmAction, type PmActionClearedReason } from './pm-actions';
import { computePm, groupVisits, DEFAULT_PM_SETTINGS, type PmResult, type PmSettings, type PmStatus, type VisitUnit } from './pm-due';
import { SettingsError } from './settings';
import { notHiddenDevice } from './shared';

const PM_SETTINGS_KEY = 'pm_settings';

/** "PM" as a word (not inside "Equipment"), or "service" / "maintenance" anywhere in the name. */
export const PM_CATEGORY_SUGGEST = /\bPM\b|service|maintenance/i;

/** Categories whose name looks like preventive maintenance (shared by the settings page and the unsaved default). */
export function suggestPmCategoryIds(categories: { id: number; name: string }[]): number[] {
  return categories.filter((c) => PM_CATEGORY_SUGGEST.test(c.name)).map((c) => c.id);
}

/**
 * Saved settings, or defaults. While no `pm_settings` row exists, `pmCategoryIds` defaults to the
 * suggested categories so real PM visits count; a saved row (even with `[]`) is used as-is.
 */
export async function getPmSettings(db: Db): Promise<PmSettings> {
  const stored = await getAppState<Partial<PmSettings>>(db, PM_SETTINGS_KEY);
  if (stored == null) {
    return { ...DEFAULT_PM_SETTINGS, pmCategoryIds: suggestPmCategoryIds(await listWorkCategories(db)) };
  }
  return { ...DEFAULT_PM_SETTINGS, ...stored };
}

/** True once the PM settings form has been saved (a saved row with no categories still counts). */
export async function hasSavedPmSettings(db: Db): Promise<boolean> {
  return (await getAppState<Partial<PmSettings>>(db, PM_SETTINGS_KEY)) != null;
}

const INT_KEYS = ['intervalPages', 'timeCapMonths', 'qualifyingMinutes', 'frequentCount', 'frequentWindowDays', 'holdDays', 'dueSoonDays'] as const;

export async function savePmSettings(db: Db, s: PmSettings, userId: number | null): Promise<void> {
  for (const k of INT_KEYS) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new SettingsError(`${k} must be a whole number of at least 1.`, 'invalid_pm_setting');
    }
  }
  if (typeof s.dueSoonPct !== 'number' || !(s.dueSoonPct >= 0.5 && s.dueSoonPct <= 1)) {
    throw new SettingsError('dueSoonPct must be between 0.5 and 1.', 'invalid_pm_setting');
  }
  if (!Array.isArray(s.pmCategoryIds) || s.pmCategoryIds.some((n) => !Number.isInteger(n))) {
    throw new SettingsError('pmCategoryIds must be a list of whole numbers.', 'invalid_pm_setting');
  }
  if (
    !Array.isArray(s.pmPartKeywords) ||
    s.pmPartKeywords.length > 30 ||
    s.pmPartKeywords.some((k) => typeof k !== 'string' || k.trim() === '' || k.length > 50)
  ) {
    throw new SettingsError('Part keywords must be at most 30 entries of 1 to 50 characters.', 'invalid_pm_setting');
  }
  const clean: PmSettings = {
    intervalPages: s.intervalPages,
    timeCapMonths: s.timeCapMonths,
    qualifyingMinutes: s.qualifyingMinutes,
    frequentCount: s.frequentCount,
    frequentWindowDays: s.frequentWindowDays,
    holdDays: s.holdDays,
    dueSoonPct: s.dueSoonPct,
    dueSoonDays: s.dueSoonDays,
    pmCategoryIds: [...new Set(s.pmCategoryIds)],
    pmPartKeywords: [...new Set(s.pmPartKeywords.map((k) => k.trim().toLowerCase()))],
  };
  await setAppState(db, PM_SETTINGS_KEY, clean);
  if (userId !== null) {
    await db.insert(auditLog).values({ userId, action: 'pm_settings.update', entity: 'pm_settings', entityIds: [], details: { settings: clean } });
  }
}

/** Distinct work categories seen in the visits table, with how many visits each has. */
export async function listWorkCategories(db: Db): Promise<{ id: number; name: string; type: string | null; visits: number }[]> {
  const v = vantageWorkVisits;
  const rows = await db
    .select({
      id: v.categoryId,
      name: sql<string | null>`max(${v.categoryName})`,
      type: sql<string | null>`max(${v.categoryType})`,
      visits: sql<number>`count(*)::int`,
    })
    .from(v)
    .where(sql`${v.categoryId} is not null`)
    .groupBy(v.categoryId)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({ id: r.id as number, name: r.name ?? `Category ${r.id}`, type: r.type, visits: r.visits }));
}

export async function setFamilyPmInterval(db: Db, familyId: number, pages: number | null): Promise<void> {
  if (pages !== null && (!Number.isInteger(pages) || pages < 1)) {
    throw new SettingsError('The PM interval must be a whole number of pages of at least 1.', 'invalid_pm_setting');
  }
  await db.update(cartridgeFamilies).set({ pmIntervalPages: pages, updatedAt: new Date() }).where(eq(cartridgeFamilies.id, familyId));
}

export interface PmRow {
  vantageEquipmentId: number;
  drmsEquipmentId: string | null;
  customerName: string | null;
  /** The customer's town (Vantage customer `Town`), or null. */
  town: string | null;
  serial: string | null;
  model: string | null;
  family: string | null;
  intervalPages: number;
  intervalSource: 'family' | 'global';
  result: PmResult;
  /** The open app-side action (booked or dismissed), or null. */
  action: PmAction | null;
  /** A booked action whose date (plus grace) has passed with no visit. */
  bookedOverdue: boolean;
  view: PmView;
}

export type PmView = 'due' | 'booked' | 'dismissed';

export interface PmFilter {
  status?: PmStatus[] | 'default';
  /** Defaults to `due` when `status` is `'default'`, otherwise no view filtering. `due` is the default view plus overdue bookings. */
  view?: PmView | 'all';
  customer?: string;
  family?: number;
  q?: string;
}

interface MachineRow {
  vantageEquipmentId: number;
  drmsEquipmentId: string | null;
  customerName: string | null;
  town: string | null;
  serial: string | null;
  model: string | null;
  familyId: number | null;
  family: string | null;
  familyInterval: number | null;
  installDate: Date | null;
}

/**
 * Vantage item nominal code for software/licence/support items (e.g. "PaperCut MF Premium Support").
 * Live check 2026-11-20 of vantage_equipment.raw Item: nominal 4000 metered 956 (machines), 4000 unmetered 6,
 * 4007 unmetered 1, 4013 unmetered 5, 4013 metered 7 (PaperCut MF Premium Support). A real machine has
 * Item.IsMetered = true and a NominalCode other than this, which drops 19 non-machines.
 */
export const SOFTWARE_NOMINAL_CODE = '4013';

/** Machines with an active contract that are not hidden, and are real machines (metered, not software); `ids` narrows to specific Vantage equipment. */
async function loadMachines(db: Db, ids: number[] | null): Promise<MachineRow[]> {
  const modelExpr = sql`coalesce(${drmsEquipment.modelName}, ${vantageEquipment.description})`;
  const rows = await db
    .select({
      vantageEquipmentId: vantageEquipment.vantageId,
      drmsEquipmentId: deviceLinks.drmsEquipmentId,
      customerName: vantageEquipment.customerName,
      town: sql<string | null>`nullif(btrim(${vantageCustomers.raw}->>'Town'), '')`,
      serial: sql<string | null>`coalesce(${vantageEquipment.serial}, ${drmsEquipment.serial})`,
      model: sql<string | null>`${modelExpr}`,
      familyId: cartridgeFamilies.id,
      family: cartridgeFamilies.name,
      familyInterval: cartridgeFamilies.pmIntervalPages,
      installDate: vantageEquipment.installDate,
    })
    .from(vantageEquipment)
    .leftJoin(vantageCustomers, eq(vantageCustomers.vantageId, vantageEquipment.vantageCustomerId))
    .leftJoin(deviceLinks, and(eq(deviceLinks.vantageEquipmentId, vantageEquipment.vantageId), isNull(deviceLinks.unlinkedAt)))
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, deviceLinks.drmsEquipmentId))
    .leftJoin(cartridgeFamilyModels, eq(cartridgeFamilyModels.model, modelExpr))
    .leftJoin(cartridgeFamilies, eq(cartridgeFamilies.id, cartridgeFamilyModels.familyId))
    .where(
      and(
        ids === null ? undefined : inArray(vantageEquipment.vantageId, ids),
        isNull(vantageEquipment.deletedDate),
        sql`(${vantageEquipment.raw}->'Item'->>'IsMetered') = 'true' and coalesce(${vantageEquipment.raw}->'Item'->>'NominalCode', '') <> ${SOFTWARE_NOMINAL_CODE}`,
        exists(
          db
            .select({ one: sql`1` })
            .from(vantageEquipmentContracts)
            .where(
              and(
                eq(vantageEquipmentContracts.vantageEquipmentId, vantageEquipment.vantageId),
                eq(vantageEquipmentContracts.isActive, true),
              ),
            ),
        ),
        sql`(${deviceLinks.drmsEquipmentId} is null or ${notHiddenDevice(deviceLinks.drmsEquipmentId)})`,
      ),
    )
    .orderBy(asc(vantageEquipment.vantageId));
  // A machine linked to two devices would repeat; keep the first.
  const seen = new Set<number>();
  return rows.filter((r) => {
    if (seen.has(r.vantageEquipmentId)) return false;
    seen.add(r.vantageEquipmentId);
    return true;
  });
}

/** Parts fitted on a work unit: its raw `WorkItems` with Status "Used" (case-insensitive). */
function usedParts(raw: unknown): VisitUnit['parts'] {
  const items = (raw as { WorkItems?: unknown } | null)?.WorkItems;
  if (!Array.isArray(items)) return [];
  const out: VisitUnit['parts'] = [];
  for (const it of items as Record<string, unknown>[]) {
    if (typeof it?.Status !== 'string' || it.Status.trim().toLowerCase() !== 'used') continue;
    const item = (it.Item ?? {}) as Record<string, unknown>;
    const description = typeof item.Description === 'string' ? item.Description.trim() : '';
    if (description === '') continue;
    out.push({
      partNumber: typeof item.PartNumber === 'string' ? item.PartNumber.trim() : null,
      description,
      quantity: typeof it.Quantity === 'number' ? it.Quantity : 1,
    });
  }
  return out;
}

async function loadVisits(db: Db, ids: number[]): Promise<Map<number, VisitUnit[]>> {
  const out = new Map<number, VisitUnit[]>();
  if (ids.length === 0) return out;
  const v = vantageWorkVisits;
  const rows = await db.select().from(v).where(inArray(v.vantageEquipmentId, ids));
  for (const r of rows) {
    if (r.vantageEquipmentId === null) continue;
    const list = out.get(r.vantageEquipmentId) ?? [];
    list.push({
      workUnitId: r.workUnitId,
      workId: r.workId,
      reference: r.workReference,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      categoryType: r.categoryType,
      start: r.workStart,
      end: r.workEnd,
      logged: r.loggedAt,
      hours: r.workHours,
      scheduled: r.scheduledStart,
      completed: r.completedAt,
      actionDetails: r.actionDetails,
      parts: usedParts(r.raw),
    });
    out.set(r.vantageEquipmentId, list);
  }
  return out;
}

async function buildRows(db: Db, machines: MachineRow[], s: PmSettings, now: Date): Promise<PmRow[]> {
  const ids = machines.map((m) => m.vantageEquipmentId);
  const [visits, meters, actions, resets] = await Promise.all([
    loadVisits(db, ids),
    loadCombinedMeters(db, ids, now),
    loadOpenPmActions(db, ids),
    loadManualResets(db, ids),
  ]);
  const clears: { id: number; reason: PmActionClearedReason }[] = [];
  const rows = machines.map((m) => {
    const intervalPages = m.familyInterval ?? s.intervalPages;
    const units = visits.get(m.vantageEquipmentId) ?? [];
    let action: PmAction | null = actions.get(m.vantageEquipmentId) ?? null;
    let state = action ? resolvePmAction(action, groupVisits(units, s, now), s, now).state : null;
    if (action && (state === 'visit_seen' || state === 'expired')) {
      clears.push({ id: action.id, reason: state });
      action = null;
      state = null;
    }
    const result = computePm({
      units,
      meter: meters.get(m.vantageEquipmentId) ?? [],
      intervalPages,
      s,
      now,
      installedAt: m.installDate,
      manualResetAt: resets.get(m.vantageEquipmentId) ?? null,
    });
    // A visit (or the install date) later than the service date makes the reset moot: close it.
    if (action && state === 'reset' && result.clockSource !== 'manual') {
      clears.push({ id: action.id, reason: 'visit_seen' });
      action = null;
      state = null;
    }
    const bookedOverdue = state === 'booked_overdue';
    let view: PmView = 'due';
    if (result.status === 'booked' || state === 'booked') view = 'booked';
    else if (state === 'snoozed') view = 'dismissed';
    else if (state === 'reset' && !inDefaultView({ result, intervalPages }, now)) view = 'dismissed';
    return {
      vantageEquipmentId: m.vantageEquipmentId,
      drmsEquipmentId: m.drmsEquipmentId,
      customerName: m.customerName,
      town: m.town,
      serial: m.serial,
      model: m.model,
      family: m.family,
      intervalPages,
      intervalSource: m.familyInterval !== null ? 'family' : 'global',
      result,
      action,
      bookedOverdue: view === 'due' && bookedOverdue,
      view,
    } satisfies PmRow;
  });
  if (clears.length > 0) {
    try {
      await clearPmActions(db, clears, now);
    } catch (e) {
      console.error('[pm] could not clear stale pm actions', e);
    }
  }
  return rows;
}

/** Overdue, due soon, and held machines that have in fact passed the page interval or the time cap. */
export function inDefaultView(r: Pick<PmRow, 'result' | 'intervalPages'>, now: Date): boolean {
  const { status, pagesSince, timeCapDate } = r.result;
  if (status === 'overdue' || status === 'due_soon') return true;
  if (status !== 'held') return false;
  return (pagesSince !== null && pagesSince >= r.intervalPages) || (timeCapDate !== null && now.getTime() >= timeCapDate.getTime());
}

/**
 * Whether a row belongs to a `/pm` tab: Due is a `due` row that needs PM (`inDefaultView`) or whose
 * booking passed with no visit; Booked and Dismissed follow the row's `view`; All takes everything.
 */
export function inPmView(r: PmRow, view: PmView | 'all', now: Date): boolean {
  if (view === 'all') return true;
  if (view === 'due') return r.view === 'due' && (r.bookedOverdue || inDefaultView(r, now));
  return r.view === view;
}

export async function listPmDue(db: Db, now: Date = new Date(), f: PmFilter = {}): Promise<PmRow[]> {
  const s = await getPmSettings(db);
  const machines = await loadMachines(db, null);
  let rows = await buildRows(db, machines, s, now);

  const view = f.view ?? (f.status === 'default' ? 'due' : 'all');
  rows = rows.filter((r) => inPmView(r, view, now));
  if (f.status === 'default') {
    if (view !== 'due') rows = rows.filter((r) => inDefaultView(r, now) || r.bookedOverdue);
  } else if (Array.isArray(f.status)) {
    const wanted = f.status;
    rows = rows.filter((r) => wanted.includes(r.result.status));
  }
  if (f.customer) {
    const c = f.customer.toLowerCase();
    rows = rows.filter((r) => (r.customerName ?? '').toLowerCase().includes(c));
  }
  if (f.family !== undefined) {
    const ok = new Set(machines.filter((m) => m.familyId === f.family).map((m) => m.vantageEquipmentId));
    rows = rows.filter((r) => ok.has(r.vantageEquipmentId));
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) => [r.customerName, r.town, r.serial, r.model, r.family].some((x) => (x ?? '').toLowerCase().includes(q)));
  }

  const rank = (r: PmRow) => (r.result.status === 'overdue' ? 0 : 1);
  return rows.sort(
    (a, b) => rank(a) - rank(b) || (b.result.pctUsed ?? -1) - (a.result.pctUsed ?? -1) || a.vantageEquipmentId - b.vantageEquipmentId,
  );
}

/** PM state for one machine (by Vantage equipment id); null when it has no active contract, is hidden, or is unknown. */
export async function getEquipmentPm(db: Db, vantageEquipmentId: number, now: Date = new Date()): Promise<PmRow | null> {
  const machines = await loadMachines(db, [vantageEquipmentId]);
  if (machines.length === 0) return null;
  return (await buildRows(db, machines, await getPmSettings(db), now))[0] ?? null;
}
