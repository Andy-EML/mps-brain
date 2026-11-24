import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { getNumber, postcodeOutward } from '@mps/core';
import type { Db } from '../client';
import { postcodeDistricts, vantageCustomers, vantageEngineers, vantageEquipment, vantageScheduledUnits } from '../schema';
import { BOOKED_GRACE_DAYS, BOOKED_NO_DATE_DAYS } from './pm-actions';
import { londonDay, overdueMonths, type PmStatus } from './pm-due';
import { dropExpiredDone, loadPlanRows, markDoneByVisit, markLapsed, resetStaleDone, type PmPlanRow } from './pm-plan';
import { getPlannerSettings, type PlannerSettings, type PmPatch } from './pm-planner-settings';
import { inPmView, listPmDue, type PmRow, type PmView } from './pm-queries';

/**
 * Planner read model: the board (the working set the office picked), the county -> patch ->
 * district grouping, and each engineer's booked calls for today/tomorrow with nearby PMs. Reads our
 * own database only; the one write is the board sync on `loadBoard`, which only touches
 * `pm_plan`. Nothing here talks to Vantage or DRMS.
 */

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNKNOWN_COUNTY = 'Unknown county';
/** A lapsed booking shows its "not seen" reason for this long after it expired. */
const LAPSED_REASON_DAYS = 14;

export type BoardColumn = 'to_plan' | 'asked' | 'booked' | 'done';
export type LeftDueReason = 'dismissed' | 'other_dealer' | 'left_contract' | 'not_due';

export interface BoardCard {
  vantageEquipmentId: number;
  customerId: number | null;
  customerName: string | null;
  town: string | null;
  serial: string | null;
  model: string | null;
  drmsEquipmentId: string | null;
  district: string | null;
  county: string | null;
  status: PmStatus | null;
  /** Whole months overdue; 0 when overdue with no date to count from; null when not overdue. */
  overdueMonths: number | null;
  whenInArea: boolean;
  priority: boolean;
  column: BoardColumn;
  /** Why the card is where it is ("Booked for 25 Nov (ref W-123)", "Booked visit not seen", "Visit seen 21 Nov"). */
  reason: string | null;
  note: string | null;
  askedDays: number | null;
  askedStale: boolean;
  /** Set when the machine is no longer in the due set; the card keeps its column. */
  leftDue: LeftDueReason | null;
}

/** "25 Nov" for the Europe/London calendar day of `d`. */
function fmtDay(d: Date): string {
  const [, m, day] = londonDay(d).split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]}`;
}

/** When an open booked action stops counting as booked (its date, or created + 30 days, plus the grace). */
export function bookedExpiry(a: { bookedFor: Date | null; createdAt: Date }): number {
  const base = a.bookedFor ? a.bookedFor.getTime() : a.createdAt.getTime() + BOOKED_NO_DATE_DAYS * DAY_MS;
  return base + BOOKED_GRACE_DAYS * DAY_MS;
}

/**
 * Which column a card is in. Booked is derived (an open booked action that has not lapsed, or a
 * Vantage PM job); Done stays Done; a booking that lapsed (no visit seen) within the last 14 days
 * returns the card to To plan with a reason; otherwise the stored column. A To plan card that still
 * carries `doneAt` was brought back from Done by the sync (a Priority machine due again) and says
 * "Due again". `row` is null when the machine has left the PM list (contract ended).
 */
export function boardColumnOf(plan: PmPlanRow, row: PmRow | null, now: Date): { column: BoardColumn; reason: string | null } {
  if (plan.boardColumn === 'done') {
    if (plan.doneReason === 'visit') {
      const at = row?.result.lastQualifying?.at ?? plan.doneAt;
      return { column: 'done', reason: at ? `Visit seen ${fmtDay(at)}` : 'Visit seen' };
    }
    return { column: 'done', reason: null };
  }
  const a = row?.action ?? null;
  const manualBooked = a !== null && a.kind === 'booked';
  if (manualBooked && !row!.bookedOverdue) {
    const when = a.bookedFor ? ` for ${fmtDay(a.bookedFor)}` : '';
    const ref = a.reference ? ` (ref ${a.reference})` : '';
    return { column: 'booked', reason: `Booked${when}${ref}` };
  }
  if (row && row.result.status === 'booked') {
    const when = row.result.bookedFor ? ` for ${fmtDay(row.result.bookedFor)}` : '';
    return { column: 'booked', reason: `Booked: PM job in Vantage${when}` };
  }
  if (manualBooked) {
    const since = now.getTime() - bookedExpiry(a);
    // The lapse is persisted by `markLapsed` with updated_at = the expiry; a card touched after that
    // (any move) has a later updated_at, so it keeps its stored column. Not yet synced, it reads the same.
    if (plan.updatedAt.getTime() <= bookedExpiry(a)) {
      return { column: 'to_plan', reason: since >= 0 && since <= LAPSED_REASON_DAYS * DAY_MS ? 'Booked visit not seen' : null };
    }
    return { column: plan.boardColumn ?? 'to_plan', reason: null };
  }
  const column = plan.boardColumn ?? 'to_plan';
  return { column, reason: column === 'to_plan' && plan.doneAt !== null ? 'Due again' : null };
}

/** Months overdue: 0 when overdue with no date to count from, null when not overdue. */
function overdueOf(r: PmRow, now: Date): number | null {
  return r.result.status === 'overdue' ? (overdueMonths(r, now) ?? 0) : null;
}

/** Whole days since the card was moved to Asked; null when it is not (or has no date). */
export function askedDaysOf(plan: PmPlanRow, now: Date): number | null {
  if (plan.boardColumn !== 'asked' || plan.askedAt === null) return null;
  return Math.max(0, Math.floor((now.getTime() - plan.askedAt.getTime()) / DAY_MS));
}

export interface AreaGroup<T> {
  county: string;
  patches: { name: string | null; districts: { district: string | null; cards: T[] }[] }[];
  due: number;
  overdue: number;
  priority: number;
}

type Groupable = { district: string | null; county: string | null; priority: boolean; overdueMonths: number | null };

const byDistrict = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b));

function orderInDistrict<T extends Groupable>(a: T, b: T): number {
  return Number(b.priority) - Number(a.priority) || (b.overdueMonths ?? -1) - (a.overdueMonths ?? -1);
}

/**
 * County -> patch -> district. A patch lives inside a county: one spanning two counties shows under
 * each with only that county's districts. Districts outside any patch fall in the unnamed patch,
 * listed after the named ones; cards with no postcode form the last district. The unknown county is
 * listed last. Within a district: priority first, then the most overdue.
 */
export function groupCardsByArea<T extends Groupable>(cards: T[], patches: PmPatch[]): AreaGroup<T>[] {
  const byCounty = new Map<string, T[]>();
  for (const c of cards) {
    const k = c.county ?? UNKNOWN_COUNTY;
    byCounty.set(k, [...(byCounty.get(k) ?? []), c]);
  }
  const counties = [...byCounty.keys()].sort((a, b) => (a === UNKNOWN_COUNTY ? 1 : b === UNKNOWN_COUNTY ? -1 : a.localeCompare(b)));
  return counties.map((county) => {
    const inCounty = byCounty.get(county)!;
    const districtCards = new Map<string | null, T[]>();
    for (const c of inCounty) districtCards.set(c.district, [...(districtCards.get(c.district) ?? []), c]);
    const build = (names: (string | null)[]) =>
      names
        .sort(byDistrict)
        .map((district) => ({ district, cards: [...districtCards.get(district)!].sort(orderInDistrict) }));
    const claimed = new Set<string | null>();
    const out: AreaGroup<T>['patches'] = [];
    for (const p of patches) {
      const names = p.districts.filter((x) => districtCards.has(x));
      if (names.length === 0) continue;
      names.forEach((n) => claimed.add(n));
      out.push({ name: p.name, districts: build(names) });
    }
    const rest = [...districtCards.keys()].filter((k) => !claimed.has(k));
    if (rest.length > 0) out.push({ name: null, districts: build(rest) });
    return {
      county,
      patches: out,
      due: inCounty.length,
      overdue: inCounty.filter((c) => c.overdueMonths !== null).length,
      priority: inCounty.filter((c) => c.priority).length,
    };
  });
}

interface DistrictInfo {
  county: string | null;
  at: { lat: number; lng: number } | null;
}

/** The postcodes.io cache by district (found districts only). */
async function loadDistrictCache(db: Db): Promise<Map<string, DistrictInfo>> {
  const rows = await db.select().from(postcodeDistricts);
  const out = new Map<string, DistrictInfo>();
  for (const r of rows) {
    if (r.status !== 'ok') continue;
    out.set(r.district, { county: r.county, at: r.latitude !== null && r.longitude !== null ? { lat: r.latitude, lng: r.longitude } : null });
  }
  return out;
}

interface CustomerInfo {
  name: string | null;
  town: string | null;
  district: string | null;
  county: string | null;
  at: { lat: number; lng: number } | null;
}

const text = (v: string | null): string | null => (v === null || v.trim() === '' ? null : v.trim());

/** Customer area fields and coordinates (Latitude/Longitude as numbers or numeric strings; 0,0 means unset). */
async function loadCustomers(db: Db, ids: number[]): Promise<Map<number, CustomerInfo>> {
  const out = new Map<number, CustomerInfo>();
  const want = [...new Set(ids)];
  if (want.length === 0) return out;
  const rows = await db.select({ id: vantageCustomers.vantageId, name: vantageCustomers.name, raw: vantageCustomers.raw }).from(vantageCustomers).where(inArray(vantageCustomers.vantageId, want));
  for (const r of rows) {
    const lat = getNumber(r.raw, 'Latitude');
    const lng = getNumber(r.raw, 'Longitude');
    const raw = r.raw as Record<string, unknown> | null;
    const str = (k: string) => {
      const key = Object.keys(raw ?? {}).find((x) => x.toLowerCase() === k);
      const v = key === undefined ? null : (raw as Record<string, unknown>)[key];
      return v == null ? null : String(v);
    };
    out.set(r.id, {
      name: r.name,
      town: text(str('town')),
      district: postcodeOutward(str('postcode')),
      county: text(str('county')),
      at: lat !== null && lng !== null && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null,
    });
  }
  return out;
}

const SYNC_FAILED = '[pm-planner] could not save the board sync';

/** The PM list the planner reads (every view and dealer); the page loads it once and passes it to both loaders. */
export function listPlannerRows(db: Db, now: Date): Promise<PmRow[]> {
  return listPmDue(db, now, { view: 'all', dealer: 'all' });
}

/**
 * The board: every machine the office added (plus Priority machines, added when starred), in the
 * column it is in now. Runs the board sync first (own-DB writes only; a failure is logged and the
 * board still loads from the derived state). A Done card stays in Done for the retention period
 * whatever the machine's due status; after it the card drops off the board, except a Priority
 * machine that is due again, which goes back on To plan ("Due again"). A card whose machine left
 * the due set stays with `leftDue` set. `pmRows` is `listPlannerRows` when the caller already has it.
 */
export async function loadBoard(db: Db, now: Date = new Date(), pmRows?: PmRow[]): Promise<{ cards: BoardCard[]; settings: PlannerSettings }> {
  const settings = await getPlannerSettings(db);
  const [rows, planMap, cache] = await Promise.all([pmRows ?? listPlannerRows(db, now), loadPlanRows(db), loadDistrictCache(db)]);
  const rowById = new Map(rows.map((r) => [r.vantageEquipmentId, r]));
  const plans = new Map([...planMap].filter(([, p]) => p.boardColumn !== null));

  // Sync: a qualifying visit after the card was added -> done; a done card past the retention ->
  // off the board, or (a Priority machine due again) back on To plan.
  const doneCutoff = new Date(now.getTime() - settings.doneRetentionDays * DAY_MS);
  const visitDone: number[] = [];
  const reset: number[] = [];
  const dropped: number[] = [];
  for (const [id, p] of plans) {
    const row = rowById.get(id) ?? null;
    if (p.boardColumn === 'to_plan' || p.boardColumn === 'asked') {
      const at = row?.result.lastQualifying?.at;
      if (at && at.getTime() > (p.addedAt ?? p.updatedAt).getTime()) visitDone.push(id);
    } else if (p.boardColumn === 'done' && p.doneAt && p.doneAt.getTime() < doneCutoff.getTime()) {
      if (!p.priority) dropped.push(id);
      else if (row && inPmView(row, 'due', now)) reset.push(id);
    }
  }
  const lapsed: { id: number; expiry: Date }[] = [];
  for (const [id, p] of plans) {
    const a = rowById.get(id)?.action;
    if (!a || a.kind !== 'booked' || !rowById.get(id)!.bookedOverdue || visitDone.includes(id)) continue;
    if ((p.boardColumn !== 'to_plan' && p.boardColumn !== 'asked') || rowById.get(id)!.result.status === 'booked') continue;
    const expiry = new Date(bookedExpiry(a));
    if (expiry.getTime() <= now.getTime() && p.updatedAt.getTime() < expiry.getTime()) lapsed.push({ id, expiry });
  }
  for (const { id, expiry } of lapsed) plans.set(id, { ...plans.get(id)!, boardColumn: 'to_plan', askedAt: null, updatedAt: expiry });
  for (const id of visitDone) plans.set(id, { ...plans.get(id)!, boardColumn: 'done', doneAt: now, doneReason: 'visit' });
  // A reset card keeps doneAt: it is the "Due again" marker.
  for (const id of reset) plans.set(id, { ...plans.get(id)!, boardColumn: 'to_plan', addedAt: now, askedAt: null, updatedAt: now });
  for (const id of dropped) plans.delete(id);
  if (visitDone.length > 0) await markDoneByVisit(db, visitDone, now).catch((e) => console.error(SYNC_FAILED, e));
  if (lapsed.length > 0) await markLapsed(db, lapsed, now).catch((e) => console.error(SYNC_FAILED, e));
  if (reset.length > 0) await resetStaleDone(db, reset, doneCutoff, now).catch((e) => console.error(SYNC_FAILED, e));
  if (dropped.length > 0) await dropExpiredDone(db, dropped, doneCutoff, now).catch((e) => console.error(SYNC_FAILED, e));

  // Machines that left the PM list (contract ended): keep the card, read what we can from Vantage.
  const gone = [...plans.keys()].filter((id) => !rowById.has(id));
  const goneInfo = new Map<number, { serial: string | null; model: string | null; customerId: number | null; customerName: string | null }>();
  let goneCustomers = new Map<number, CustomerInfo>();
  if (gone.length > 0) {
    const equipRows = await db
      .select({ id: vantageEquipment.vantageId, serial: vantageEquipment.serial, description: vantageEquipment.description, customerId: vantageEquipment.vantageCustomerId, customerName: vantageEquipment.customerName })
      .from(vantageEquipment)
      .where(inArray(vantageEquipment.vantageId, gone));
    for (const e of equipRows) goneInfo.set(e.id, { serial: e.serial, model: e.description, customerId: e.customerId, customerName: e.customerName });
    goneCustomers = await loadCustomers(db, equipRows.flatMap((e) => (e.customerId === null ? [] : [e.customerId])));
  }

  const cards: BoardCard[] = [];
  for (const [id, p] of plans) {
    // A Priority card past the retention that is not due again waits here, off screen, until it is.
    if (p.boardColumn === 'done' && p.doneAt && p.doneAt.getTime() < doneCutoff.getTime()) continue;
    const row = rowById.get(id) ?? null;
    const { column, reason } = boardColumnOf(p, row, now);
    const askedDays = column === 'asked' ? askedDaysOf(p, now) : null;
    const base = { vantageEquipmentId: id, whenInArea: p.whenInArea, priority: p.priority, column, reason, note: p.boardNote, askedDays, askedStale: askedDays !== null && askedDays > settings.askedStaleDays };
    if (row) {
      cards.push({
        ...base,
        customerId: row.customerId,
        customerName: row.customerName,
        town: row.town,
        serial: row.serial,
        model: row.model,
        drmsEquipmentId: row.drmsEquipmentId,
        district: row.district,
        county: (row.district ? cache.get(row.district)?.county : null) ?? row.county,
        status: row.result.status,
        overdueMonths: overdueOf(row, now),
        leftDue:
          row.view === 'dismissed'
            ? 'dismissed'
            : row.otherDealer.dealer !== null
              ? 'other_dealer'
              : column !== 'done' && column !== 'booked' && !inPmView(row, 'due', now)
                ? 'not_due'
                : null,
      });
    } else {
      const info = goneInfo.get(id);
      const c = info?.customerId != null ? goneCustomers.get(info.customerId) : undefined;
      const district = c?.district ?? null;
      cards.push({
        ...base,
        customerId: info?.customerId ?? null,
        customerName: c?.name ?? info?.customerName ?? null,
        town: c?.town ?? null,
        serial: info?.serial ?? null,
        model: info?.model ?? null,
        drmsEquipmentId: null,
        district,
        county: (district ? cache.get(district)?.county : null) ?? c?.county ?? null,
        status: null,
        overdueMonths: null,
        leftDue: 'left_contract',
      });
    }
  }
  cards.sort((a, b) => Number(b.priority) - Number(a.priority) || (b.overdueMonths ?? -1) - (a.overdueMonths ?? -1) || a.vantageEquipmentId - b.vantageEquipmentId);
  return { cards, settings };
}

// ---- Upcoming jobs ----------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export interface PmSuggestion {
  vantageEquipmentId: number;
  customerName: string | null;
  serial: string | null;
  model: string | null;
  status: PmStatus;
  overdueMonths: number | null;
  priority: boolean;
  whenInArea: boolean;
  distanceMiles: number | null;
  sameDistrict: boolean;
  sameSite: boolean;
  boardColumn: BoardColumn | null;
}

/** A due machine that could be added to a call. `view`/`dealer` let `suggestNear` drop booked, dismissed and other-dealer ones. */
export interface SuggestionCandidate {
  vantageEquipmentId: number;
  customerId: number | null;
  customerName: string | null;
  town: string | null;
  serial: string | null;
  model: string | null;
  status: PmStatus;
  overdueMonths: number | null;
  priority: boolean;
  whenInArea: boolean;
  district: string | null;
  at: LatLng | null;
  /** True when `at` is the district centre, not the customer's own coordinates. */
  approximate: boolean;
  view: PmView;
  dealer: string | null;
  boardColumn: BoardColumn | null;
}

export interface UpcomingCall {
  workUnitId: number;
  reference: string | null;
  start: Date;
  customerId: number | null;
  customerName: string | null;
  district: string | null;
  categoryName: string | null;
  equipment: string | null;
  started: boolean;
  located: 'customer' | 'district' | null;
  at: LatLng | null;
  suggestions: PmSuggestion[];
}

export interface UpcomingEngineer {
  engineerId: number | null;
  name: string;
  days: { which: 'today' | 'tomorrow'; date: string; calls: UpcomingCall[] }[];
}

const EARTH_MILES = 3958.8;

/** The name the panel shows for an engineer: their Vantage name, else `Engineer <id>`. */
function engineerName(id: number, name: string | null): string {
  return text(name) ?? `Engineer ${id}`;
}

/** Great-circle distance in miles. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Priority first, then overdue, due soon, other statuses; a when-in-area machine below all of those. */
function suggestionRank(c: SuggestionCandidate): number {
  if (c.priority) return 0;
  if (c.whenInArea) return 4;
  if (c.status === 'overdue') return 1;
  if (c.status === 'due_soon') return 2;
  return 3;
}

/**
 * PMs near a call: the same postcode district, the same customer, or within `radiusMiles` of the
 * call's location. Booked, dismissed and other-dealer machines are left out. Ranked priority,
 * overdue, due soon, when-in-area, then nearest.
 */
export function suggestNear(
  call: { customerId: number | null; district: string | null; at: LatLng | null },
  candidates: SuggestionCandidate[],
  radiusMiles: number,
  limit = 8,
): PmSuggestion[] {
  const out: { s: PmSuggestion; rank: number }[] = [];
  for (const c of candidates) {
    if (c.view !== 'due' || c.dealer !== null) continue;
    const sameDistrict = call.district !== null && c.district === call.district;
    const sameSite = call.customerId !== null && c.customerId === call.customerId;
    const miles = call.at && c.at ? haversineMiles(call.at, c.at) : null;
    if (!sameDistrict && !sameSite && !(miles !== null && miles <= radiusMiles)) continue;
    out.push({
      rank: suggestionRank(c),
      s: {
        vantageEquipmentId: c.vantageEquipmentId,
        customerName: c.customerName,
        serial: c.serial,
        model: c.model,
        status: c.status,
        overdueMonths: c.overdueMonths,
        priority: c.priority,
        whenInArea: c.whenInArea,
        distanceMiles: miles === null ? null : Math.round(miles * 10) / 10,
        sameDistrict,
        sameSite,
        boardColumn: c.boardColumn,
      },
    });
  }
  out.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.s.distanceMiles ?? Infinity) - (b.s.distanceMiles ?? Infinity) ||
      (b.s.overdueMonths ?? -1) - (a.s.overdueMonths ?? -1) ||
      a.s.vantageEquipmentId - b.s.vantageEquipmentId,
  );
  return out.slice(0, limit).map((x) => x.s);
}

/**
 * Every due machine as a candidate for a call or the map: plan flags, board column and a location
 * (the customer's coordinates, else its district centre, flagged `approximate`). `pmRows` is
 * `listPlannerRows` when the caller already has it; plan state is always read fresh.
 */
export async function loadCandidates(db: Db, now: Date, pmRows?: PmRow[]): Promise<SuggestionCandidate[]> {
  const [rows, planMap, cache] = await Promise.all([pmRows ?? listPlannerRows(db, now), loadPlanRows(db), loadDistrictCache(db)]);
  const due = rows.filter((r) => inPmView(r, 'due', now));
  const customers = await loadCustomers(db, due.flatMap((r) => (r.customerId === null ? [] : [r.customerId])));
  return due.map((r) => {
    const p = planMap.get(r.vantageEquipmentId);
    const own = r.customerId !== null ? (customers.get(r.customerId)?.at ?? null) : null;
    const centre = r.district ? (cache.get(r.district)?.at ?? null) : null;
    return {
      vantageEquipmentId: r.vantageEquipmentId,
      customerId: r.customerId,
      customerName: r.customerName,
      town: r.town,
      serial: r.serial,
      model: r.model,
      status: r.result.status,
      overdueMonths: overdueOf(r, now),
      priority: p?.priority ?? false,
      whenInArea: p?.whenInArea ?? false,
      district: r.district,
      at: own ?? centre,
      approximate: own === null && centre !== null,
      view: r.view,
      dealer: r.otherDealer.dealer,
      boardColumn: p && p.boardColumn !== null ? boardColumnOf(p, r, now).column : null,
    };
  });
}

export interface MapPin {
  vantageEquipmentId: number;
  customerId: number | null;
  customerName: string | null;
  town: string | null;
  serial: string | null;
  model: string | null;
  status: PmStatus;
  overdueMonths: number | null;
  priority: boolean;
  whenInArea: boolean;
  boardColumn: BoardColumn | null;
  district: string | null;
  at: LatLng;
  approximate: boolean;
}

/**
 * Due machines to pin on the PM map: ours (not another dealer's, not dismissed or booked) and not
 * in the board's Booked column. Machines with no location are counted in `unlocated`. Sorted
 * priority, overdue months, id.
 */
export async function loadMapPins(db: Db, now: Date = new Date(), pmRows?: PmRow[]): Promise<{ pins: MapPin[]; unlocated: number }> {
  const candidates = (await loadCandidates(db, now, pmRows)).filter((c) => c.view === 'due' && c.dealer === null && c.boardColumn !== 'booked');
  const pins: MapPin[] = [];
  let unlocated = 0;
  for (const c of candidates) {
    if (c.at === null) {
      unlocated++;
      continue;
    }
    pins.push({
      vantageEquipmentId: c.vantageEquipmentId,
      customerId: c.customerId,
      customerName: c.customerName,
      town: c.town,
      serial: c.serial,
      model: c.model,
      status: c.status,
      overdueMonths: c.overdueMonths,
      priority: c.priority,
      whenInArea: c.whenInArea,
      boardColumn: c.boardColumn,
      district: c.district,
      at: c.at,
      approximate: c.approximate,
    });
  }
  pins.sort((a, b) => Number(b.priority) - Number(a.priority) || (b.overdueMonths ?? -1) - (a.overdueMonths ?? -1) || a.vantageEquipmentId - b.vantageEquipmentId);
  return { pins, unlocated };
}

/**
 * Each engineer's Field calls for today and tomorrow (Europe/London days) from
 * `vantage_scheduled_units` (completed ones left out), in scheduled order, each with the due
 * machines near it. Suggestions search the whole due list, not only the board. `pmRows` is
 * `listPlannerRows` when the caller already has it; the plan state (board column, flags) is always
 * read fresh here, so a board sync run just before (by `loadBoard`) is seen.
 */
export async function loadUpcoming(
  db: Db,
  now: Date = new Date(),
  pmRows?: PmRow[],
): Promise<{ today: string; tomorrow: string; engineers: UpcomingEngineer[] }> {
  const today = londonDay(now);
  const tomorrow = londonDay(new Date(new Date(`${today}T12:00:00Z`).getTime() + DAY_MS));
  const settings = await getPlannerSettings(db);

  // Wide enough to cover today and tomorrow at any London offset; the exact day filter follows.
  const allUnits = await db
    .select()
    .from(vantageScheduledUnits)
    .where(and(gte(vantageScheduledUnits.scheduledStart, new Date(now.getTime() - 2 * DAY_MS)), lt(vantageScheduledUnits.scheduledStart, new Date(now.getTime() + 4 * DAY_MS))));
  const units = allUnits
    .filter((u) => u.categoryType === 'Field' && u.completedAt === null && [today, tomorrow].includes(londonDay(u.scheduledStart)))
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime() || a.workUnitId - b.workUnitId);

  const equipIds = [...new Set(units.flatMap((u) => (u.vantageEquipmentId === null ? [] : [u.vantageEquipmentId])))];
  const equipment = new Map<number, { serial: string | null; description: string | null; customerId: number | null; customerName: string | null }>();
  if (equipIds.length > 0) {
    const eq = await db
      .select({ id: vantageEquipment.vantageId, serial: vantageEquipment.serial, description: vantageEquipment.description, customerId: vantageEquipment.vantageCustomerId, customerName: vantageEquipment.customerName })
      .from(vantageEquipment)
      .where(inArray(vantageEquipment.vantageId, equipIds));
    for (const e of eq) equipment.set(e.id, e);
  }
  const callCustomerId = (u: (typeof units)[number]) => u.customerId ?? (u.vantageEquipmentId === null ? null : (equipment.get(u.vantageEquipmentId)?.customerId ?? null));

  const [rows, cache, engineerRows] = await Promise.all([
    pmRows ?? listPlannerRows(db, now),
    loadDistrictCache(db),
    db.select({ id: vantageEngineers.vantageId, name: vantageEngineers.name }).from(vantageEngineers),
  ]);
  const customers = await loadCustomers(db, units.flatMap((u) => {
    const c = callCustomerId(u);
    return c === null ? [] : [c];
  }));
  const candidates = await loadCandidates(db, now, rows);

  const engineerNames = new Map(engineerRows.map((e) => [e.id, e.name]));
  const byEngineer = new Map<number | null, UpcomingEngineer>();
  for (const u of units) {
    let eng = byEngineer.get(u.engineerId);
    if (!eng) {
      const name = u.engineerId === null ? 'Unassigned' : engineerName(u.engineerId, engineerNames.get(u.engineerId) ?? null);
      eng = {
        engineerId: u.engineerId,
        name,
        days: [
          { which: 'today', date: today, calls: [] },
          { which: 'tomorrow', date: tomorrow, calls: [] },
        ],
      };
      byEngineer.set(u.engineerId, eng);
    }
    const customerId = callCustomerId(u);
    const cust = customerId === null ? undefined : customers.get(customerId);
    const centroid = cust?.district ? (cache.get(cust.district)?.at ?? null) : null;
    const at = cust?.at ?? centroid;
    const district = cust?.district ?? null;
    const e = u.vantageEquipmentId === null ? undefined : equipment.get(u.vantageEquipmentId);
    const equipmentText = e ? [e.description, e.serial ? `(${e.serial})` : null].filter(Boolean).join(' ') || null : null;
    const call: UpcomingCall = {
      workUnitId: u.workUnitId,
      reference: u.workReference,
      start: u.scheduledStart,
      customerId,
      customerName: cust?.name ?? e?.customerName ?? null,
      district,
      categoryName: u.categoryName,
      equipment: equipmentText,
      started: u.workStart !== null,
      located: cust?.at ? 'customer' : centroid ? 'district' : null,
      at,
      suggestions: suggestNear({ customerId, district, at }, candidates, settings.nearMiles),
    };
    (londonDay(u.scheduledStart) === today ? eng.days[0]! : eng.days[1]!).calls.push(call);
  }
  const engineers = [...byEngineer.values()].sort(
    (a, b) => (a.engineerId === null ? 1 : 0) - (b.engineerId === null ? 1 : 0) || a.name.localeCompare(b.name),
  );
  return { today, tomorrow, engineers };
}

/**
 * One scheduled call for *Asked engineer*: who it is booked to (named as the panel names them) and
 * when it starts. The action reads these here rather than trusting the posted form. Null when the
 * unit is not in `vantage_scheduled_units` (refreshed away) or has no engineer.
 */
export async function getScheduledCall(db: Db, workUnitId: number): Promise<{ engineerId: number; engineerName: string; start: Date } | null> {
  const [u] = await db
    .select({ engineerId: vantageScheduledUnits.engineerId, start: vantageScheduledUnits.scheduledStart })
    .from(vantageScheduledUnits)
    .where(eq(vantageScheduledUnits.workUnitId, workUnitId));
  if (!u || u.engineerId === null) return null;
  const [e] = await db.select({ name: vantageEngineers.name }).from(vantageEngineers).where(eq(vantageEngineers.vantageId, u.engineerId));
  return { engineerId: u.engineerId, engineerName: engineerName(u.engineerId, e?.name ?? null), start: u.start };
}
