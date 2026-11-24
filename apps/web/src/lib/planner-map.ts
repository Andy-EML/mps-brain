import type { LatLng, MapPin, MapPlanResult, MapSkipReason } from '@mps/db/queries';

// Types only from @mps/db: values would pull the DB client into the browser bundle.

export const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Selections over this many machines ask for confirmation first. */
export const MAP_CONFIRM_OVER = 50;
/** Most machine ids one map action accepts. */
export const MAP_IDS_MAX = 500;

export type PinTone = 'overdue' | 'due_soon' | 'when_in_area' | 'other';

/** Pin colour class: "when in area" wins over the PM status. */
export function pinTone(p: MapPin): PinTone {
  if (p.whenInArea) return 'when_in_area';
  if (p.status === 'overdue') return 'overdue';
  if (p.status === 'due_soon') return 'due_soon';
  return 'other';
}

export interface Box {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Ids of the pins inside the box, edges inclusive, in input order. */
export function selectInBox(pins: MapPin[], box: Box): number[] {
  return pins
    .filter((p) => p.at.lat >= box.south && p.at.lat <= box.north && p.at.lng >= box.west && p.at.lng <= box.east)
    .map((p) => p.vantageEquipmentId);
}

const EARTH_MILES = 3958.8;

// Local copy of the pure haversine in @mps/db (a value import would drag the DB client into the browser).
function haversineMiles(a: LatLng, b: LatLng): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How many pins lie more than `miles` from the call (0 when the call has no location). */
export function farFromCall(pins: MapPin[], call: { at: LatLng | null }, miles: number): number {
  const at = call.at;
  if (at === null) return 0;
  return pins.filter((p) => haversineMiles(at, p.at) > miles).length;
}

/** Validates the ids a map action posts: 1..MAP_IDS_MAX positive safe integers, de-duplicated. */
export function parseMapIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAP_IDS_MAX) throw new Error('bad ids');
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error('bad ids');
  }
  return [...new Set(raw as number[])];
}

const SKIP_COPY: Record<MapSkipReason, string> = {
  not_on_map: 'no longer due',
  booked: 'already booked',
  done: 'already done',
};

const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' });

function callDay(d: Date): string {
  const p = dayFmt.formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** Toast copy for a map action's result. */
export function mapResultText(r: MapPlanResult, mode: 'add' | 'ask'): string {
  const n = r.done.length;
  const main = mode === 'add' || !r.call ? `${n} added to plan` : `${n} asked ${r.call.engineerName} for ${callDay(r.call.start)}`;
  if (r.skipped.length === 0) return main;
  const reasons = [...new Set(r.skipped.map((s) => SKIP_COPY[s.reason]))].join(', ');
  return `${main} · ${r.skipped.length} skipped: ${reasons}`;
}

const STATUS_COPY: Record<MapPin['status'], string> = {
  overdue: 'Overdue',
  due_soon: 'Due soon',
  ok: 'OK',
  held: 'Held off — frequent calls',
  booked: 'PM booked',
  unknown: 'Unknown',
};

/** A pin's due state in words: `Overdue 8m`, `Due soon`, `When in area · Overdue 3m`. */
export function pinDueText(p: Pick<MapPin, 'status' | 'overdueMonths' | 'whenInArea'>): string {
  const due = p.status === 'overdue' && p.overdueMonths !== null && p.overdueMonths >= 1 ? `Overdue ${p.overdueMonths}m` : STATUS_COPY[p.status];
  return p.whenInArea ? `When in area · ${due}` : due;
}

const COLUMN_COPY: Record<NonNullable<MapPin['boardColumn']>, string> = {
  to_plan: 'To plan',
  asked: 'Asked engineer',
  booked: 'Booked',
  done: 'Done',
};

/** The board column a pin is in, as the board names it, or null when it is not on the board. */
export function boardColumnText(column: MapPin['boardColumn']): string | null {
  return column === null ? null : COLUMN_COPY[column];
}

/** Footer note for machines that cannot be drawn, or null when every machine has a location. */
export function unlocatedText(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 machine has no location' : `${n} machines have no location`;
}
