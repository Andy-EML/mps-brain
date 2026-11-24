import { countyFor, errorMessage, getField, getNumber, getString, postcodeOutward } from '@mps/core';
import { postcodeDistricts, vantageCustomers, type Db } from '@mps/db';
import { isNull } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

export const DEFAULT_POSTCODES_BASE_URL = 'https://api.postcodes.io';
const DEFAULT_MAX_PER_RUN = 100;
const PAUSE_MS = 250;
const REASK_NOT_FOUND_MS = 30 * 86_400_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface PostcodeLookupDeps {
  db: Db;
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxPerRun?: number;
}

type Looked = { kind: 'ok'; row: typeof postcodeDistricts.$inferInsert } | { kind: 'not_found' } | { kind: 'stop'; reason: string };

const first = (v: unknown): string | null => {
  if (!Array.isArray(v)) return null;
  const s = typeof v[0] === 'string' ? v[0].trim() : '';
  return s === '' ? null : s;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

type Fetched = { kind: 'ok'; status: number; body: unknown } | { kind: 'stop'; reason: string };

async function getJson(doFetch: typeof fetch, url: string, label: string): Promise<Fetched> {
  let res: Response;
  let text: string;
  try {
    res = await doFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    text = await res.text();
  } catch (err) {
    return { kind: 'stop', reason: `${label}: ${errorMessage(err)}` };
  }
  if (res.status === 404) return { kind: 'ok', status: 404, body: null };
  if (!res.ok) return { kind: 'stop', reason: `${label}: postcodes.io answered ${res.status}` };
  try {
    return { kind: 'ok', status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'stop', reason: `${label}: unreadable response` };
  }
}

/**
 * Asks postcodes.io (read-only GETs; only the outward code and its public centre point leave the
 * building) about one district. 404 is a definite "no such district"; anything else that is not a
 * clean answer stops the run.
 */
async function lookup(doFetch: typeof fetch, baseUrl: string, district: string, at: Date): Promise<Looked> {
  const out = await getJson(doFetch, `${baseUrl}/outcodes/${encodeURIComponent(district)}`, district);
  if (out.kind === 'stop') return out;
  if (out.status === 404) return { kind: 'not_found' };
  const result = getField(out.body, 'result');
  if (result == null || typeof result !== 'object') return { kind: 'stop', reason: `${district}: response has no result` };
  const latitude = getNumber(result, 'latitude');
  const longitude = getNumber(result, 'longitude');

  // The outcode answer lists every authority the district touches, and admin_county only for
  // two-tier ones, so its first entry can be a minority neighbour (RG20 -> Hampshire, though most
  // of RG20 is West Berkshire). Ask which authority sits at the district's centre instead.
  let adminCounty = first(getField(result, 'admin_county'));
  let adminDistrict = first(getField(result, 'admin_district'));
  if (latitude !== null && longitude !== null) {
    const rev = await getJson(doFetch, `${baseUrl}/postcodes?lon=${longitude}&lat=${latitude}&limit=1&radius=2000`, `${district} centre`);
    if (rev.kind === 'stop') return rev;
    const hits = getField(rev.body, 'result');
    const hit: unknown = Array.isArray(hits) ? hits[0] : null;
    if (hit != null && typeof hit === 'object' && str(getField(hit, 'admin_district')) !== null) {
      adminCounty = str(getField(hit, 'admin_county'));
      adminDistrict = str(getField(hit, 'admin_district'));
    }
  }
  return {
    kind: 'ok',
    row: { district, county: countyFor(adminCounty, adminDistrict), adminDistrict, latitude, longitude, status: 'ok', lookedUpAt: at },
  };
}

/**
 * Nightly fill of the postcode-district cache (county and centroid) for the planner's areas. Takes
 * the distinct outward codes of live customers that are not cached `ok` and not `not_found` within
 * 30 days, at most `maxPerRun`, with a pause between calls. A 404 caches `not_found`; any other
 * failure (429, 5xx, network, junk body) stops the run as `partial` and caches nothing for that
 * district, so a later run just asks again.
 */
export async function runPostcodeLookup(deps: PostcodeLookupDeps): Promise<JobResult> {
  const { db } = deps;
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_POSTCODES_BASE_URL).replace(/\/+$/, '');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = (deps.now ?? (() => new Date()))();
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;

  const customers = await db.select({ raw: vantageCustomers.raw }).from(vantageCustomers).where(isNull(vantageCustomers.deletedDate));
  const wanted = new Set<string>();
  for (const c of customers) {
    const district = postcodeOutward(getString(c.raw, 'PostCode'));
    if (district) wanted.add(district);
  }

  const known = await db.select().from(postcodeDistricts);
  const fresh = new Set(
    known.filter((r) => r.status === 'ok' || startedAt.getTime() - r.lookedUpAt.getTime() < REASK_NOT_FOUND_MS).map((r) => r.district),
  );
  const todo = [...wanted].filter((d) => !fresh.has(d)).sort();

  let cachedOk = 0;
  let notFound = 0;
  let lookedUp = 0;
  let stopped: string | null = null;
  for (const [i, district] of todo.slice(0, maxPerRun).entries()) {
    if (i > 0) await sleep(PAUSE_MS);
    lookedUp++;
    const res = await lookup(doFetch, baseUrl, district, startedAt);
    if (res.kind === 'stop') {
      stopped = res.reason;
      break;
    }
    const row: typeof postcodeDistricts.$inferInsert =
      res.kind === 'ok' ? res.row : { district, county: null, adminDistrict: null, latitude: null, longitude: null, status: 'not_found', lookedUpAt: startedAt };
    await db
      .insert(postcodeDistricts)
      .values(row)
      .onConflictDoUpdate({
        target: postcodeDistricts.district,
        set: { county: row.county, adminDistrict: row.adminDistrict, latitude: row.latitude, longitude: row.longitude, status: row.status, lookedUpAt: row.lookedUpAt },
      });
    if (res.kind === 'ok') cachedOk++;
    else notFound++;
  }

  const stats = { looked_up: lookedUp, cached: cachedOk, not_found: notFound, remaining: todo.length - cachedOk - notFound };
  return stopped === null ? { status: 'success', stats } : { status: 'partial', stats, errorSample: `stopped: ${stopped}` };
}
