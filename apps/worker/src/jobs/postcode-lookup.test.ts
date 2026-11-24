import { postcodeDistricts, vantageCustomers } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPostcodeLookup } from './postcode-lookup';

const NOW = new Date('2026-11-23T03:40:00Z');
const BASE = 'https://postcodes.test';
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const okBody = (outcode: string, extra: object = {}) => ({
  status: 200,
  result: { outcode, latitude: 51.29, longitude: -0.76, admin_county: ['Hampshire'], admin_district: ['Rushmoor'], ...extra },
});
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const noHit = () => respond({ status: 200, result: null });

/**
 * A mock fetch: `route` maps an outward code to a Response (or throws); `centre` answers the
 * reverse lookup at the district's centre (default: no postcode there). `urls` records outcode
 * calls, `centreUrls` the reverse ones.
 */
function mockFetch(route: (district: string) => Response | Promise<Response>, centre: (url: string) => Response | Promise<Response> = noHit) {
  const urls: string[] = [];
  const centreUrls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(`${BASE}/postcodes?`)) {
      centreUrls.push(url);
      return centre(url);
    }
    urls.push(url);
    return route(url.slice(`${BASE}/outcodes/`.length));
  }) as typeof fetch;
  return { fn, urls, centreUrls };
}

describe('runPostcodeLookup', () => {
  let t: TestDb;
  let sleeps: number[];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const customer = (id: number, postCode: string | null, deletedDate: Date | null = null) =>
    t.db.insert(vantageCustomers).values({ vantageId: id, name: `Customer ${id}`, deletedDate, raw: { PostCode: postCode } });
  const run = (f: ReturnType<typeof mockFetch>, extra: object = {}) =>
    runPostcodeLookup({ db: t.db, fetch: f.fn, baseUrl: BASE, sleep, now: () => NOW, ...extra });
  const cached = async () => (await t.db.select().from(postcodeDistricts)).sort((a, b) => a.district.localeCompare(b.district));

  beforeEach(async () => {
    t = await createTestDb();
    sleeps = [];
  });
  afterEach(() => t.close());

  it('caches county, latitude and longitude, preferring admin_county', async () => {
    await customer(1, 'GU14 7PR');
    const f = mockFetch((d) => respond(okBody(d)));
    const res = await run(f);
    expect(res).toMatchObject({ status: 'success', stats: { looked_up: 1, cached: 1, not_found: 0 } });
    expect(f.urls).toEqual([`${BASE}/outcodes/GU14`]);
    const [row] = await cached();
    expect(row).toMatchObject({ district: 'GU14', county: 'Hampshire', adminDistrict: 'Rushmoor', latitude: 51.29, longitude: -0.76, status: 'ok' });
    expect(row?.lookedUpAt.toISOString()).toBe(NOW.toISOString());
  });

  it('falls back to admin_district when admin_county is empty or missing, and null when both are', async () => {
    await customer(1, 'GU14 7PR');
    await customer(2, 'M1 1AA');
    await customer(3, 'XX1 1AA');
    const f = mockFetch((d) =>
      respond(
        d === 'GU14'
          ? okBody(d, { admin_county: [] })
          : d === 'M1'
            ? okBody(d, { admin_county: null, admin_district: ['Manchester'] })
            : okBody(d, { admin_county: [], admin_district: [] }),
      ),
    );
    await run(f);
    expect((await cached()).map((r) => [r.district, r.county])).toEqual([['GU14', 'Rushmoor'], ['M1', 'Greater Manchester'], ['XX1', null]]);
  });

  it('takes the authority at the district centre over the first listed county (RG20 is West Berkshire, not Hampshire)', async () => {
    await customer(1, 'RG20 8AE');
    const f = mockFetch(
      (d) => respond(okBody(d, { latitude: 51.38, longitude: -1.35, admin_county: ['Hampshire'], admin_district: ['Basingstoke and Deane', 'West Berkshire'] })),
      () => respond({ status: 200, result: [{ postcode: 'RG14 1RT', admin_county: null, admin_district: 'West Berkshire' }] }),
    );
    expect(await run(f)).toMatchObject({ status: 'success', stats: { cached: 1 } });
    expect(f.centreUrls).toEqual([`${BASE}/postcodes?lon=-1.35&lat=51.38&limit=1&radius=2000`]);
    expect((await cached())[0]).toMatchObject({ district: 'RG20', county: 'Berkshire', adminDistrict: 'West Berkshire', latitude: 51.38 });
  });

  it('keeps a two-tier county from the centre answer', async () => {
    await customer(1, 'GU14 7PR');
    const f = mockFetch(
      (d) => respond(okBody(d, { admin_county: ['Surrey'], admin_district: ['Guildford'] })),
      () => respond({ status: 200, result: [{ admin_county: 'Hampshire', admin_district: 'Rushmoor' }] }),
    );
    await run(f);
    expect((await cached())[0]).toMatchObject({ county: 'Hampshire', adminDistrict: 'Rushmoor' });
  });

  it('skips the centre lookup when the district has no centre point', async () => {
    await customer(1, 'GU14 7PR');
    const f = mockFetch((d) => respond(okBody(d, { latitude: null, longitude: null })));
    await run(f);
    expect(f.centreUrls).toEqual([]);
    expect((await cached())[0]).toMatchObject({ county: 'Hampshire', latitude: null });
  });

  it('a failed centre lookup stops the run as partial and caches nothing for that district', async () => {
    await customer(1, 'GU14 7PR');
    const f = mockFetch((d) => respond(okBody(d)), () => respond({ status: 429 }, 429));
    const res = await run(f);
    expect(res.status).toBe('partial');
    expect(res.errorSample).toContain('GU14 centre');
    expect(await cached()).toEqual([]);
  });

  it('stores not_found on a 404 and does not ask again inside 30 days, but does after', async () => {
    await customer(1, 'ZZ9 9ZZ');
    await run(mockFetch(() => respond({ status: 404, error: 'Outcode not found' }, 404)));
    expect((await cached()).map((r) => [r.district, r.status, r.county])).toEqual([['ZZ9', 'not_found', null]]);

    const inside = mockFetch(() => respond(okBody('ZZ9')));
    await runPostcodeLookup({ db: t.db, fetch: inside.fn, baseUrl: BASE, sleep, now: () => day(29) });
    expect(inside.urls).toEqual([]);

    const after = mockFetch((d) => respond(okBody(d)));
    await runPostcodeLookup({ db: t.db, fetch: after.fn, baseUrl: BASE, sleep, now: () => day(31) });
    expect(after.urls).toEqual([`${BASE}/outcodes/ZZ9`]);
    expect((await cached())[0]).toMatchObject({ status: 'ok', county: 'Hampshire' });
  });

  it('never re-fetches an ok row, however old', async () => {
    await customer(1, 'GU14 7PR');
    await t.db.insert(postcodeDistricts).values({ district: 'GU14', county: 'Hampshire', status: 'ok', lookedUpAt: new Date('2020-01-01T00:00:00Z') });
    const f = mockFetch((d) => respond(okBody(d)));
    expect(await run(f)).toMatchObject({ status: 'success', stats: { looked_up: 0 } });
    expect(f.urls).toEqual([]);
  });

  it('stops on a 429 with status partial and leaves later districts unqueried', async () => {
    await customer(1, 'AB1 1AA');
    await customer(2, 'GU14 7PR');
    await customer(3, 'M1 1AA');
    const f = mockFetch((d) => (d === 'GU14' ? respond({ status: 429 }, 429) : respond(okBody(d))));
    const res = await run(f);
    expect(res.status).toBe('partial');
    expect(res.errorSample).toContain('429');
    expect(f.urls).toEqual([`${BASE}/outcodes/AB1`, `${BASE}/outcodes/GU14`]);
    expect((await cached()).map((r) => r.district)).toEqual(['AB1']);
  });

  it.each([
    ['a 500', () => respond({ status: 500 }, 500)],
    ['a thrown network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a body that is not JSON', () => new Response('<html>oops</html>', { status: 200 })],
    ['a body with no result', () => respond({ status: 200 })],
  ])('%s stops the run as partial and caches nothing for that district', async (_n, bad) => {
    await customer(1, 'AB1 1AA');
    await customer(2, 'GU14 7PR');
    await customer(3, 'M1 1AA');
    const f = mockFetch((d) => (d === 'GU14' ? bad() : respond(okBody(d))));
    const res = await run(f);
    expect(res.status).toBe('partial');
    expect(f.urls).toEqual([`${BASE}/outcodes/AB1`, `${BASE}/outcodes/GU14`]);
    expect((await cached()).map((r) => r.district)).toEqual(['AB1']);
  });

  it('does not overwrite an already cached row when a re-ask fails', async () => {
    await customer(1, 'ZZ9 9ZZ');
    await t.db.insert(postcodeDistricts).values({ district: 'ZZ9', status: 'not_found', lookedUpAt: new Date('2026-09-01T00:00:00Z') });
    const res = await run(mockFetch(() => respond({}, 503)));
    expect(res.status).toBe('partial');
    expect((await cached())[0]).toMatchObject({ district: 'ZZ9', status: 'not_found', lookedUpAt: new Date('2026-09-01T00:00:00Z') });
  });

  it('sends only the outward code, once per district, skipping deleted customers, Eircodes and blank postcodes', async () => {
    await customer(1, 'gu147pr');
    await customer(2, 'GU14 9XX');
    await customer(3, 'W14 9EQ', new Date('2026-01-01T00:00:00Z'));
    await customer(4, 'D04 EK2K');
    await customer(5, '   ');
    await customer(6, null);
    await customer(7, 'not a postcode');
    const f = mockFetch((d) => respond(okBody(d)));
    await run(f);
    expect(f.urls).toEqual([`${BASE}/outcodes/GU14`]);
  });

  it('respects maxPerRun and sleeps 250 ms between calls only', async () => {
    for (const [i, pc] of ['AB1 1AA', 'BA1 1AA', 'CB1 1AA', 'DE1 1AA'].entries()) await customer(i + 1, pc);
    const f = mockFetch((d) => respond(okBody(d)));
    const res = await run(f, { maxPerRun: 3 });
    expect(f.urls).toHaveLength(3);
    expect(res).toMatchObject({ status: 'success', stats: { looked_up: 3, cached: 3, remaining: 1 } });
    expect(sleeps).toEqual([250, 250]);
  });

  it('defaults to 100 lookups a run', async () => {
    const codes = Array.from({ length: 101 }, (_v, i) => `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}1 1AA`);
    for (const [i, pc] of codes.entries()) await customer(i + 1, pc);
    const f = mockFetch((d) => respond(okBody(d)));
    await run(f);
    expect(f.urls).toHaveLength(100);
  });
});
