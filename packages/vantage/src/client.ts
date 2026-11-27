import { AuthError, HttpError, ParseError, getField, getNumber, getString, noteSearchWord, odataString, parseApiDate } from '@mps/core';

export interface VantageClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  apiVersion: string;
  fetch?: typeof fetch;
  now?: () => number;
  pageSize?: number;
  maxPages?: number;
  /** Per-request timeout; default 60 s. */
  timeoutMs?: number;
}

export interface ListOptions {
  since?: Date;
  includeDeleted?: boolean;
}

export interface SalesOrderListOptions extends ListOptions {
  /**
   * Floor on `OrderDate`. The first run has no `since` to work from, and without this it would drag
   * in a decade of order history.
   */
  orderDateFrom?: Date;
}

/**
 * Lines with their item, plus the order type, in one call. `Type.Name` is either `Consumable order`
 * or `Equipment deal`, and the item select keeps the payload to the three fields the UI shows.
 */
const SALES_ORDER_EXPAND = 'Lines($expand=Item($select=Id,PartNumber,Description)),Type($select=Id,Name)';

export interface MeterReadingListOptions {
  /** Floor on `ReadingDateTime`: the app only ever keeps the last 12 months. */
  readingFrom: Date;
  /** Ceiling on `ReadingDateTime`; some entered readings carry a date in the future (typos). */
  readingTo?: Date;
  /** Only readings created or modified after this (incremental sync). */
  since?: Date;
}

/** Contract fields the DRMS registration rules read (`autoRegisterEligibility` in @mps/core). */
const CONTRACT_SELECT = '$select=Id,Reference,StatusId,ExpiryDate,IsEvergreen,IsOnHold,CancellationDate,DeletedDate';
/**
 * Customer plus every contract reachable from the equipment, through its meters' charges and its
 * contract charges — the exact expand the hand-run batch selector used on 2026-09-21.
 */
const CONTRACTS_EXPAND =
  `Meters($select=TypeId;$expand=Charge($select=Id;$expand=Contract(${CONTRACT_SELECT})))` +
  `,ContractCharges($select=Id;$expand=Contract(${CONTRACT_SELECT}))`;
const REGISTRATION_EXPAND = `Customer($select=Id,Reference,Name),${CONTRACTS_EXPAND}`;

const WORK_UNIT_EXPAND =
  'Work($select=Id,Reference,EquipmentId,CustomerId,CompletedDate,DeletedDate),' +
  'Category($select=Id,Name;$expand=Type($select=Id,Name)),' +
  'WorkItems($select=Id,ItemId,Quantity,Status;$expand=Item($select=PartNumber,Description))';

export interface WorkUnitListOptions {
  /** Floor on the unit's work start, logged or scheduled start date. */
  from: Date;
  /** Only units modified after this (incremental sync). */
  since?: Date;
}

/**
 * `SalesOrder.OrderDate` is an `Edm.Date`, not an `Edm.DateTimeOffset`: comparing it to a full
 * timestamp makes Vantage answer 400 ("incompatible types"). Confirmed against the live API,
 * 2026-09-18.
 */
const odataDate = (d: Date) => d.toISOString().slice(0, 10);

export interface ScheduledWorkUnitListOptions {
  /** Inclusive floor on `ScheduledStartDate`. */
  from: Date;
  /** Exclusive ceiling on `ScheduledStartDate`. */
  to: Date;
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
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const timeoutMs = opts.timeoutMs ?? 60_000;
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
      signal: AbortSignal.timeout(timeoutMs),
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
        signal: AbortSignal.timeout(timeoutMs),
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
    o: { filter?: string[]; select?: string; expand?: string; includeDeleted?: boolean } = {},
  ): Promise<VantageRecord[]> {
    const filters = [...(o.filter ?? [])];
    if (!o.includeDeleted) filters.unshift('deleteddate eq null');
    const out: VantageRecord[] = [];
    let lastId: number | null = null;
    let pagesFetched = 0;
    for (;;) {
      if (pagesFetched >= maxPages) {
        throw new ParseError(`Vantage ${entity} paging exceeded ${maxPages} pages`, 200);
      }
      // Keyset paging: stable under concurrent inserts/deletes, unlike $skip.
      const pageFilters = lastId === null ? filters : [...filters, `Id gt ${lastId}`];
      const params: Record<string, string | number> = { $top: pageSize, $orderby: 'Id' };
      if (pageFilters.length > 0) params.$filter = pageFilters.map((f) => `(${f})`).join(' and ');
      if (o.select) params.$select = o.select;
      if (o.expand) params.$expand = o.expand;
      const body = await get(entity, params);
      pagesFetched++;
      const items = Array.isArray(body) ? body : getField(body, 'value');
      if (!Array.isArray(items)) throw new ParseError(`Vantage ${entity} response has no value array`, 200);
      if (items.length === 0) return out;
      out.push(...(items as VantageRecord[]));
      if (items.length < pageSize) return out;
      lastId = getNumber(items[items.length - 1], 'Id');
      if (lastId === null) throw new ParseError(`Vantage ${entity} record without Id; cannot page`, 200);
    }
  }

  /**
   * `$skip`/`$top` paging for a bound function, which has no `Id` to keyset on. Rows repeated across
   * pages (the result can shift under concurrent edits) are dropped by `Id`.
   */
  async function skipList(path: string, limit?: number): Promise<VantageRecord[]> {
    const out: VantageRecord[] = [];
    const seen = new Set<number>();
    const top = limit === undefined ? pageSize : Math.max(1, Math.min(pageSize, limit));
    for (let page = 0; ; page++) {
      if (page >= maxPages) throw new ParseError(`Vantage ${path} paging exceeded ${maxPages} pages`, 200);
      const body = await get(path, { $top: top, $skip: page * top });
      const items = Array.isArray(body) ? body : getField(body, 'value');
      if (!Array.isArray(items)) throw new ParseError(`Vantage ${path} response has no value array`, 200);
      for (const item of items as VantageRecord[]) {
        const id = getNumber(item, 'Id');
        if (id !== null) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        out.push(item);
      }
      if (limit !== undefined && out.length >= limit) return out.slice(0, limit);
      if (items.length < top) return out;
    }
  }

  const listFilters = (o: ListOptions) => {
    if (!o.since) return [];
    const since = o.since.toISOString();
    return [`modifieddate gt ${since} or createddate gt ${since} or deleteddate gt ${since}`];
  };

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
    /** Read-only. */
    listSalesOrders: (o: SalesOrderListOptions = {}) =>
      odataList('SalesOrder', {
        filter: [
          ...listFilters(o),
          ...(o.orderDateFrom ? [`orderdate ge ${odataDate(o.orderDateFrom)}`] : []),
        ],
        includeDeleted: o.includeDeleted,
        expand: SALES_ORDER_EXPAND,
      }),
    /**
     * Read-only. `MeterReading` has no `DeletedDate` (a 400 if filtered on), so this lists it with
     * `includeDeleted` set purely to skip the client's automatic `deleteddate eq null`.
     */
    listMeterReadings: (o: MeterReadingListOptions) => {
      const filter = [`readingdatetime ge ${o.readingFrom.toISOString()}`];
      if (o.readingTo) filter.push(`readingdatetime le ${o.readingTo.toISOString()}`);
      if (o.since) {
        const since = o.since.toISOString();
        filter.push(`modifieddate gt ${since} or createddate gt ${since}`);
      }
      return odataList('MeterReading', { filter, includeDeleted: true });
    },
    /** Read-only: every live Equipment with just the contracts reachable from it (PM due contract flag). */
    listEquipmentContracts: () => odataList('Equipment', { select: 'Id', expand: CONTRACTS_EXPAND }),
    /**
     * Read-only. `WorkUnit` has no `DeletedDate` (a 400 if filtered on), so it is listed with
     * `includeDeleted` to skip the automatic `deleteddate eq null`; callers drop units whose
     * `Work.DeletedDate` is set.
     */
    listWorkUnits: (o: WorkUnitListOptions) => {
      const from = o.from.toISOString();
      const filter = [`workstartdate ge ${from} or loggeddate ge ${from} or scheduledstartdate ge ${from}`];
      if (o.since) filter.push(`modifieddate gt ${o.since.toISOString()}`);
      return odataList('WorkUnit', { filter, includeDeleted: true, expand: WORK_UNIT_EXPAND });
    },
    /**
     * Read-only: work units scheduled in [from, to). `WorkUnit.EngineerId` (checked live,
     * 2026-11-23: present on every scheduled unit; `Work` has no engineer field) comes with the
     * unit itself, so the expand is the same as `listWorkUnits`. No `DeletedDate` on `WorkUnit`:
     * callers drop units whose `Work.DeletedDate` is set.
     */
    listScheduledWorkUnits: (o: ScheduledWorkUnitListOptions) =>
      odataList('WorkUnit', {
        filter: [`scheduledstartdate ge ${o.from.toISOString()} and scheduledstartdate lt ${o.to.toISOString()}`],
        includeDeleted: true,
        expand: WORK_UNIT_EXPAND,
      }),
    /** Read-only: live engineers (`Id`, `Name`, `IsActive`). */
    listEngineers: () => odataList('Engineer'),
    /**
     * Read-only: every live `CustomerPerson` (site contact: name, role, phone, extension, mobile,
     * email, IsPrimary), keyset-paged with `deleteddate eq null`. About 1,700 rows (2026-11-27).
     */
    listCustomerPeople: () => odataList('customerperson'),
    /** Read-only: the dozen `MeterType`s with their class (Mono/Colour), deleted ones included. */
    listMeterTypes: () => odataList('MeterType', { includeDeleted: true, expand: 'Class($select=Id,Name)' }),
    /**
     * Read-only: notes matching one search word, every page (`GET /user/GetNotesViaKeyword`). Rows
     * are `NoteSearchResultComponent`s (Id, ParentId, ParentType, ParentReference, Text, IsAlert,
     * LoggedDate, LoggedBy, …) of every parent kind, alert or not; callers filter. Stopwords
     * return nothing. The word must be 2-50 characters: an empty search is a 400, so it is refused
     * here before any call. `limit` stops after that many rows (the web app's live search).
     */
    async searchNotes(word: string, o: { limit?: number } = {}): Promise<VantageRecord[]> {
      const w = noteSearchWord(word);
      if (w === null) throw new ParseError('Vantage note search needs a word of 2 to 50 characters', null);
      return skipList(`user/GetNotesViaKeyword(search=${encodeURIComponent(odataString(w))})`, o.limit);
    },
    /**
     * Read-only: the live Vantage equipment with this serial (not deleted), with its customer and
     * contracts, for the DRMS registration scan. Not paged — a serial matches a handful at most.
     */
    async findEquipmentBySerial(serial: string): Promise<VantageRecord[]> {
      const body = await get('Equipment', {
        $filter: `(serialnumber eq '${serial.replace(/'/g, "''")}') and (deleteddate eq null)`,
        $select: 'Id,SerialNumber,AssetNumber,CollectionMethod',
        $expand: REGISTRATION_EXPAND,
      });
      const items = Array.isArray(body) ? body : getField(body, 'value');
      if (!Array.isArray(items)) throw new ParseError('Vantage Equipment response has no value array', 200);
      return items as VantageRecord[];
    },
  };
}

export type VantageClient = ReturnType<typeof createVantageClient>;
