import { AuthError, HttpError, ParseError, getField, getNumber, getString, parseApiDate } from '@mps/core';

export interface VantageClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  apiVersion: string;
  fetch?: typeof fetch;
  now?: () => number;
  pageSize?: number;
  maxPages?: number;
}

export interface ListOptions {
  since?: Date;
  includeDeleted?: boolean;
}

export type VantageRecord = Record<string, unknown>;

const REISSUE_WINDOW_MS = 5 * 60_000;
const MAX_PAGES = 10_000;

function buildQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

function parseJson(text: string, what: string, status: number): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ParseError(`Vantage ${what} returned non-JSON`, status, text.slice(0, 500));
  }
}

export function createVantageClient(opts: VantageClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const defaultPageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  let token: string | null = null;
  let expiresAt = 0;

  async function openSession(kind: 'loginsingle' | 'reissue'): Promise<void> {
    const authorization =
      kind === 'loginsingle'
        ? `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`
        : `Bearer ${token}`;
    const res = await doFetch(`${base}/application/${kind}`, {
      method: 'POST',
      headers: { authorization, 'api-version': opts.apiVersion, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new AuthError(`Vantage ${kind} failed (${res.status})`, res.status, text.slice(0, 500));
    const body = parseJson(text, kind, res.status);
    const newToken = getString(body, 'Token');
    if (!newToken) throw new ParseError(`Vantage ${kind} returned no token`, res.status);
    token = newToken;
    expiresAt = parseApiDate(getField(body, 'TokenExpiryDate'))?.getTime() ?? now() + 25 * 60_000;
  }

  async function ensureToken(): Promise<void> {
    if (!token) return openSession('loginsingle');
    if (expiresAt - now() < REISSUE_WINDOW_MS) {
      try {
        await openSession('reissue');
      } catch {
        token = null;
        await openSession('loginsingle');
      }
    }
  }

  async function get(path: string, params: Record<string, string | number>): Promise<unknown> {
    const send = () =>
      doFetch(`${base}/${path}?${buildQuery(params)}`, {
        headers: { authorization: `Bearer ${token}`, 'api-version': opts.apiVersion, Accept: 'application/json' },
      });
    await ensureToken();
    let res = await send();
    if (res.status === 401) {
      token = null;
      await ensureToken();
      res = await send();
      if (res.status === 401) throw new AuthError(`Vantage GET ${path} unauthorised after re-login`, 401);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(`Vantage GET ${path} failed (${res.status})`, res.status, text.slice(0, 500));
    return parseJson(text, `GET ${path}`, res.status);
  }

  async function odataList(
    entity: string,
    o: { filter?: string[]; expand?: string; includeDeleted?: boolean } = {},
  ): Promise<VantageRecord[]> {
    const filters = [...(o.filter ?? [])];
    if (!o.includeDeleted) filters.unshift('deleteddate eq null');
    const out: VantageRecord[] = [];
    let top = defaultPageSize;
    let pagesFetched = 0;
    for (;;) {
      if (pagesFetched >= maxPages) {
        throw new ParseError(`Vantage ${entity} paging exceeded ${maxPages} pages`, 200);
      }
      const params: Record<string, string | number> = {
        $top: top,
        $skip: out.length,
        $orderby: 'Id',
        $count: 'true',
      };
      if (filters.length > 0) params.$filter = filters.map((f) => `(${f})`).join(' and ');
      if (o.expand) params.$expand = o.expand;
      const body = await get(entity, params);
      pagesFetched++;
      const items = Array.isArray(body) ? body : getField(body, 'value');
      if (!Array.isArray(items)) throw new ParseError(`Vantage ${entity} response has no value array`, 200);
      if (items.length === 0) return out;
      out.push(...(items as VantageRecord[]));
      const total = Array.isArray(body) ? null : getNumber(body, '@odata.count');
      if (total !== null) {
        if (out.length >= total) return out;
        if (items.length < top) top = items.length;
        continue;
      }
      if (items.length < top) return out;
    }
  }

  const listFilters = (o: ListOptions) =>
    o.since ? [`modifieddate gt ${o.since.toISOString()}`] : [];

  return {
    odataList,
    listCustomers: (o: ListOptions = {}) =>
      odataList('customer', { filter: listFilters(o), includeDeleted: o.includeDeleted }),
    listEquipment: (o: ListOptions = {}) =>
      odataList('Equipment', {
        filter: listFilters(o),
        includeDeleted: o.includeDeleted,
        expand: 'Item,Customer',
      }),
  };
}

export type VantageClient = ReturnType<typeof createVantageClient>;
