import { AuthError, HttpError, RateLimitError } from '@mps/core';
import { drmsRegistrations } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { VantageRecord } from '@mps/vantage';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms } from '../test-helpers';
import { runRegistrationScan } from './drms-registration-scan';

const NOW = new Date('2026-09-22T02:30:00Z');
const exclude = /tfc group/i;

/** A Discovered device's DRMS record that passes every DRMS-side rule. */
function raw(id: string, serial: string, extra: Record<string, unknown> = {}) {
  return {
    Id: id,
    Name: `Device ${id}`,
    SerialNumber: serial,
    Status: 'Discovered',
    CommunicationType: 'CSRC_HTTP',
    CsrcId: `csrc-${id}`,
    CsrcCenterId: 'GB500',
    CsrcProductId: `prod-${id}`,
    CsrcComServerId: 'COM_GB502',
    CsrcServiceOfficeId: 'OFC580',
    ErpId: null,
    CustomerErpId: 'CUST0001',
    CustomerName: 'Acme Widgets Ltd',
    ...extra,
  };
}

async function seedDevice(t: TestDb, id: string, serial: string, extra: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
  const r = raw(id, serial, extra);
  await seedDrms(t.db, [{ drmsId: id, serial, status: String(r.Status), raw: r, ...row }]);
}

const active = { StatusId: 1, IsOnHold: false, CancellationDate: null, DeletedDate: null };
function vEquipment(id: number, serial: string, extra: Record<string, unknown> = {}): VantageRecord {
  return {
    Id: id,
    SerialNumber: serial,
    Customer: { Id: 7, Reference: 'ACME', Name: 'Acme Widgets Limited' },
    Meters: [{ Charge: { Contract: active } }],
    ContractCharges: [],
    ...extra,
  };
}

/** Vantage lookups by serial: a table of answers, or an Error to throw. */
function fakeVantage(bySerial: Record<string, VantageRecord[] | Error>) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async findEquipmentBySerial(serial: string) {
        calls.push(serial);
        const answer = bySerial[serial] ?? [];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const rows = (t: TestDb) => t.db.select().from(drmsRegistrations).orderBy(asc(drmsRegistrations.id));

describe('runRegistrationScan', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const scan = (v: ReturnType<typeof fakeVantage>) =>
    runRegistrationScan({ db: t.db, vantage: v.client, excludeRegex: exclude, now: () => NOW });

  it('puts an eligible device in Awaiting approval with the exact payload, and sends nothing', async () => {
    await seedDevice(t, 'd1', 'SERIAL0000001');
    const v = fakeVantage({ SERIAL0000001: [vEquipment(4321, 'SERIAL0000001')] });
    const result = await scan(v);

    expect(result.status).toBe('success');
    expect(result.stats).toMatchObject({ candidates: 1, awaitingApproval: 1, waiting: 0 });
    const [row] = await rows(t);
    expect(row).toMatchObject({
      drmsEquipmentId: 'd1',
      serial: 'SERIAL0000001',
      deviceName: 'Device d1',
      drmsCustomerName: 'Acme Widgets Ltd',
      vantageEquipmentId: 4321,
      vantageCustomerId: 7,
      vantageCustomerName: 'Acme Widgets Limited',
      status: 'awaiting_approval',
      reason: null,
      customerMatch: 'match',
      requestId: null,
      submittedAt: null,
    });
    expect(row?.request).toMatchObject({ EquipmentErpId: '4321', EquipmentSerialNumber: 'SERIAL0000001', CustomerErpId: 'CUST0001' });
    expect(row?.checkedAt.toISOString()).toBe(NOW.toISOString());
  });

  it('records Waiting with the reason when a Vantage rule is not met', async () => {
    await seedDevice(t, 'd1', 'SERIAL0000001');
    await seedDevice(t, 'd2', 'SERIAL0000002');
    const v = fakeVantage({
      SERIAL0000001: [],
      SERIAL0000002: [vEquipment(5, 'SERIAL0000002', { Meters: [{ Charge: { Contract: { ...active, IsOnHold: true } } }] })],
    });
    const result = await scan(v);
    expect(result.stats).toMatchObject({ waiting: 2, awaitingApproval: 0 });
    const list = await rows(t);
    expect(list.map((r) => [r.drmsEquipmentId, r.status, r.reason, r.request])).toEqual([
      ['d1', 'waiting', 'No Vantage equipment with this serial yet', null],
      ['d2', 'waiting', 'No active contract on the Vantage equipment', null],
    ]);
    expect(list[1]).toMatchObject({ vantageEquipmentId: 5, vantageCustomerName: 'Acme Widgets Limited' });
  });

  it('never looks up or records devices that fail a DRMS rule, and counts why', async () => {
    await seedDevice(t, 'dca', 'SERIAL0000003', { CommunicationType: 'CSRC_DCA' });
    await seedDevice(t, 'stock', 'SERIAL0000004', { Name: 'Refurb stock' });
    await seedDevice(t, 'tfc', 'SERIAL0000005', { CustomerName: 'Primaflow TFC Group' });
    await seedDevice(t, 'reg', 'SERIAL0000006', { Status: 'Registered' });
    await seedDevice(t, 'gone', 'SERIAL0000007', {}, { missingSince: new Date('2026-09-20T00:00:00Z') });
    const v = fakeVantage({});
    const result = await scan(v);
    expect(v.calls).toEqual([]);
    expect(await rows(t)).toEqual([]);
    expect(result.stats).toMatchObject({ candidates: 0, skippedNotHttp: 1, skippedStockName: 1, skippedExcludedCustomer: 1 });
  });

  it('upserts the one live row each run: waiting becomes awaiting approval and back, with fresh details', async () => {
    await seedDevice(t, 'd1', 'SERIAL0000001');
    await scan(fakeVantage({ SERIAL0000001: [] }));
    await scan(fakeVantage({ SERIAL0000001: [vEquipment(4321, 'SERIAL0000001')] }));
    let list = await rows(t);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'awaiting_approval', reason: null, vantageEquipmentId: 4321 });

    await scan(fakeVantage({ SERIAL0000001: [vEquipment(4321, 'SERIAL0000001'), vEquipment(99, 'SERIAL0000001')] }));
    list = await rows(t);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'waiting', reason: '2 Vantage equipment records share this serial', request: null });
  });

  it('leaves approved, registered, failed and rejected devices alone (no lookup, no new row)', async () => {
    for (const [id, status] of [['a', 'approved'], ['r', 'registered'], ['f', 'failed'], ['x', 'rejected']] as const) {
      await seedDevice(t, id, `SERIAL000000${id}`.slice(0, 13));
      await t.db.insert(drmsRegistrations).values({ drmsEquipmentId: id, status });
    }
    const v = fakeVantage({});
    const result = await scan(v);
    expect(v.calls).toEqual([]);
    expect((await rows(t)).map((r) => r.status)).toEqual(['approved', 'registered', 'failed', 'rejected']);
    expect(result.stats).toMatchObject({ alreadyHandled: 4 });
  });

  it('removes queue rows for devices that are no longer candidates, keeping approved ones', async () => {
    await seedDevice(t, 'now-reg', 'SERIAL0000001', { Status: 'PreRegistered' }, { status: 'PreRegistered' });
    await seedDevice(t, 'approved', 'SERIAL0000002', { Status: 'PreRegistered' }, { status: 'PreRegistered' });
    await t.db.insert(drmsRegistrations).values([
      { drmsEquipmentId: 'now-reg', status: 'awaiting_approval' },
      { drmsEquipmentId: 'approved', status: 'approved' },
    ]);
    const result = await scan(fakeVantage({}));
    expect((await rows(t)).map((r) => [r.drmsEquipmentId, r.status])).toEqual([['approved', 'approved']]);
    expect(result.stats).toMatchObject({ removed: 1 });
  });

  it('keeps the live row untouched when the Vantage lookup fails, and reports partial', async () => {
    await seedDevice(t, 'd1', 'SERIAL0000001');
    await seedDevice(t, 'd2', 'SERIAL0000002');
    await scan(fakeVantage({ SERIAL0000001: [vEquipment(1, 'SERIAL0000001')] }));
    const result = await scan(
      fakeVantage({ SERIAL0000001: new HttpError('Vantage GET Equipment failed (500)', 500), SERIAL0000002: [vEquipment(2, 'SERIAL0000002')] }),
    );
    expect(result.status).toBe('partial');
    expect(result.stats).toMatchObject({ lookupErrors: 1, awaitingApproval: 1 });
    expect(result.errorSample).toContain('SERIAL0000001');
    const list = await rows(t);
    expect(list.map((r) => [r.drmsEquipmentId, r.status])).toEqual([
      ['d1', 'awaiting_approval'],
      ['d2', 'awaiting_approval'],
    ]);
  });

  it('stops the run on a Vantage auth failure', async () => {
    await seedDevice(t, 'd1', 'SERIAL0000001');
    await expect(scan(fakeVantage({ SERIAL0000001: new AuthError('Vantage loginsingle failed (401)', 401) }))).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('stops the run on a Vantage 429 without looking up anything more', async () => {
    await seedDevice(t, 'd1', 'SERIAL0000001');
    await seedDevice(t, 'd2', 'SERIAL0000002');
    const v = fakeVantage({ SERIAL0000001: new RateLimitError('Vantage returned 429', new Date()), SERIAL0000002: [] });
    await expect(scan(v)).rejects.toBeInstanceOf(RateLimitError);
    expect(v.calls).toEqual(['SERIAL0000001']);
  });

  it('flags a customer mismatch but still queues it for approval', async () => {
    await seedDevice(t, 'd1', 'SERIAL0000001', { CustomerName: 'Elmdale Maintenance Stock' });
    await scan(fakeVantage({ SERIAL0000001: [vEquipment(4321, 'SERIAL0000001')] }));
    const [row] = await t.db.select().from(drmsRegistrations).where(eq(drmsRegistrations.drmsEquipmentId, 'd1'));
    expect(row).toMatchObject({ status: 'awaiting_approval', customerMatch: 'mismatch' });
  });
});
