import { AuthError, HttpError, RateLimitError } from '@mps/core';
import { describe, expect, it } from 'vitest';
import { createDrmsClient } from './client';
import { MethodLimiter, type Clock } from './limiter';

const noWait: Clock = { now: () => 0, sleep: async () => {} };

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (f: typeof fetch) =>
  createDrmsClient({
    baseUrl: 'https://drms.test/api/v8/',
    token: 'tok',
    fetch: f,
    limiter: new MethodLimiter(1000, 600_000, noWait),
  });

const devices = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ Id: `id-${from + i}`, SerialNumber: `S${from + i}`, Status: 'Registered' }));

describe('DRMS client', () => {
  it('sends the bearer token and paginates until a short page', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.searchParams.get('pageNo') === '1' ? json(devices(0, 1000)) : json(devices(1000, 3)),
    );
    const list = await client(fn).listEquipment();
    expect(list).toHaveLength(1003);
    expect(calls.map((c) => c.url.pathname + c.url.search)).toEqual([
      '/api/v8/Equipment?pageNo=1',
      '/api/v8/Equipment?pageNo=2',
    ]);
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('stops when a page repeats already-seen ids', async () => {
    const { fn, calls } = fakeFetch(() => json(devices(0, 1000)));
    const list = await client(fn).listEquipment();
    expect(list).toHaveLength(1000);
    expect(calls).toHaveLength(2);
  });

  it('keeps unknown fields on equipment', async () => {
    const { fn } = fakeFetch(() => json([{ Id: 'a', CsrcCenterId: 'GB500' }]));
    const [first] = await client(fn).listEquipment();
    expect(first).toMatchObject({ Id: 'a', CsrcCenterId: 'GB500' });
  });

  it('throws RateLimitError on 429 and blocks the method without calling again', async () => {
    const { fn, calls } = fakeFetch(() => new Response('', { status: 429 }));
    const c = client(fn);
    await expect(c.latestCounters('x')).rejects.toBeInstanceOf(RateLimitError);
    await expect(c.latestCounters('y')).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
  });

  it('maps 401 to AuthError and 500 to HttpError', async () => {
    await expect(client(fakeFetch(() => new Response('', { status: 401 })).fn).listCustomers()).rejects.toBeInstanceOf(AuthError);
    await expect(client(fakeFetch(() => new Response('boom', { status: 500 })).fn).listCustomers()).rejects.toBeInstanceOf(HttpError);
  });

  it('returns null for empty or 404 LatestCounters and parses a sample', async () => {
    expect(await client(fakeFetch(() => new Response('', { status: 200 })).fn).latestCounters('a')).toBeNull();
    expect(await client(fakeFetch(() => new Response('Not Found', { status: 404 })).fn).latestCounters('a')).toBeNull();
    const sample = {
      Id: 'a',
      CounterId: 'c1',
      ReceivedTime: '2026-09-17 02:00:00',
      Counters: [{ ItemNumber: 1, Name: 'BlackTonerLevel', Value: 58 }],
      ModeSizeCounters: [{ ColorMode: 'FullColor', Mode: 'CopyMode', Counters: [{ ItemNumber: '2', Name: 'A4 SEF Full', Value: '12' }] }],
    };
    const { fn, calls } = fakeFetch(() => json(sample));
    expect(await client(fn).latestCounters('a b')).toMatchObject(sample);
    expect(calls[0]?.url.pathname).toBe('/api/v8/Equipment/a%20b/LatestCounters');
  });

  it('testAuth returns the raw text', async () => {
    const { fn } = fakeFetch(() => new Response('"Ok(28.11.2021 14: 48: 30)"'));
    expect(await client(fn).testAuth()).toBe('"Ok(28.11.2021 14: 48: 30)"');
  });

  describe('listAlarms', () => {
    const dateFrom = new Date('2026-09-16T00:00:00Z');
    const dateTo = new Date('2026-09-17T00:00:00Z');

    it('sends dates formatted YYYY-MM-DD HH:mm:ss UTC and the method key for the limiter', async () => {
      const { fn, calls } = fakeFetch(() => json([]));
      await client(fn).listAlarms({ dateFrom, dateTo });
      expect(calls[0]?.url.pathname).toBe('/api/v8/Equipment/Alarms');
      expect(calls[0]?.url.searchParams.get('dateFrom')).toBe('2026-09-16 00:00:00');
      expect(calls[0]?.url.searchParams.get('dateTo')).toBe('2026-09-17 00:00:00');
      expect(calls[0]?.url.searchParams.get('pageNo')).toBe('1');
    });

    it('flattens the per-equipment Alarms arrays, keeping the equipment Id', async () => {
      const { fn } = fakeFetch(() =>
        json([
          {
            Id: 'eq-1',
            Alarms: [
              { AlarmId: 'a1', FcCode: 'TN-00', Description: 'Toner near empty', Status: 'EquipmentDiscovered', ReceivedTime: '2026-09-16 01:00:00' },
              { AlarmId: 'a2', FcCode: 'TO-00', Description: 'Waste toner full', Status: 'ReadyForErpDelivery', ReceivedTime: '2026-09-16 02:00:00' },
            ],
          },
          { Id: 'eq-2', Alarms: [{ AlarmId: 'a3', FcCode: 'SC-00', Status: 'EquipmentDiscovered', ReceivedTime: '2026-09-16 03:00:00' }] },
        ]),
      );
      const alarms = await client(fn).listAlarms({ dateFrom, dateTo });
      expect(alarms).toHaveLength(3);
      expect(alarms[0]).toMatchObject({ EquipmentId: 'eq-1', AlarmId: 'a1', FcCode: 'TN-00' });
      expect(alarms[2]).toMatchObject({ EquipmentId: 'eq-2', AlarmId: 'a3' });
    });

    it('treats an entry with no Alarms array as contributing nothing', async () => {
      const { fn } = fakeFetch(() => json([{ Id: 'eq-1', Alarms: null }]));
      expect(await client(fn).listAlarms({ dateFrom, dateTo })).toEqual([]);
    });

    it('paginates until a short page, like the other list* methods', async () => {
      const page1 = Array.from({ length: 1000 }, (_, i) => ({ Id: `eq-${i}`, Alarms: [{ AlarmId: `a-${i}`, FcCode: 'TN-00', Status: 'EquipmentDiscovered', ReceivedTime: '2026-09-16 01:00:00' }] }));
      const page2 = [{ Id: 'eq-last', Alarms: [{ AlarmId: 'a-last', FcCode: 'TN-00', Status: 'EquipmentDiscovered', ReceivedTime: '2026-09-16 01:00:00' }] }];
      const { fn, calls } = fakeFetch((url) => (url.searchParams.get('pageNo') === '1' ? json(page1) : json(page2)));
      const alarms = await client(fn).listAlarms({ dateFrom, dateTo });
      expect(alarms).toHaveLength(1001);
      expect(calls).toHaveLength(2);
    });

    it('rejects a range longer than 1 day without calling the API', async () => {
      const { fn, calls } = fakeFetch(() => json([]));
      await expect(client(fn).listAlarms({ dateFrom, dateTo: new Date('2026-09-17T00:00:01Z') })).rejects.toBeInstanceOf(HttpError);
      expect(calls).toHaveLength(0);
    });

    it('throws RateLimitError on 429 without paginating further', async () => {
      const { fn, calls } = fakeFetch(() => new Response('', { status: 429 }));
      await expect(client(fn).listAlarms({ dateFrom, dateTo })).rejects.toBeInstanceOf(RateLimitError);
      expect(calls).toHaveLength(1);
    });
  });
});
