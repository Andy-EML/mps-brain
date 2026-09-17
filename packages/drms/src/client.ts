import { AuthError, HttpError, ParseError, RateLimitError } from '@mps/core';
import type { z } from 'zod';
import { MethodLimiter } from './limiter';
import {
  drmsCustomerSchema,
  drmsEquipmentSchema,
  drmsLatestCountersSchema,
  type DrmsCustomer,
  type DrmsEquipment,
  type DrmsLatestCounters,
} from './schemas';

export const DRMS_PAGE_SIZE = 1000;
/** Confirmed in Phase 0 findings (spec). */
export const FIRST_PAGE_NO = 1;

export interface DrmsClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  limiter?: MethodLimiter;
  /** Per-request timeout; default 60 s. */
  timeoutMs?: number;
}

export function createDrmsClient(opts: DrmsClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const limiter = opts.limiter ?? new MethodLimiter(1000, 10 * 60_000);
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 60_000;

  async function requestText(
    method: string,
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<string> {
    await limiter.acquire(method);
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 429) {
      const until = limiter.tripCooldown(method);
      throw new RateLimitError(`DRMS ${method} returned 429`, until);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`DRMS ${method} auth failed (${res.status})`, res.status);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(`DRMS ${method} failed (${res.status})`, res.status, text.slice(0, 500));
    return text;
  }

  async function requestJson(method: string, path: string, query?: Record<string, string | number>) {
    const text = await requestText(method, path, query);
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ParseError(`DRMS ${method} returned non-JSON`, 200, text.slice(0, 500));
    }
  }

  function parseItem<T>(method: string, schema: z.ZodType<T>, item: unknown): T {
    const result = schema.safeParse(item);
    if (!result.success) {
      throw new ParseError(`DRMS ${method} item failed validation: ${result.error.message}`, 200);
    }
    return result.data;
  }

  async function listPaged<T extends { Id: string }>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    for (let pageNo = FIRST_PAGE_NO; ; pageNo++) {
      const body = await requestJson(method, path, { pageNo });
      if (body === null) return out;
      if (!Array.isArray(body)) throw new ParseError(`DRMS ${method} did not return an array`, 200);
      let added = 0;
      for (const raw of body) {
        const item = parseItem(method, schema, raw);
        if (seen.has(item.Id)) continue;
        seen.add(item.Id);
        out.push(item);
        added++;
      }
      if (body.length < DRMS_PAGE_SIZE || added === 0) return out;
    }
  }

  return {
    testAuth: () => requestText('Test/Auth', 'Test/Auth'),
    listEquipment: (): Promise<DrmsEquipment[]> =>
      listPaged('Equipment', 'Equipment', drmsEquipmentSchema),
    listCustomers: (): Promise<DrmsCustomer[]> =>
      listPaged('Customer', 'Customer', drmsCustomerSchema),
    /** null when DRMS has no counters: empty body, or 404 (Discovered devices return 404 — Phase 0). */
    async latestCounters(equipmentId: string): Promise<DrmsLatestCounters | null> {
      let body: unknown;
      try {
        body = await requestJson(
          'LatestCounters',
          `Equipment/${encodeURIComponent(equipmentId)}/LatestCounters`,
        );
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
      return body === null ? null : parseItem('LatestCounters', drmsLatestCountersSchema, body);
    },
  };
}

export type DrmsClient = ReturnType<typeof createDrmsClient>;
