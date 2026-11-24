/**
 * Which regional dealer an address belongs to, and who is the "other dealer" for a site. One rule,
 * used by PM due, the planner and Customers: never re-express it in SQL or a component.
 */

export type DealerRegion = 'ireland' | 'scotland' | 'channel_islands';

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, '').toUpperCase();

/** Eircode: routing key (letter + 2 digits, or D6W) then a 4-character unique id. UK inward codes are 3 characters. */
const EIRCODE = /^(?:[ACDEFHKNPRTVWXY]\d{2}|D6W)[0-9ACDEFHKNPRTVWXY]{4}$/;
/** UK postcode: outward code, optionally followed by the inward code. */
const UK_POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})?$/;

export function isEircode(postCode: string | null | undefined): boolean {
  return EIRCODE.test(norm(postCode));
}

/** The outward code ('GU14') of a UK postcode in any spacing or case; Eircodes and junk give null. */
export function postcodeOutward(postCode: string | null | undefined): string | null {
  const p = norm(postCode);
  if (p === '' || EIRCODE.test(p)) return null;
  return UK_POSTCODE.exec(p)?.[1] ?? null;
}

/** The leading letters of the outward code ('GU'). */
export function postcodeArea(postCode: string | null | undefined): string | null {
  const o = postcodeOutward(postCode);
  return o === null ? null : (/^[A-Z]+/.exec(o)?.[0] ?? null);
}

const SCOTTISH_AREAS = new Set(['AB', 'DD', 'DG', 'EH', 'FK', 'G', 'HS', 'IV', 'KA', 'KW', 'KY', 'ML', 'PA', 'PH', 'TD', 'ZE']);

/** The 26 counties of the Republic plus the 6 of Northern Ireland (Derry is also written Londonderry). */
const IRISH_COUNTIES = [
  'carlow', 'cavan', 'clare', 'cork', 'donegal', 'dublin', 'galway', 'kerry', 'kildare', 'kilkenny', 'laois', 'leitrim', 'limerick',
  'longford', 'louth', 'mayo', 'meath', 'monaghan', 'offaly', 'roscommon', 'sligo', 'tipperary', 'waterford', 'westmeath', 'wexford',
  'wicklow', 'antrim', 'armagh', 'down', 'fermanagh', 'londonderry', 'derry', 'tyrone',
];
/** `Co.`/`Co `/`County` only counts when an Irish county follows, so `Co. Durham` is England. */
const IRISH_COUNTY = new RegExp(`^(?:co\\.?|county)\\s*(?:${IRISH_COUNTIES.join('|')})\\b`, 'i');

const CHANNEL_ISLANDS_AREAS = new Set(['GY', 'JE']);
/** Channel Islands county text (Vantage holds `Channel Isles` for Guernsey and Jersey sites that have no postcode). */
const CHANNEL_ISLANDS_COUNTY = /\b(?:channel\s+is(?:les?|lands?)|guernsey|jersey|alderney|sark)\b/i;

/**
 * 'ireland' (Republic by Eircode or county, Northern Ireland by BT), 'scotland', 'channel_islands' (GY, JE or county), or null (ours).
 * A recognised postcode always decides; the county is only read when there is no usable postcode.
 */
export function regionOf(a: { postCode: string | null | undefined; county: string | null | undefined }): DealerRegion | null {
  if (isEircode(a.postCode)) return 'ireland';
  const area = postcodeArea(a.postCode);
  if (area !== null) {
    if (area === 'BT') return 'ireland';
    if (CHANNEL_ISLANDS_AREAS.has(area)) return 'channel_islands';
    return SCOTTISH_AREAS.has(area) ? 'scotland' : null;
  }
  const county = (a.county ?? '').trim();
  if (county === '') return null;
  if (IRISH_COUNTY.test(county) || /\bdublin\b/i.test(county)) return 'ireland';
  return CHANNEL_ISLANDS_COUNTY.test(county) ? 'channel_islands' : null;
}

export type OtherDealerOverride = 'dealer' | 'ours';
export interface OtherDealerFlag {
  override: OtherDealerOverride | null;
  name: string | null;
}
export interface OtherDealerResolution {
  dealer: string | null;
  source: 'site' | 'head_office' | 'region' | null;
  region: DealerRegion | null;
}

function fromFlag(f: OtherDealerFlag | null): { dealer: string | null } | null {
  if (f === null || f.override === null) return null;
  if (f.override === 'ours') return { dealer: null };
  const name = f.name?.trim();
  return name ? { dealer: name } : null;
}

/** Site manual ('ours' or a dealer) > head-office manual > the region rule on the site's own address. */
export function resolveOtherDealer(a: {
  own: OtherDealerFlag | null;
  headOffice: OtherDealerFlag | null;
  region: DealerRegion | null;
  regionDealers: Record<DealerRegion, string | null>;
}): OtherDealerResolution {
  const own = fromFlag(a.own);
  if (own) return { dealer: own.dealer, source: 'site', region: a.region };
  const ho = fromFlag(a.headOffice);
  if (ho) return { dealer: ho.dealer, source: 'head_office', region: a.region };
  if (a.region === null) return { dealer: null, source: null, region: null };
  const dealer = a.regionDealers[a.region]?.trim() || null;
  return { dealer, source: dealer === null ? null : 'region', region: a.region };
}
