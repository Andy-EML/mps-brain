import { AuthError, HttpError, ParseError, RateLimitError, UncertainWriteError, errorMessage } from '@mps/core';
import type { z } from 'zod';
import { MethodLimiter } from './limiter';
import {
  drmsAlarmsEntrySchema,
  drmsCustomerSchema,
  drmsEquipmentRequestSchema,
  drmsEquipmentSchema,
  drmsLatestCountersSchema,
  type DrmsCustomer,
  type DrmsEquipment,
  type DrmsEquipmentRequest,
  type DrmsFlatAlarm,
  type DrmsLatestCounters,
} from './schemas';

export const DRMS_PAGE_SIZE = 1000;
/** Confirmed in Phase 0 findings (spec). */
export const FIRST_PAGE_NO = 1;
/** Verified live 2026-09-18: a longer range returns HTTP 400 (max 1 day). */
export const MAX_ALARM_RANGE_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Formats a Date as DRMS's `YYYY-MM-DD HH:mm:ss` UTC, used for dateFrom/dateTo query params. */
export function formatDrmsDateTime(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

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

  /**
   * The one DRMS write this project makes: `POST EquipmentRequest/Register`. Never retried, not even
   * after a 401 — unlike Vantage, DRMS auth is a static token, so a 401 will not fix itself.
   * A 5xx, a timeout or a dropped connection may still have created the request, so it surfaces as
   * `UncertainWriteError` for a person to check in DRMS before anything is sent again.
   */
  async function postJson(method: string, path: string, body: unknown): Promise<unknown> {
    await limiter.acquire(method);
    let res: Response;
    try {
      res = await doFetch(new URL(`${base}/${path}`), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UncertainWriteError(`DRMS POST ${method}: no response (${errorMessage(err)})`, null);
    }
    if (res.status === 429) {
      const until = limiter.tripCooldown(method);
      throw new RateLimitError(`DRMS ${method} returned 429`, until);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`DRMS ${method} auth failed (${res.status})`, res.status);
    }
    const text = await res.text();
    if (res.status >= 500) throw new UncertainWriteError(`DRMS POST ${method} failed (${res.status})`, res.status, text.slice(0, 500));
    if (!res.ok) throw new HttpError(`DRMS POST ${method} failed (${res.status})`, res.status, text.slice(0, 500));
    try {
      return text.trim() === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      // Accepted, but we cannot read what it accepted: that is as uncertain as no answer at all.
      throw new UncertainWriteError(`DRMS POST ${method} returned non-JSON`, res.status, text.slice(0, 500));
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
    /** One device, e.g. the registration pre-check (`Status` must still be Discovered). */
    async getEquipment(equipmentId: string): Promise<DrmsEquipment> {
      const body = await requestJson('Equipment/{id}', `Equipment/${encodeURIComponent(equipmentId)}`);
      return parseItem('Equipment/{id}', drmsEquipmentSchema, body);
    },
    /**
     * Registers a Discovered device (the approved `drms-registration-submit` job only). Returns the
     * **equipment request id** — DRMS answers with a bare JSON string (older builds: `{ Id }`);
     * the outcome comes later from `getEquipmentRequest`. Throws `UncertainWriteError` when the
     * request may exist without us knowing its id; never re-send one.
     */
    async registerEquipment(payload: Record<string, unknown>): Promise<string> {
      const body = await postJson('EquipmentRequest/Register', 'EquipmentRequest/Register', payload);
      const id = typeof body === 'string' ? body : typeof (body as { Id?: unknown } | null)?.Id === 'string' ? (body as { Id: string }).Id : null;
      if (!id) {
        throw new UncertainWriteError('DRMS accepted the register request but returned no request id', 200, JSON.stringify(body).slice(0, 500));
      }
      return id;
    },
    /** The state of a register request: poll until `Status` is final or `ErrorMessage` is set. */
    async getEquipmentRequest(requestId: string): Promise<DrmsEquipmentRequest> {
      const body = await requestJson('EquipmentRequest/{id}', `EquipmentRequest/${encodeURIComponent(requestId)}`);
      return parseItem('EquipmentRequest/{id}', drmsEquipmentRequestSchema, body);
    },
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
    /**
     * Alarms for all equipment in [dateFrom, dateTo]. DRMS rejects a range over 1 day (HTTP 400),
     * so this validates that client-side and throws `HttpError`; callers that need to catch up a
     * longer gap must split it into per-day calls (see the drms-alarms worker job).
     */
    async listAlarms(params: { dateFrom: Date; dateTo: Date }): Promise<DrmsFlatAlarm[]> {
      const { dateFrom, dateTo } = params;
      if (dateTo.getTime() - dateFrom.getTime() > MAX_ALARM_RANGE_MS) {
        throw new HttpError(
          'DRMS Equipment/Alarms range exceeded the 1-day maximum allowed by the API',
          400,
        );
      }
      const out: DrmsFlatAlarm[] = [];
      const seen = new Set<string>();
      for (let pageNo = FIRST_PAGE_NO; ; pageNo++) {
        const body = await requestJson('Equipment/Alarms', 'Equipment/Alarms', {
          dateFrom: formatDrmsDateTime(dateFrom),
          dateTo: formatDrmsDateTime(dateTo),
          pageNo,
        });
        if (body === null) return out;
        if (!Array.isArray(body)) throw new ParseError('DRMS Equipment/Alarms did not return an array', 200);
        let added = 0;
        for (const raw of body) {
          const entry = parseItem('Equipment/Alarms', drmsAlarmsEntrySchema, raw);
          if (seen.has(entry.Id)) continue;
          seen.add(entry.Id);
          added++;
          for (const alarm of entry.Alarms ?? []) out.push({ ...alarm, EquipmentId: entry.Id });
        }
        if (body.length < DRMS_PAGE_SIZE || added === 0) return out;
      }
    },
  };
}

export type DrmsClient = ReturnType<typeof createDrmsClient>;
