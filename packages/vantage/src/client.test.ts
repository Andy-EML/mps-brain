import { AuthError, ParseError } from '@mps/core';
import { describe, expect, it } from 'vitest';
import { createVantageClient } from './client';

type Req = { url: URL; method: string; headers: Record<string, string>; signal?: AbortSignal | null };
type Handler = (req: Req) => Response;

function fakeFetch(handler: Handler) {
  const calls: Req[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    };
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const session = (token: string, expiry: string) => json({ Token: token, TokenExpiryDate: expiry });
const T0 = Date.parse('2026-09-17T10:00:00Z');

function make(handler: Handler, now = () => T0, pageSize = 2) {
  const f = fakeFetch(handler);
  const client = createVantageClient({
    baseUrl: 'https://api.vantage.test/',
    username: 'u',
    password: 'p',
    apiVersion: '1.22',
    fetch: f.fn,
    now,
    pageSize,
  });
  return { client, calls: f.calls };
}

describe('Vantage client', () => {
  it('logs in with Basic auth, then GETs with Bearer and api-version', async () => {
    const { client, calls } = make(({ url }) =>
      url.pathname === '/application/loginsingle'
        ? session('t1', '2026-09-17T10:30:00Z')
        : json({ value: [{ Id: 1 }] }),
    );
    expect(await client.listCustomers()).toEqual([{ Id: 1 }]);
    const [login, get] = calls;
    expect(login?.method).toBe('POST');
    expect(login?.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(login?.headers['api-version']).toBe('1.22');
    expect(get?.url.pathname).toBe('/customer');
    expect(get?.headers.authorization).toBe('Bearer t1');
    expect(get?.headers['api-version']).toBe('1.22');
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
  });

  it('builds filters with the deleted guard and since, encoded with %20', async () => {
    const { client, calls } = make(({ url }) =>
      url.pathname.startsWith('/application') ? session('t', '2026-09-17T10:30:00Z') : json([]),
    );
    await client.listEquipment({ since: new Date('2026-09-01T00:00:00Z') });
    const get = calls[1]!;
    expect(get.url.search).toContain(
      '$filter=(deleteddate%20eq%20null)%20and%20(modifieddate%20gt%202026-09-01T00%3A00%3A00.000Z%20or%20createddate%20gt%202026-09-01T00%3A00%3A00.000Z%20or%20deleteddate%20gt%202026-09-01T00%3A00%3A00.000Z)',
    );
    expect(get.url.searchParams.get('$expand')).toBe('Item,Customer');

    await client.listEquipment({ includeDeleted: true });
    expect(calls[2]!.url.searchParams.get('$filter')).toBeNull();
  });

  it('lists sales orders with the lines/item/type expand and the deleted guard', async () => {
    const { client, calls } = make(({ url }) =>
      url.pathname.startsWith('/application')
        ? session('t', '2026-09-17T10:30:00Z')
        : json({ value: [{ Id: 7, Reference: 'SO2609-0214', Lines: [{ Id: 1 }] }] }),
    );
    const orders = await client.listSalesOrders();
    expect(orders).toEqual([{ Id: 7, Reference: 'SO2609-0214', Lines: [{ Id: 1 }] }]);
    const get = calls[1]!;
    expect(get.url.pathname).toBe('/SalesOrder');
    expect(get.url.searchParams.get('$expand')).toBe(
      'Lines($expand=Item($select=Id,PartNumber,Description)),Type($select=Id,Name)',
    );
    expect(get.url.searchParams.get('$filter')).toBe('(deleteddate eq null)');
  });

  it('adds the incremental filter and an orderdate floor for sales orders', async () => {
    const { client, calls } = make(({ url }) =>
      url.pathname.startsWith('/application') ? session('t', '2026-09-17T10:30:00Z') : json([]),
    );
    await client.listSalesOrders({ since: new Date('2026-09-01T00:00:00Z'), includeDeleted: true });
    expect(calls[1]!.url.searchParams.get('$filter')).toBe(
      '(modifieddate gt 2026-09-01T00:00:00.000Z or createddate gt 2026-09-01T00:00:00.000Z or deleteddate gt 2026-09-01T00:00:00.000Z)',
    );

    await client.listSalesOrders({ orderDateFrom: new Date('2024-09-18T02:40:00Z') });
    expect(calls[2]!.url.searchParams.get('$filter')).toBe(
      // OrderDate is an Edm.Date; a full timestamp makes Vantage answer 400.
      '(deleteddate eq null) and (orderdate ge 2024-09-18)',
    );
  });

  it('pages by key with $orderby=Id and Id gt lastId until a short page', async () => {
    const all = [1, 2, 3].map((Id) => ({ Id }));
    const { client, calls } = make(({ url }) => {
      if (url.pathname.startsWith('/application')) return session('t', '2026-09-17T10:30:00Z');
      const after = /\(Id gt (\d+)\)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
      const rest = all.filter((r) => r.Id > Number(after ?? 0));
      return json({ value: rest.slice(0, Number(url.searchParams.get('$top'))) });
    });
    expect((await client.listCustomers()).map((r) => r.Id)).toEqual([1, 2, 3]);
    const gets = calls.slice(1);
    expect(gets).toHaveLength(2);
    expect(gets.map((c) => c.url.searchParams.get('$orderby'))).toEqual(['Id', 'Id']);
    expect(gets.map((c) => c.url.searchParams.get('$top'))).toEqual(['2', '2']);
    expect(gets.some((c) => c.url.searchParams.has('$skip') || c.url.searchParams.has('$count'))).toBe(false);
    expect(gets[0]!.url.searchParams.get('$filter')).toBe('(deleteddate eq null)');
    expect(gets[1]!.url.searchParams.get('$filter')).toBe('(deleteddate eq null) and (Id gt 2)');
  });

  it('stops on an empty page after a full one', async () => {
    const pages = [[{ Id: 1 }, { Id: 2 }], []];
    let n = 0;
    const { client, calls } = make(({ url }) =>
      url.pathname.startsWith('/application') ? session('t', '2026-09-17T10:30:00Z') : json(pages[n++] ?? []),
    );
    expect((await client.listCustomers({ includeDeleted: true })).map((r) => r.Id)).toEqual([1, 2]);
    expect(calls.slice(1).map((c) => c.url.searchParams.get('$filter'))).toEqual([null, '(Id gt 2)']);
  });

  it('reissues when the token is near expiry', async () => {
    let now = T0;
    const { client, calls } = make(
      ({ url }) => {
        if (url.pathname === '/application/loginsingle') return session('t1', '2026-09-17T10:30:00Z');
        if (url.pathname === '/application/reissue') return session('t2', '2026-09-17T11:00:00Z');
        return json([]);
      },
      () => now,
    );
    await client.listCustomers();
    now = Date.parse('2026-09-17T10:26:00Z');
    await client.listCustomers();
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/application/loginsingle',
      '/customer',
      '/application/reissue',
      '/customer',
    ]);
    expect(calls[2]?.headers.authorization).toBe('Bearer t1');
    expect(calls[3]?.headers.authorization).toBe('Bearer t2');
  });

  it('re-logs in once on 401, then gives up with AuthError', async () => {
    let getCount = 0;
    const { client } = make(({ url }) => {
      if (url.pathname.startsWith('/application')) return session('t', '2026-09-17T10:30:00Z');
      getCount++;
      return new Response('', { status: 401 });
    });
    await expect(client.listCustomers()).rejects.toBeInstanceOf(AuthError);
    expect(getCount).toBe(2);
  });

  it('throws AuthError when login fails', async () => {
    const { client } = make(() => json({ error: { message: 'bad' } }, 400));
    await expect(client.listCustomers()).rejects.toBeInstanceOf(AuthError);
  });

  it('caps paging to avoid an unbounded loop against a misbehaving server', async () => {
    const f = fakeFetch(({ url }) =>
      url.pathname.startsWith('/application')
        ? session('t', '2026-09-17T10:30:00Z')
        : json({ value: [{ Id: 1 }, { Id: 2 }] }),
    );
    const client = createVantageClient({
      baseUrl: 'https://api.vantage.test/',
      username: 'u',
      password: 'p',
      apiVersion: '1.22',
      fetch: f.fn,
      now: () => T0,
      pageSize: 2,
      maxPages: 3,
    });
    await expect(client.listCustomers()).rejects.toBeInstanceOf(ParseError);
    const getCalls = f.calls.filter((c) => !c.url.pathname.startsWith('/application'));
    expect(getCalls).toHaveLength(3);
  });
});
