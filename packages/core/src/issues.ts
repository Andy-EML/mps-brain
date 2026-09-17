import {
  issueKey,
  type ActiveLink,
  type DrmsDeviceInput,
  type PlannedIssue,
  type VantageDeviceInput,
} from './linking';

export interface StoredIssue {
  id: number;
  key: string;
  status: 'open' | 'resolved' | 'ignored';
}

export interface IssueChanges {
  toInsert: PlannedIssue[];
  toReopen: { id: number; issue: PlannedIssue }[];
  toTouch: number[];
  toResolve: number[];
}

export function reconcileIssues(stored: StoredIssue[], planned: PlannedIssue[]): IssueChanges {
  const storedByKey = new Map(stored.map((s) => [s.key, s]));
  const plannedByKey = new Map<string, PlannedIssue>();
  for (const p of planned) {
    const key = issueKey(p);
    if (!plannedByKey.has(key)) plannedByKey.set(key, p);
  }
  const changes: IssueChanges = { toInsert: [], toReopen: [], toTouch: [], toResolve: [] };
  for (const [key, p] of plannedByKey) {
    const s = storedByKey.get(key);
    if (!s) changes.toInsert.push(p);
    else if (s.status === 'resolved') changes.toReopen.push({ id: s.id, issue: p });
    else changes.toTouch.push(s.id);
  }
  for (const s of stored) {
    if (s.status === 'open' && !plannedByKey.has(s.key)) changes.toResolve.push(s.id);
  }
  return changes;
}

export interface DerivedCustomerLink {
  customerErpId: string;
  vantageCustomerId: number;
  deviceCount: number;
}

export function deriveCustomerLinks(
  links: ActiveLink[],
  drms: DrmsDeviceInput[],
  vantage: VantageDeviceInput[],
): DerivedCustomerLink[] {
  const drmsById = new Map(drms.map((d) => [d.drmsId, d]));
  const vantageById = new Map(vantage.map((v) => [v.vantageId, v]));
  const counts = new Map<string, Map<number, number>>();
  for (const link of links) {
    const erp = drmsById.get(link.drmsId)?.customerErpId?.trim();
    const customerId = vantageById.get(link.vantageId)?.customerId;
    if (!erp || customerId == null) continue;
    const perCustomer = counts.get(erp) ?? new Map<number, number>();
    perCustomer.set(customerId, (perCustomer.get(customerId) ?? 0) + 1);
    counts.set(erp, perCustomer);
  }
  const result: DerivedCustomerLink[] = [];
  for (const [customerErpId, perCustomer] of counts) {
    let best: { id: number; n: number } | null = null;
    for (const [id, n] of perCustomer) {
      if (!best || n > best.n || (n === best.n && id < best.id)) best = { id, n };
    }
    if (best) result.push({ customerErpId, vantageCustomerId: best.id, deviceCount: best.n });
  }
  return result.sort((a, b) => a.customerErpId.localeCompare(b.customerErpId));
}
