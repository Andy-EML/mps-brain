import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTER_EXCLUDE,
  autoRegisterEligibility,
  customerMatch,
  drmsCandidateCheck,
  type DrmsRegistrationRecord,
} from './registration';

const exclude = new RegExp(DEFAULT_REGISTER_EXCLUDE, 'i');

/** A Discovered CSRC_HTTP device that passes every DRMS-side rule. */
function device(extra: Partial<DrmsRegistrationRecord> = {}): DrmsRegistrationRecord {
  return {
    Id: 'drms-1',
    Name: 'Reception MFP',
    SerialNumber: 'A7PU021012345',
    Status: 'Discovered',
    CommunicationType: 'CSRC_HTTP',
    CsrcId: 'CSRC-1',
    CsrcCenterId: 'GB500',
    CsrcProductId: 'P-1',
    CsrcComServerId: 'COM_GB502',
    CsrcServiceOfficeId: 'OFC580',
    ErpId: null,
    CustomerErpId: 'CUST0001',
    CustomerName: 'Acme Widgets Ltd',
    ...extra,
  };
}

const activeContract = { Id: 9, Reference: 'CON1', StatusId: 1, IsOnHold: false, CancellationDate: null, DeletedDate: null };

/** One Vantage equipment with a customer and an active contract via Meters → Charge → Contract. */
function vantage(extra: Record<string, unknown> = {}) {
  return {
    Id: 4321,
    SerialNumber: 'A7PU021012345',
    Customer: { Id: 77, Reference: 'ACME01', Name: 'Acme Widgets Limited' },
    Meters: [{ TypeId: 1, Charge: { Id: 5, Contract: activeContract } }],
    ContractCharges: [],
    ...extra,
  };
}

describe('drmsCandidateCheck', () => {
  it('accepts a device that meets every DRMS rule', () => {
    expect(drmsCandidateCheck(device(), exclude)).toBeNull();
  });

  it.each([
    ['notDiscovered', { Status: 'PreRegistered' }],
    ['notDiscovered', { Status: 'Deleted' }],
    ['notHttp', { CommunicationType: 'CSRC_DCA' }],
    ['notHttp', { CsrcComServerId: 'COM_GB501' }],
    ['notHttp', { CsrcComServerId: 'DEFCNTCOM_GB500' }],
    ['erpIdSet', { ErpId: '12345' }],
    ['missingCsrc', { CsrcId: null }],
    ['missingCsrc', { CsrcProductId: '' }],
    ['missingCsrc', { SerialNumber: 'A7PU0210123' }],
    ['missingCsrc', { SerialNumber: null }],
    ['noCustomerCode', { CustomerErpId: null }],
    ['stockName', { Name: 'REFURB C300i' }],
    ['stockName', { Name: 'Unsold stock' }],
    ['stockName', { Name: 'Awaiting install' }],
    ['stockName', { Name: 'Demo unit' }],
    ['stockName', { Name: 'Loan machine' }],
    ['excludedCustomer', { CustomerName: 'Primaflow TFC Group' }],
    ['excludedCustomer', { Name: 'TFC GROUP office' }],
  ] as const)('rejects %s for %o', (code, extra) => {
    expect(drmsCandidateCheck(device(extra), exclude)).toMatchObject({ code });
  });

  it('accepts an ErpId that is a copy of the serial (normalised)', () => {
    expect(drmsCandidateCheck(device({ ErpId: 'a7pu-021012345' }), exclude)).toBeNull();
    expect(drmsCandidateCheck(device({ ErpId: '' }), exclude)).toBeNull();
  });

  it('accepts COM_GB503 and allows Abacus Direct now', () => {
    expect(drmsCandidateCheck(device({ CsrcComServerId: 'COM_GB503', CustomerName: 'Abacus Direct' }), exclude)).toBeNull();
  });

  it('uses the configured exclusion regex', () => {
    expect(drmsCandidateCheck(device(), /acme/i)).toMatchObject({ code: 'excludedCustomer' });
  });

  it('has no check-in rule: a device with no alarm or counter ever is still a candidate', () => {
    expect(drmsCandidateCheck(device({ LastAlarmReceivedTime: null, LastCounterReceivedTime: null }), exclude)).toBeNull();
  });
});

describe('customerMatch', () => {
  it('matches on one shared significant word', () => {
    expect(customerMatch('Acme Widgets Ltd', 'ACME (Head Office)')).toBe('match');
  });

  it('ignores stop words and words shorter than three letters', () => {
    expect(customerMatch('The School Group Ltd', 'Group Services Limited')).toBe('no_shared_words');
    expect(customerMatch('AB Co', 'AB Co')).toBe('no_shared_words');
  });

  it('flags a DRMS name showing Elmdale or stock when Vantage does not', () => {
    expect(customerMatch('Elmdale Maintenance', 'Acme Widgets')).toBe('mismatch');
    expect(customerMatch('STOCK machines', 'Acme')).toBe('mismatch');
    expect(customerMatch('Elmdale Maintenance', 'Elmdale Maintenance Ltd')).toBe('match');
  });

  it('treats missing names as not sharing words', () => {
    expect(customerMatch(null, 'Acme')).toBe('no_shared_words');
    expect(customerMatch('Acme', null)).toBe('no_shared_words');
  });
});

describe('autoRegisterEligibility', () => {
  it('builds the register.mjs payload with the Vantage equipment id as EquipmentErpId', () => {
    const r = autoRegisterEligibility(device(), [vantage()], exclude);
    expect(r).toEqual({
      ok: true,
      customerMatch: 'match',
      vantage: { equipmentId: 4321, customerId: 77, customerName: 'Acme Widgets Limited' },
      payload: {
        EquipmentErpId: '4321',
        EquipmentName: 'Reception MFP',
        EquipmentSerialNumber: 'A7PU021012345',
        EquipmentCommunicationType: 'CSRC_HTTP',
        EquipmentCsrcId: 'CSRC-1',
        EquipmentCsrcCenterId: 'GB500',
        EquipmentCsrcProductId: 'P-1',
        EquipmentCsrcComServerId: 'COM_GB502',
        EquipmentCsrcServiceOfficeId: 'OFC580',
        CustomerErpId: 'CUST0001',
        CustomerName: 'Acme Widgets Ltd',
      },
    });
  });

  it('stops at the DRMS rules before looking at Vantage', () => {
    expect(autoRegisterEligibility(device({ Status: 'Registered' }), [vantage()], exclude)).toMatchObject({
      ok: false,
      stage: 'drms',
      code: 'notDiscovered',
    });
  });

  it('waits when Vantage has no equipment with the serial (after normalising)', () => {
    expect(autoRegisterEligibility(device(), [], exclude)).toMatchObject({ ok: false, stage: 'vantage', code: 'noVantageMatch' });
    // Vantage `eq` may be looser than our key: a different serial in the response does not count.
    expect(autoRegisterEligibility(device(), [vantage({ SerialNumber: 'OTHER' })], exclude)).toMatchObject({ code: 'noVantageMatch' });
    // Dashes and case do not matter.
    expect(autoRegisterEligibility(device(), [vantage({ SerialNumber: 'a7pu-0210 12345' })], exclude)).toMatchObject({ ok: true });
  });

  it('waits when more than one Vantage equipment has the serial', () => {
    expect(autoRegisterEligibility(device(), [vantage(), vantage({ Id: 99 })], exclude)).toMatchObject({
      ok: false,
      stage: 'vantage',
      code: 'multipleVantageMatches',
    });
  });

  it('waits when the Vantage equipment has no customer', () => {
    expect(autoRegisterEligibility(device(), [vantage({ Customer: null })], exclude)).toMatchObject({ code: 'noVantageCustomer' });
  });

  it('waits when no contract is active (status, hold, cancellation, deletion)', () => {
    const withContract = (c: Record<string, unknown>) =>
      vantage({ Meters: [{ Charge: { Contract: { ...activeContract, ...c } } }] });
    for (const c of [{ StatusId: 2 }, { IsOnHold: true }, { CancellationDate: '2026-01-01' }, { DeletedDate: '2026-01-01' }]) {
      const r = autoRegisterEligibility(device(), [withContract(c)], exclude);
      expect(r).toMatchObject({ ok: false, stage: 'vantage', code: 'noActiveContract' });
      // What is known about the match is kept for the Waiting tab.
      expect(r).toMatchObject({ vantage: { equipmentId: 4321, customerName: 'Acme Widgets Limited' } });
    }
    expect(autoRegisterEligibility(device(), [vantage({ Meters: [], ContractCharges: [] })], exclude)).toMatchObject({
      code: 'noActiveContract',
    });
    expect(autoRegisterEligibility(device(), [vantage({ Meters: [{ Charge: null }] })], exclude)).toMatchObject({
      code: 'noActiveContract',
    });
  });

  it('finds an active contract through ContractCharges too', () => {
    const v = vantage({ Meters: [], ContractCharges: [{ Id: 1, Contract: activeContract }] });
    expect(autoRegisterEligibility(device(), [v], exclude)).toMatchObject({ ok: true });
  });

  it('keeps a customer mismatch eligible and flags it', () => {
    const r = autoRegisterEligibility(device({ CustomerName: 'Elmdale Maintenance' }), [vantage()], exclude);
    expect(r).toMatchObject({ ok: true, customerMatch: 'mismatch' });
  });

  it('sends empty strings for missing optional DRMS fields, as register.mjs did from its CSV', () => {
    const r = autoRegisterEligibility(device({ CsrcCenterId: null, CsrcServiceOfficeId: undefined }), [vantage()], exclude);
    expect(r.ok && r.payload).toMatchObject({ EquipmentCsrcCenterId: '', EquipmentCsrcServiceOfficeId: '' });
  });

  it('reads Vantage fields case-insensitively', () => {
    const v = {
      id: 4321,
      serialNumber: 'A7PU021012345',
      customer: { id: 77, name: 'Acme' },
      contractCharges: [{ contract: { statusId: 1, isOnHold: false } }],
    };
    expect(autoRegisterEligibility(device(), [v], exclude)).toMatchObject({ ok: true, payload: { EquipmentErpId: '4321' } });
  });
});
