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
});
