import { normaliseKey } from './fields';

export type LinkMethod = 'erp_id' | 'serial' | 'manual';
export type IssueType =
  | 'no_match_drms'
  | 'no_match_vantage'
  | 'serial_ambiguous'
  | 'erp_serial_disagree'
  | 'customer_mismatch'
  | 'link_broken'
  | 'duplicate_target';

export interface DrmsDeviceInput {
  drmsId: string;
  erpId: string | null;
  serialNorm: string | null;
  status: string | null;
  customerErpId: string | null;
  missing: boolean;
}

export interface VantageDeviceInput {
  vantageId: number;
  assetNumber: string | null;
  serialNorm: string | null;
  customerId: number | null;
  customerReference: string | null;
  deleted: boolean;
}

export interface ActiveLink {
  drmsId: string;
  vantageId: number;
  method: LinkMethod;
}

export interface LinkConfig {
  erpIdField: 'id' | 'assetNumber';
  /** 'none' disables customer_mismatch checks. */
  customerErpField: 'id' | 'reference' | 'none';
}

export interface PlannedIssue {
  type: IssueType;
  drmsId: string | null;
  vantageId: number | null;
  details: Record<string, unknown>;
}

export interface LinkPlan {
  links: ActiveLink[];
  issues: PlannedIssue[];
}

const LINKABLE_STATUSES = new Set(['REGISTERED', 'PREREGISTERED', 'DISCOVERED']);
const METHOD_RANK: Record<LinkMethod, number> = { manual: 0, erp_id: 1, serial: 2 };
const STATUS_RANK: Record<string, number> = { REGISTERED: 0, PREREGISTERED: 1, DISCOVERED: 2 };

interface Candidate extends ActiveLink {
  statusRank: number;
}

function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function computeLinks(
  drms: DrmsDeviceInput[],
  vantage: VantageDeviceInput[],
  existing: ActiveLink[],
  config: LinkConfig,
): LinkPlan {
  const issues: PlannedIssue[] = [];
  const vantageById = new Map(vantage.map((x) => [x.vantageId, x]));
  const activeVantage = vantage.filter((x) => !x.deleted);
  const byErpKey = new Map<string, VantageDeviceInput[]>();
  const bySerial = new Map<string, VantageDeviceInput[]>();
  for (const x of activeVantage) {
    const key = normaliseKey(config.erpIdField === 'id' ? x.vantageId : x.assetNumber);
    if (key) addTo(byErpKey, key, x);
    if (x.serialNorm) addTo(bySerial, x.serialNorm, x);
  }
  const existingByDrms = new Map(existing.map((l) => [l.drmsId, l]));
  const candidates: Candidate[] = [];

  for (const device of drms) {
    const current = existingByDrms.get(device.drmsId);
    const status = (device.status ?? '').toUpperCase();
    const statusRank = STATUS_RANK[status] ?? Number.MAX_SAFE_INTEGER;

    if (device.missing || !LINKABLE_STATUSES.has(status)) {
      if (current) {
        issues.push({
          type: 'link_broken',
          drmsId: device.drmsId,
          vantageId: current.vantageId,
          details: { reason: device.missing ? 'drms_missing' : 'drms_status', status: device.status },
        });
      }
      continue;
    }

    if (current?.method === 'manual') {
      const target = vantageById.get(current.vantageId);
      if (target && !target.deleted) candidates.push({ ...current, statusRank });
      else
        issues.push({
          type: 'link_broken',
          drmsId: device.drmsId,
          vantageId: current.vantageId,
          details: { reason: 'vantage_deleted' },
        });
      continue;
    }

    // DRMS often copies the serial into ErpId; such a value is not a real ERP key.
    const rawErpKey = normaliseKey(device.erpId);
    const erpKey = rawErpKey !== null && rawErpKey === device.serialNorm ? null : rawErpKey;
    const erpMatches = erpKey ? (byErpKey.get(erpKey) ?? []) : [];
    const serialMatches = device.serialNorm ? (bySerial.get(device.serialNorm) ?? []) : [];
    // Ambiguous ERP key (duplicate AssetNumbers) falls through to serial matching.
    const erpMatch = erpMatches.length === 1 ? erpMatches[0] : undefined;

    if (erpMatch) {
      candidates.push({ drmsId: device.drmsId, vantageId: erpMatch.vantageId, method: 'erp_id', statusRank });
      const serialMatch = serialMatches.length === 1 ? serialMatches[0] : undefined;
      if (serialMatch && serialMatch.vantageId !== erpMatch.vantageId) {
        issues.push({
          type: 'erp_serial_disagree',
          drmsId: device.drmsId,
          vantageId: erpMatch.vantageId,
          details: { serialVantageId: serialMatch.vantageId },
        });
      }
    } else if (serialMatches.length === 1) {
      candidates.push({
        drmsId: device.drmsId,
        vantageId: (serialMatches[0] as VantageDeviceInput).vantageId,
        method: 'serial',
        statusRank,
      });
    } else if (serialMatches.length > 1) {
      issues.push({
        type: 'serial_ambiguous',
        drmsId: device.drmsId,
        vantageId: null,
        details: { vantageIds: serialMatches.map((x) => x.vantageId).sort((a, b) => a - b) },
      });
    } else {
      issues.push({
        type: 'no_match_drms',
        drmsId: device.drmsId,
        vantageId: null,
        details: { erpId: device.erpId, serialNorm: device.serialNorm },
      });
    }

    if (current) {
      const target = vantageById.get(current.vantageId);
      if (!target || target.deleted) {
        issues.push({
          type: 'link_broken',
          drmsId: device.drmsId,
          vantageId: current.vantageId,
          details: { reason: 'vantage_deleted' },
        });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      METHOD_RANK[a.method] - METHOD_RANK[b.method] ||
      a.statusRank - b.statusRank ||
      a.drmsId.localeCompare(b.drmsId),
  );
  const holderByVantage = new Map<number, string>();
  const links: ActiveLink[] = [];
  for (const c of candidates) {
    const holder = holderByVantage.get(c.vantageId);
    if (holder !== undefined) {
      issues.push({
        type: 'duplicate_target',
        drmsId: c.drmsId,
        vantageId: c.vantageId,
        details: { linkedDrmsId: holder, method: c.method },
      });
      continue;
    }
    holderByVantage.set(c.vantageId, c.drmsId);
    links.push({ drmsId: c.drmsId, vantageId: c.vantageId, method: c.method });
  }

  const drmsById = new Map(drms.map((x) => [x.drmsId, x]));
  for (const link of config.customerErpField === 'none' ? [] : links) {
    const device = drmsById.get(link.drmsId) as DrmsDeviceInput;
    const target = vantageById.get(link.vantageId) as VantageDeviceInput;
    const drmsCustomer = normaliseKey(device.customerErpId);
    const vantageCustomer = normaliseKey(
      config.customerErpField === 'id' ? target.customerId : target.customerReference,
    );
    if (drmsCustomer && vantageCustomer && drmsCustomer !== vantageCustomer) {
      issues.push({
        type: 'customer_mismatch',
        drmsId: link.drmsId,
        vantageId: link.vantageId,
        details: {
          drmsCustomerErpId: device.customerErpId,
          vantageCustomerId: target.customerId,
          vantageCustomerReference: target.customerReference,
        },
      });
    }
  }

  for (const x of activeVantage) {
    if (!holderByVantage.has(x.vantageId)) {
      issues.push({
        type: 'no_match_vantage',
        drmsId: null,
        vantageId: x.vantageId,
        details: { serialNorm: x.serialNorm },
      });
    }
  }

  return { links, issues };
}

const linkId = (l: ActiveLink) => `${l.drmsId}|${l.vantageId}|${l.method}`;

export function diffLinks<E extends ActiveLink>(
  existing: E[],
  desired: ActiveLink[],
): { toCreate: ActiveLink[]; toClose: E[] } {
  const desiredIds = new Set(desired.map(linkId));
  const existingIds = new Set(existing.map(linkId));
  return {
    toClose: existing.filter((l) => !desiredIds.has(linkId(l))),
    toCreate: desired.filter((l) => !existingIds.has(linkId(l))),
  };
}

export function issueKey(issue: {
  type: string;
  drmsId: string | null;
  vantageId: number | null;
}): string {
  return `${issue.type}|${issue.drmsId ?? ''}|${issue.vantageId ?? ''}`;
}
