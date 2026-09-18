import { describe, expect, it } from 'vitest';
import {
  computeLinks,
  diffLinks,
  issueKey,
  type ActiveLink,
  type DrmsDeviceInput,
  type LinkConfig,
  type LinkPlan,
  type VantageDeviceInput,
} from './linking';

const cfg: LinkConfig = { erpIdField: 'id', customerErpField: 'reference' };
const d = (o: Partial<DrmsDeviceInput> & { drmsId: string }): DrmsDeviceInput => ({
  erpId: null,
  serialNorm: null,
  status: 'Registered',
  customerErpId: null,
  missing: false,
  ...o,
});
const v = (o: Partial<VantageDeviceInput> & { vantageId: number }): VantageDeviceInput => ({
  assetNumber: null,
  serialNorm: null,
  customerId: null,
  customerReference: null,
  deleted: false,
  ...o,
});
const ofType = (plan: LinkPlan, type: string) => plan.issues.filter((i) => i.type === type);

describe('computeLinks', () => {
  it('links by ERP id against Vantage Id', () => {
    const plan = computeLinks([d({ drmsId: 'd1', erpId: '10' })], [v({ vantageId: 10 })], [], cfg);
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'erp_id' }]);
    expect(plan.issues).toEqual([]);
  });

  it('links by ERP id against AssetNumber when configured', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: 'eq-500' })],
      [v({ vantageId: 10, assetNumber: 'EQ-500' })],
      [],
      { ...cfg, erpIdField: 'assetNumber' },
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'erp_id' }]);
  });

  it('links by serial when there is no ERP id match', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: 'unknown', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'serial' }]);
  });

  it('flags ambiguous serials without linking', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', serialNorm: 'A1' })],
      [v({ vantageId: 11, serialNorm: 'A1' }), v({ vantageId: 10, serialNorm: 'A1' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(ofType(plan, 'serial_ambiguous')).toEqual([
      { type: 'serial_ambiguous', drmsId: 'd1', vantageId: null, details: { vantageIds: [10, 11] } },
    ]);
    expect(ofType(plan, 'no_match_vantage')).toHaveLength(2);
  });

  it('keeps the ERP link and flags when serial disagrees', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', serialNorm: 'B2' })],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 11, serialNorm: 'B2' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 10, method: 'erp_id' }]);
    expect(ofType(plan, 'erp_serial_disagree')).toEqual([
      { type: 'erp_serial_disagree', drmsId: 'd1', vantageId: 10, details: { serialVantageId: 11 } },
    ]);
  });

  it('raises no_match_drms for Registered, PreRegistered and Discovered', () => {
    const plan = computeLinks(
      [
        d({ drmsId: 'd1', status: 'Registered', serialNorm: 'X' }),
        d({ drmsId: 'd2', status: 'PreRegistered' }),
        d({ drmsId: 'd3', status: 'Discovered' }),
      ],
      [],
      [],
      cfg,
    );
    expect(ofType(plan, 'no_match_drms').map((i) => i.drmsId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('never overwrites a manual link', () => {
    const existing: ActiveLink[] = [{ drmsId: 'd1', vantageId: 20, method: 'manual' }];
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 20 })],
      existing,
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 20, method: 'manual' }]);
    expect(ofType(plan, 'no_match_vantage').map((i) => i.vantageId)).toEqual([10]);
  });

  it('breaks a manual link whose Vantage target was deleted', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1' })],
      [v({ vantageId: 20, deleted: true })],
      [{ drmsId: 'd1', vantageId: 20, method: 'manual' }],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(ofType(plan, 'link_broken')).toEqual([
      { type: 'link_broken', drmsId: 'd1', vantageId: 20, details: { reason: 'vantage_deleted' } },
    ]);
  });

  it('breaks links for missing or deleted DRMS devices', () => {
    const plan = computeLinks(
      [
        d({ drmsId: 'd1', missing: true, serialNorm: 'A1' }),
        d({ drmsId: 'd2', status: 'Deleted', serialNorm: 'B2' }),
      ],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 11, serialNorm: 'B2' })],
      [
        { drmsId: 'd1', vantageId: 10, method: 'serial' },
        { drmsId: 'd2', vantageId: 11, method: 'erp_id' },
      ],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(ofType(plan, 'link_broken')).toEqual([
      { type: 'link_broken', drmsId: 'd1', vantageId: 10, details: { reason: 'drms_missing', status: 'Registered' } },
      { type: 'link_broken', drmsId: 'd2', vantageId: 11, details: { reason: 'drms_status', status: 'Deleted' } },
    ]);
  });

  it('breaks an auto link whose Vantage target was deleted', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1', deleted: true })],
      [{ drmsId: 'd1', vantageId: 10, method: 'serial' }],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(plan.issues).toContainEqual({
      type: 'link_broken',
      drmsId: 'd1',
      vantageId: 10,
      details: { reason: 'vantage_deleted' },
    });
    expect(ofType(plan, 'no_match_vantage')).toEqual([]);
  });

  it('gives a contested Vantage record to ERP over serial, then lowest drmsId', () => {
    const plan = computeLinks(
      [
        d({ drmsId: 'a-serial', serialNorm: 'A1' }),
        d({ drmsId: 'z-erp', erpId: '10' }),
        d({ drmsId: 'b-serial', serialNorm: 'B2' }),
        d({ drmsId: 'c-serial', serialNorm: 'B2' }),
      ],
      [v({ vantageId: 10, serialNorm: 'A1' }), v({ vantageId: 11, serialNorm: 'B2' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([
      { drmsId: 'z-erp', vantageId: 10, method: 'erp_id' },
      { drmsId: 'b-serial', vantageId: 11, method: 'serial' },
    ]);
    expect(ofType(plan, 'duplicate_target')).toEqual([
      { type: 'duplicate_target', drmsId: 'a-serial', vantageId: 10, details: { linkedDrmsId: 'z-erp', method: 'serial' } },
      { type: 'duplicate_target', drmsId: 'c-serial', vantageId: 11, details: { linkedDrmsId: 'b-serial', method: 'serial' } },
    ]);
  });

  it('ignores an ERP id that is just a copy of the serial, but still matches by serial', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: ' 12345 ', serialNorm: '12345' })],
      [v({ vantageId: 12345, serialNorm: 'OTHER' }), v({ vantageId: 99, serialNorm: '12345' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'd1', vantageId: 99, method: 'serial' }]);
    expect(ofType(plan, 'erp_serial_disagree')).toEqual([]);
  });

  it('gives a contested serial to a Registered device over a Discovered one', () => {
    const plan = computeLinks(
      [
        d({ drmsId: 'a-discovered', serialNorm: 'S1', status: 'Discovered' }),
        d({ drmsId: 'b-preregistered', serialNorm: 'S1', status: 'PreRegistered' }),
        d({ drmsId: 'c-registered', serialNorm: 'S1', status: 'Registered' }),
      ],
      [v({ vantageId: 10, serialNorm: 'S1' })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([{ drmsId: 'c-registered', vantageId: 10, method: 'serial' }]);
    expect(ofType(plan, 'duplicate_target').map((i) => i.drmsId)).toEqual(['b-preregistered', 'a-discovered']);
  });

  it('flags customer mismatch by reference, by id, and not when a side is empty', () => {
    const drms = [
      d({ drmsId: 'd1', erpId: '10', customerErpId: 'cust1' }),
      d({ drmsId: 'd2', erpId: '11', customerErpId: 'CUST9' }),
      d({ drmsId: 'd3', erpId: '12', customerErpId: null }),
    ];
    const vantage = [
      v({ vantageId: 10, customerId: 1, customerReference: 'CUST1' }),
      v({ vantageId: 11, customerId: 2, customerReference: 'CUST2' }),
      v({ vantageId: 12, customerId: 3, customerReference: 'CUST3' }),
    ];
    const byRef = computeLinks(drms, vantage, [], cfg);
    expect(ofType(byRef, 'customer_mismatch')).toEqual([
      {
        type: 'customer_mismatch',
        drmsId: 'd2',
        vantageId: 11,
        details: { drmsCustomerErpId: 'CUST9', vantageCustomerId: 2, vantageCustomerReference: 'CUST2' },
      },
    ]);
    const byId = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', customerErpId: '1' })],
      vantage,
      [],
      { ...cfg, customerErpField: 'id' },
    );
    expect(ofType(byId, 'customer_mismatch')).toEqual([]);
    const disabled = computeLinks(drms, vantage, [], { ...cfg, customerErpField: 'none' });
    expect(ofType(disabled, 'customer_mismatch')).toEqual([]);
  });

  it('does not match deleted Vantage records or report them as unmatched', () => {
    const plan = computeLinks(
      [d({ drmsId: 'd1', erpId: '10', serialNorm: 'A1' })],
      [v({ vantageId: 10, serialNorm: 'A1', deleted: true })],
      [],
      cfg,
    );
    expect(plan.links).toEqual([]);
    expect(plan.issues.map((i) => i.type)).toEqual(['no_match_drms']);
  });
});

describe('diffLinks', () => {
  it('keeps identical links, closes changed ones, creates new ones', () => {
    const existing = [
      { id: 1, drmsId: 'd1', vantageId: 10, method: 'serial' as const },
      { id: 2, drmsId: 'd2', vantageId: 11, method: 'serial' as const },
      { id: 3, drmsId: 'd3', vantageId: 12, method: 'serial' as const },
    ];
    const desired: ActiveLink[] = [
      { drmsId: 'd1', vantageId: 10, method: 'serial' },
      { drmsId: 'd2', vantageId: 11, method: 'erp_id' },
      { drmsId: 'd4', vantageId: 13, method: 'serial' },
    ];
    const diff = diffLinks(existing, desired);
    expect(diff.toClose.map((l) => l.id)).toEqual([2, 3]);
    expect(diff.toCreate).toEqual([
      { drmsId: 'd2', vantageId: 11, method: 'erp_id' },
      { drmsId: 'd4', vantageId: 13, method: 'serial' },
    ]);
  });
});

describe('issueKey', () => {
  it('builds a stable key with empty parts for nulls', () => {
    expect(issueKey({ type: 'no_match_drms', drmsId: 'd1', vantageId: null })).toBe('no_match_drms|d1|');
    expect(issueKey({ type: 'no_match_vantage', drmsId: null, vantageId: 7 })).toBe('no_match_vantage||7');
  });
});
