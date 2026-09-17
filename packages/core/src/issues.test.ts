import { describe, expect, it } from 'vitest';
import { deriveCustomerLinks, reconcileIssues, type StoredIssue } from './issues';
import type { DrmsDeviceInput, PlannedIssue, VantageDeviceInput } from './linking';

const issue = (type: PlannedIssue['type'], drmsId: string | null, vantageId: number | null): PlannedIssue => ({
  type,
  drmsId,
  vantageId,
  details: {},
});

describe('reconcileIssues', () => {
  it('inserts new, touches open/ignored, reopens resolved, resolves vanished', () => {
    const stored: StoredIssue[] = [
      { id: 1, key: 'no_match_drms|d1|', status: 'open' },
      { id: 2, key: 'no_match_drms|d2|', status: 'ignored' },
      { id: 3, key: 'no_match_drms|d3|', status: 'resolved' },
      { id: 4, key: 'no_match_drms|d4|', status: 'open' },
      { id: 5, key: 'no_match_drms|d5|', status: 'ignored' },
    ];
    const planned = [
      issue('no_match_drms', 'd1', null),
      issue('no_match_drms', 'd2', null),
      issue('no_match_drms', 'd3', null),
      issue('no_match_drms', 'd9', null),
      issue('no_match_drms', 'd9', null),
    ];
    const changes = reconcileIssues(stored, planned);
    expect(changes.toInsert).toEqual([issue('no_match_drms', 'd9', null)]);
    expect(changes.toTouch).toEqual([1, 2]);
    expect(changes.toReopen).toEqual([{ id: 3, issue: issue('no_match_drms', 'd3', null) }]);
    expect(changes.toResolve).toEqual([4]);
  });
});

describe('deriveCustomerLinks', () => {
  const drms = (drmsId: string, customerErpId: string | null): DrmsDeviceInput => ({
    drmsId,
    customerErpId,
    erpId: null,
    serialNorm: null,
    status: 'Registered',
    missing: false,
  });
  const vantage = (vantageId: number, customerId: number | null): VantageDeviceInput => ({
    vantageId,
    customerId,
    assetNumber: null,
    serialNorm: null,
    customerReference: null,
    deleted: false,
  });

  it('picks the most common Vantage customer per DRMS customer ERP id', () => {
    const result = deriveCustomerLinks(
      [
        { drmsId: 'a', vantageId: 1, method: 'serial' },
        { drmsId: 'b', vantageId: 2, method: 'serial' },
        { drmsId: 'c', vantageId: 3, method: 'erp_id' },
        { drmsId: 'd', vantageId: 4, method: 'serial' },
        { drmsId: 'e', vantageId: 5, method: 'serial' },
        { drmsId: 'f', vantageId: 6, method: 'serial' },
      ],
      [drms('a', ' C1 '), drms('b', 'C1'), drms('c', 'C1'), drms('d', 'C2'), drms('e', 'C2'), drms('f', '')],
      [vantage(1, 100), vantage(2, 100), vantage(3, 200), vantage(4, 300), vantage(5, 250), vantage(6, 999)],
    );
    expect(result).toEqual([
      { customerErpId: 'C1', vantageCustomerId: 100, deviceCount: 2 },
      { customerErpId: 'C2', vantageCustomerId: 250, deviceCount: 1 },
    ]);
  });
});
