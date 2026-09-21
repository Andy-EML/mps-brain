import { getField, getNumber, getString, normaliseSerial } from './fields';

/**
 * The rules for proposing a newly connected machine for DRMS registration (spec: "auto-register
 * new machines in DRMS", REVISED — an approval queue). Ported from the batch selector the user and
 * KM settled on while registering ~550 devices by hand on 2026-09-21
 * (`F:\dev\API Docs Etc\DRMS registration batches\select-batch.mjs`), minus its check-in rule:
 * DRMS has no heartbeat for Discovered devices, so "no recent alarm" says nothing about a machine.
 *
 * Pure: the scan job feeds it the DRMS record (from `drms_equipment.raw`) and the live Vantage
 * lookup by serial, and records the verdict.
 */

/** The COM servers our directly-connected machines use (GB501 is unused; DCA devices are out). */
export const REGISTER_COM_SERVERS: readonly string[] = ['COM_GB502', 'COM_GB503'];

/** Customers the user asked not to register: Primaflow TFC Group. Abacus Direct is allowed now. */
export const DEFAULT_REGISTER_EXCLUDE = 'tfc group';

const STOCK_NAME = /refurb|unsold|awaiting|demo|loan/i;

/** The fields of a DRMS `Equipment` record the rules read. Extra fields are ignored. */
export interface DrmsRegistrationRecord {
  Id: string;
  Name?: string | null;
  SerialNumber?: string | null;
  Status?: string | null;
  CommunicationType?: string | null;
  CsrcId?: string | null;
  CsrcCenterId?: string | null;
  CsrcProductId?: string | null;
  CsrcComServerId?: string | null;
  CsrcServiceOfficeId?: string | null;
  ErpId?: string | null;
  CustomerErpId?: string | null;
  CustomerName?: string | null;
  [key: string]: unknown;
}

/** The `EquipmentRequest/Register` body, exactly as `register.mjs` sent it. */
export interface RegisterPayload {
  EquipmentErpId: string;
  EquipmentName: string;
  EquipmentSerialNumber: string;
  EquipmentCommunicationType: string;
  EquipmentCsrcId: string;
  EquipmentCsrcCenterId: string;
  EquipmentCsrcProductId: string;
  EquipmentCsrcComServerId: string;
  EquipmentCsrcServiceOfficeId: string;
  CustomerErpId: string;
  CustomerName: string;
}

/** Why a device is not a registration candidate at all (it never reaches the queue). */
export type DrmsSkipCode =
  | 'notDiscovered'
  | 'notHttp'
  | 'erpIdSet'
  | 'missingCsrc'
  | 'noCustomerCode'
  | 'stockName'
  | 'excludedCustomer';

/** Why a candidate is *Waiting*: a Vantage-side rule not met yet, re-checked every scan. */
export type VantageWaitCode = 'noVantageMatch' | 'multipleVantageMatches' | 'noVantageCustomer' | 'noActiveContract';

/**
 * `match` — the DRMS and Vantage customer names share a significant word; `mismatch` — DRMS still
 * shows the device on Elmdale/stock and Vantage does not; `no_shared_words` — a possible mismatch.
 * Only a flag: the user decided mismatches are registered, and the approver sees it.
 */
export type CustomerMatch = 'match' | 'mismatch' | 'no_shared_words';

export interface VantageMatchInfo {
  equipmentId: number;
  customerId: number | null;
  customerName: string | null;
}

export type EligibilityResult =
  | { ok: true; payload: RegisterPayload; customerMatch: CustomerMatch; vantage: VantageMatchInfo }
  | { ok: false; stage: 'drms'; code: DrmsSkipCode; reason: string }
  | { ok: false; stage: 'vantage'; code: VantageWaitCode; reason: string; vantage?: VantageMatchInfo };

const SKIP_REASON: Record<DrmsSkipCode, string> = {
  notDiscovered: 'Not Discovered in DRMS',
  notHttp: 'Not a direct CSRC_HTTP connection on COM_GB502/COM_GB503',
  erpIdSet: 'DRMS already has a different ErpId',
  missingCsrc: 'DRMS record lacks CsrcId, CsrcProductId or a 13-character serial',
  noCustomerCode: 'DRMS record has no customer code',
  stockName: 'Name marks it as refurb, unsold, awaiting, demo or loan stock',
  excludedCustomer: 'Excluded customer',
};

const blank = (s: string | null | undefined) => s == null || s.trim() === '';

/** The DRMS-side rules, checked before any Vantage lookup. `null` = a candidate. */
export function drmsCandidateCheck(
  e: DrmsRegistrationRecord,
  excludeRegex: RegExp,
): { code: DrmsSkipCode; reason: string } | null {
  const skip = (code: DrmsSkipCode) => ({ code, reason: SKIP_REASON[code] });
  if (e.Status !== 'Discovered') return skip('notDiscovered');
  if (e.CommunicationType !== 'CSRC_HTTP' || !REGISTER_COM_SERVERS.includes(e.CsrcComServerId ?? '')) return skip('notHttp');
  // An ErpId that is neither empty nor a copy of the serial was set by someone else: leave it.
  if (!blank(e.ErpId) && normaliseSerial(e.ErpId) !== normaliseSerial(e.SerialNumber)) return skip('erpIdSet');
  if (blank(e.CsrcId) || blank(e.CsrcProductId) || (e.SerialNumber ?? '').length !== 13) return skip('missingCsrc');
  if (blank(e.CustomerErpId)) return skip('noCustomerCode');
  if (STOCK_NAME.test(e.Name ?? '')) return skip('stockName');
  if (excludeRegex.test(`${e.Name ?? ''} ${e.CustomerName ?? ''}`)) return skip('excludedCustomer');
  return null;
}

const STOP_WORDS = new Set(['LTD', 'LIMITED', 'THE', 'UK', 'GROUP', 'PLC', 'AND', 'CO', 'COMPANY', 'SERVICES', 'SCHOOL']);

function words(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/** Whether the DRMS-held customer name plausibly is the Vantage customer (select-batch's rule). */
export function customerMatch(drmsName: string | null | undefined, vantageName: string | null | undefined): CustomerMatch {
  if (/elmdale|stock/i.test(drmsName ?? '') && !/elmdale|stock/i.test(vantageName ?? '')) return 'mismatch';
  const b = words(vantageName);
  for (const w of words(drmsName)) if (b.has(w)) return 'match';
  return 'no_shared_words';
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Active = status 1, not on hold, not cancelled, not deleted. */
function isActiveContract(c: unknown): boolean {
  if (c == null || typeof c !== 'object') return false;
  return (
    getNumber(c, 'StatusId') === 1 &&
    getField(c, 'IsOnHold') !== true &&
    blank(getString(c, 'CancellationDate')) &&
    blank(getString(c, 'DeletedDate'))
  );
}

/** Contracts reachable from the equipment: Meters → Charge → Contract, and ContractCharges → Contract. */
function contractsOf(v: unknown): unknown[] {
  return [
    ...asArray(getField(v, 'Meters')).map((m) => getField(getField(m, 'Charge'), 'Contract')),
    ...asArray(getField(v, 'ContractCharges')).map((c) => getField(c, 'Contract')),
  ].filter((c) => c != null);
}

/**
 * The full verdict for one device. `vantageMatches` is the Vantage `Equipment` lookup by serial
 * (not deleted, with Customer and contracts expanded — `findEquipmentBySerial`); rows whose serial
 * does not normalise to the device's are dropped, as the batch selector did.
 */
export function autoRegisterEligibility(
  e: DrmsRegistrationRecord,
  vantageMatches: readonly unknown[],
  excludeRegex: RegExp,
): EligibilityResult {
  const skip = drmsCandidateCheck(e, excludeRegex);
  if (skip) return { ok: false, stage: 'drms', ...skip };

  const serial = normaliseSerial(e.SerialNumber);
  const rows = vantageMatches.filter((v) => normaliseSerial(getString(v, 'SerialNumber')) === serial);
  if (rows.length === 0) {
    return { ok: false, stage: 'vantage', code: 'noVantageMatch', reason: 'No Vantage equipment with this serial yet' };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      stage: 'vantage',
      code: 'multipleVantageMatches',
      reason: `${rows.length} Vantage equipment records share this serial`,
    };
  }

  const v = rows[0];
  const equipmentId = getNumber(v, 'Id');
  if (equipmentId === null) {
    return { ok: false, stage: 'vantage', code: 'noVantageMatch', reason: 'The Vantage equipment has no Id' };
  }
  const customer = getField(v, 'Customer');
  const info: VantageMatchInfo = {
    equipmentId,
    customerId: getNumber(customer, 'Id'),
    customerName: getString(customer, 'Name'),
  };
  if (customer == null || typeof customer !== 'object') {
    return { ok: false, stage: 'vantage', code: 'noVantageCustomer', reason: 'The Vantage equipment has no customer', vantage: info };
  }
  if (!contractsOf(v).some(isActiveContract)) {
    return {
      ok: false,
      stage: 'vantage',
      code: 'noActiveContract',
      reason: 'No active contract on the Vantage equipment',
      vantage: info,
    };
  }

  const payload: RegisterPayload = {
    EquipmentErpId: String(equipmentId),
    EquipmentName: e.Name ?? '',
    EquipmentSerialNumber: e.SerialNumber ?? '',
    EquipmentCommunicationType: e.CommunicationType ?? '',
    EquipmentCsrcId: e.CsrcId ?? '',
    EquipmentCsrcCenterId: e.CsrcCenterId ?? '',
    EquipmentCsrcProductId: e.CsrcProductId ?? '',
    EquipmentCsrcComServerId: e.CsrcComServerId ?? '',
    EquipmentCsrcServiceOfficeId: e.CsrcServiceOfficeId ?? '',
    CustomerErpId: e.CustomerErpId ?? '',
    CustomerName: e.CustomerName ?? '',
  };
  return { ok: true, payload, customerMatch: customerMatch(e.CustomerName, info.customerName), vantage: info };
}
