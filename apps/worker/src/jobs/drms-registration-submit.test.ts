import { AuthError, HttpError, RateLimitError, UncertainWriteError } from '@mps/core';
import { drmsRegistrations, users } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { DrmsEquipment, DrmsEquipmentRequest } from '@mps/drms';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDrms } from '../test-helpers';
import { runRegistrationSubmit } from './drms-registration-submit';

const NOW = new Date('2026-09-22T09:00:00Z');

type Call = { method: 'getEquipment' | 'registerEquipment' | 'getEquipmentRequest' | 'sleep'; arg: unknown };

/**
 * A scripted DRMS: per-device status answers for `getEquipment` (in order; the last repeats),
 * per-device register outcomes, and per-request poll answers. Every call is recorded in order.
 */
function fakeDrms(script: {
  status?: Record<string, (string | Error)[]>;
  register?: Record<string, string | Error>;
  polls?: Record<string, (Partial<DrmsEquipmentRequest> | Error)[]>;
  /** Live fields overriding the defaults (which match the approved payload). */
  record?: Record<string, Partial<DrmsEquipment>>;
}) {
  const calls: Call[] = [];
  const seen: Record<string, number> = {};
  const next = <T>(key: string, list: T[] | undefined): T | undefined => {
    if (!list || list.length === 0) return undefined;
    const i = seen[key] ?? 0;
    seen[key] = i + 1;
    return list[Math.min(i, list.length - 1)];
  };
  return {
    calls,
    sends: () => calls.filter((c) => c.method === 'registerEquipment'),
    client: {
      async getEquipment(id: string): Promise<DrmsEquipment> {
        calls.push({ method: 'getEquipment', arg: id });
        const s = next(`eq:${id}`, script.status?.[id]) ?? 'Discovered';
        if (s instanceof Error) throw s;
        return {
          Id: id,
          Status: s,
          ErpId: s === 'PreRegistered' ? '4321' : null,
          SerialNumber: `SER-${id}`,
          CsrcId: `csrc-SER-${id}`,
          CustomerErpId: 'CUST0001',
          ...script.record?.[id],
        };
      },
      async registerEquipment(payload: Record<string, unknown>): Promise<string> {
        calls.push({ method: 'registerEquipment', arg: payload });
        const serial = String(payload.EquipmentSerialNumber);
        const r = script.register?.[serial] ?? `req-${serial}`;
        if (r instanceof Error) throw r;
        return r;
      },
      async getEquipmentRequest(id: string): Promise<DrmsEquipmentRequest> {
        calls.push({ method: 'getEquipmentRequest', arg: id });
        const p = next(`req:${id}`, script.polls?.[id]) ?? { Status: 'ProcessedSuccessful' };
        if (p instanceof Error) throw p;
        return { Id: id, ...p };
      },
    },
  };
}

const payload = (serial: string) => ({
  EquipmentErpId: '4321',
  EquipmentSerialNumber: serial,
  EquipmentCsrcId: `csrc-${serial}`,
  CustomerErpId: 'CUST0001',
});

describe('runRegistrationSubmit', () => {
  let t: TestDb;
  let userId: number;
  let sleeps: number[];
  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
    userId = u!.id;
    sleeps = [];
  });
  afterEach(() => t.close());

  async function approved(id: string, extra: Partial<typeof drmsRegistrations.$inferInsert> = {}) {
    const serial = `SER-${id}`;
    await seedDrms(t.db, [{ drmsId: id, serial, status: 'Discovered' }]);
    const [row] = await t.db
      .insert(drmsRegistrations)
      .values({ drmsEquipmentId: id, serial, status: 'approved', request: payload(serial), decidedBy: userId, decidedAt: NOW, ...extra })
      .returning();
    return row!;
  }

  const rows = () => t.db.select().from(drmsRegistrations).orderBy(asc(drmsRegistrations.id));

  const run = (drms: ReturnType<typeof fakeDrms>, o: { maxPerRun?: number; pauseSeconds?: number } = {}) =>
    runRegistrationSubmit({
      db: t.db,
      drms: drms.client,
      now: () => NOW,
      sleep: async (ms) => {
        sleeps.push(ms);
        // Also in the call log, so a test can see where each pause falls.
        drms.calls.push({ method: 'sleep', arg: ms });
      },
      pauseSeconds: o.pauseSeconds ?? 90,
      maxPerRun: o.maxPerRun ?? 40,
      pollIntervalMs: 30_000,
      maxPolls: 3,
    });

  it('pre-checks, registers, polls to ProcessedSuccessful and records the DRMS status after', async () => {
    await approved('d1');
    const drms = fakeDrms({ status: { d1: ['Discovered', 'PreRegistered'] }, polls: { 'req-SER-d1': [{ Status: 'Processing' }, { Status: 'ProcessedSuccessful' }] } });
    const result = await run(drms);

    expect(drms.calls.map((c) => c.method)).toEqual([
      'getEquipment',
      'registerEquipment',
      'sleep',
      'getEquipmentRequest',
      'sleep',
      'getEquipmentRequest',
      'getEquipment',
    ]);
    expect(drms.sends()[0]?.arg).toEqual(payload('SER-d1'));
    // Waits 30 s before each poll of a request it has just sent.
    expect(sleeps).toEqual([30_000, 30_000]);
    const [row] = await rows();
    expect(row).toMatchObject({
      status: 'registered',
      requestId: 'req-SER-d1',
      drmsStatusAfter: 'PreRegistered (ErpId 4321)',
      error: null,
      response: { Id: 'req-SER-d1', Status: 'ProcessedSuccessful' },
    });
    expect(row?.submittedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.finishedAt?.toISOString()).toBe(NOW.toISOString());
    expect(result).toMatchObject({ status: 'success', stats: { sent: 1, registered: 1, failed: 0 } });
  });

  it('sends one at a time with the pause between registrations, up to the cap', async () => {
    for (const id of ['d1', 'd2', 'd3']) await approved(id);
    const drms = fakeDrms({});
    const result = await run(drms, { maxPerRun: 2 });

    const order = drms.calls.map(
      (c) => `${c.method}:${typeof c.arg === 'object' ? (c.arg as { EquipmentSerialNumber: string }).EquipmentSerialNumber : String(c.arg)}`,
    );
    // d1 is fully finished (polled, status after) before d2 is touched; the 90 s pause comes
    // before d2's pre-check, so the live read is immediately before the POST. d3 is over the cap.
    expect(order).toEqual([
      'getEquipment:d1',
      'registerEquipment:SER-d1',
      'sleep:30000',
      'getEquipmentRequest:req-SER-d1',
      'getEquipment:d1',
      'sleep:90000',
      'getEquipment:d2',
      'registerEquipment:SER-d2',
      'sleep:30000',
      'getEquipmentRequest:req-SER-d2',
      'getEquipment:d2',
    ]);
    expect(sleeps).toEqual([30_000, 90_000, 30_000]);
    expect((await rows()).map((r) => r.status)).toEqual(['registered', 'registered', 'approved']);
    expect(result.stats).toMatchObject({ sent: 2, registered: 2 });
  });

  it('waits out the pause since the last registration of an earlier run', async () => {
    await approved('old', { status: 'registered', submittedAt: new Date(NOW.getTime() - 30_000), requestId: 'r0' });
    await approved('d1');
    await run(fakeDrms({}));
    expect(sleeps[0]).toBe(60_000);
  });

  it('skips a device whose pre-check read fails, sending nothing for it', async () => {
    await approved('d1');
    await approved('d2');
    const drms = fakeDrms({ status: { d1: [new HttpError('DRMS Equipment/{id} failed (500)', 500)] } });
    const result = await run(drms);
    expect(drms.sends().map((c) => (c.arg as { EquipmentSerialNumber: string }).EquipmentSerialNumber)).toEqual(['SER-d2']);
    const list = await rows();
    expect(list[0]).toMatchObject({ status: 'approved', submittedAt: null, requestId: null });
    expect(list[1]).toMatchObject({ status: 'registered' });
    expect(result).toMatchObject({ status: 'partial', stats: { precheckFailed: 1, sent: 1 } });
  });

  it('does not send when DRMS no longer shows the device as Discovered', async () => {
    await approved('d1');
    const drms = fakeDrms({ status: { d1: ['PreRegistered'] } });
    await run(drms);
    expect(drms.sends()).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ status: 'failed', drmsStatusAfter: 'PreRegistered', requestId: null });
    expect((await rows())[0]?.error).toContain('not sent');
  });

  it('records failed with the message when DRMS rejects the register request', async () => {
    await approved('d1');
    const drms = fakeDrms({ register: { 'SER-d1': new HttpError('DRMS POST failed (400)', 400, '"Serial number already exists"') } });
    const result = await run(drms);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed', requestId: null, response: { status: 400, body: '"Serial number already exists"' } });
    expect(row?.error).toContain('Serial number already exists');
    expect(drms.sends()).toHaveLength(1);
    expect(result.stats).toMatchObject({ failed: 1 });
  });

  it('records an uncertain send as failed and never re-sends it', async () => {
    await approved('d1');
    const drms = fakeDrms({ register: { 'SER-d1': new UncertainWriteError('DRMS POST failed (503)', 503, 'boom') } });
    await run(drms);
    const [row] = await rows();
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/check DRMS/i);
    await run(drms);
    expect(drms.sends()).toHaveLength(1);
  });

  it('records failed when the poll ends with an ErrorMessage (e.g. a Backbone deadlock)', async () => {
    await approved('d1');
    const drms = fakeDrms({
      status: { d1: ['Discovered', 'Deleted'] },
      polls: { 'req-SER-d1': [{ Status: 'Processing' }, { Status: 'Processing', ErrorMessage: 'Backbone: Transaction was deadlocked' }] },
    });
    const result = await run(drms);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed', requestId: 'req-SER-d1', drmsStatusAfter: 'Deleted (ErpId )' });
    expect(row?.error).toContain('Backbone: Transaction was deadlocked');
    expect(result.stats).toMatchObject({ failed: 1, registered: 0 });
  });

  it('records failed on a fail/error/reject status without a message', async () => {
    await approved('d1');
    await run(fakeDrms({ polls: { 'req-SER-d1': [{ Status: 'ProcessedWithError' }] } }));
    expect((await rows())[0]).toMatchObject({ status: 'failed', error: 'ProcessedWithError' });
  });

  it('keeps polling through a failed poll read', async () => {
    await approved('d1');
    await run(fakeDrms({ polls: { 'req-SER-d1': [new HttpError('boom', 500), { Status: 'ProcessedSuccessful' }] } }));
    expect((await rows())[0]).toMatchObject({ status: 'registered' });
  });

  it('leaves a request still processing after the poll window approved, then only polls it next run', async () => {
    await approved('d1');
    const drms = fakeDrms({ polls: { 'req-SER-d1': [{ Status: 'Processing' }, { Status: 'Processing' }, { Status: 'Processing' }, { Status: 'ProcessedSuccessful' }] } });
    const first = await run(drms);
    expect((await rows())[0]).toMatchObject({ status: 'approved', requestId: 'req-SER-d1' });
    expect(first.stats).toMatchObject({ stillProcessing: 1 });

    sleeps = [];
    const second = await run(drms);
    expect(drms.sends()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: 'registered' });
    // A resumed poll asks straight away, without re-sending or waiting first.
    expect(sleeps).toEqual([]);
    expect(second.stats).toMatchObject({ resumed: 1, sent: 0, registered: 1 });
  });

  it('only polls a row that already has a request id, never re-sends it', async () => {
    await approved('d1', { requestId: 'req-existing', submittedAt: new Date(NOW.getTime() - 3_600_000) });
    const drms = fakeDrms({ polls: { 'req-existing': [{ Status: 'ProcessedSuccessful' }] } });
    await run(drms);
    expect(drms.sends()).toHaveLength(0);
    expect(drms.calls.map((c) => c.method)).toEqual(['getEquipmentRequest', 'getEquipment']);
    expect((await rows())[0]).toMatchObject({ status: 'registered', requestId: 'req-existing' });
  });

  it('marks a send interrupted before its id was saved as failed, without re-sending', async () => {
    await approved('d1', { submittedAt: new Date(NOW.getTime() - 600_000) });
    const drms = fakeDrms({});
    const result = await run(drms);
    expect(drms.calls).toEqual([]);
    expect(sleeps).toEqual([]);
    const [row] = await rows();
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/may or may not/);
    expect(result.stats).toMatchObject({ uncertain: 1 });
  });

  it('stops starting new sends once the wall-clock budget cannot fit one more (pause + max polls), leaving the rest approved for the next run', async () => {
    for (const id of ['d1', 'd2']) await approved(id);
    // A fake clock that advances with every simulated sleep, so elapsed wall time in the run
    // tracks the pauses and poll waits exactly as the real job would experience them.
    let clockMs = NOW.getTime();
    const clockNow = () => new Date(clockMs);
    const drms = fakeDrms({});
    const result = await runRegistrationSubmit({
      db: t.db,
      drms: drms.client,
      now: clockNow,
      sleep: async (ms) => {
        clockMs += ms;
        sleeps.push(ms);
        drms.calls.push({ method: 'sleep', arg: ms });
      },
      pauseSeconds: 90,
      maxPerRun: 40,
      pollIntervalMs: 30_000,
      maxPolls: 3,
      // Worst case per send: 90s pause + 3 * 30s polling = 180s. d1's own send only actually
      // takes 30s (one poll to ProcessedSuccessful), so 200s leaves enough for d1 (0 + 180 <=
      // 200) but not for a second send afterwards (30 + 180 > 200).
      budgetMs: 200_000,
    });
    expect(drms.sends()).toHaveLength(1);
    expect(result.stats).toMatchObject({ sent: 1, registered: 1, budgetStopped: true });
    const list = await rows();
    expect(list[0]).toMatchObject({ status: 'registered' });
    expect(list[1]).toMatchObject({ status: 'approved', submittedAt: null, requestId: null });
  });

  it('does not budget-stop when no budgetMs is given', async () => {
    for (const id of ['d1', 'd2']) await approved(id);
    const result = await run(fakeDrms({}));
    expect(result.stats).toMatchObject({ sent: 2, budgetStopped: false });
  });

  it('stops the run on 429, leaving the rest untouched', async () => {
    await approved('d1');
    await approved('d2');
    const drms = fakeDrms({ register: { 'SER-d1': new RateLimitError('DRMS EquipmentRequest/Register returned 429', new Date()) } });
    const result = await run(drms);
    expect(drms.sends()).toHaveLength(1);
    expect(drms.calls.filter((c) => c.arg === 'd2')).toHaveLength(0);
    // DRMS refused before accepting anything, so the row is simply still approved and unsent.
    expect((await rows()).map((r) => [r.status, r.submittedAt, r.requestId])).toEqual([
      ['approved', null, null],
      ['approved', null, null],
    ]);
    expect(result.status).toBe('failed');
    expect(result.errorSample).toContain('429');
    expect(result.stats).toMatchObject({ stopped: true });
  });

  it('stops the run on a 429 while polling, keeping the request id to poll next time', async () => {
    await approved('d1');
    await approved('d2');
    const drms = fakeDrms({ polls: { 'req-SER-d1': [new RateLimitError('429', new Date())] } });
    await run(drms);
    expect(drms.sends()).toHaveLength(1);
    expect((await rows()).map((r) => [r.status, r.requestId])).toEqual([
      ['approved', 'req-SER-d1'],
      ['approved', null],
    ]);
  });

  it('stops the run on an auth failure at the pre-check', async () => {
    await approved('d1');
    const drms = fakeDrms({ status: { d1: [new AuthError('DRMS auth failed (401)', 401)] } });
    const result = await run(drms);
    expect(drms.sends()).toHaveLength(0);
    expect(result.status).toBe('failed');
  });

  it('re-registers a retry-requested device that DRMS set to Deleted', async () => {
    await approved('d1', { status: 'failed', error: 'Backbone deadlock', submittedAt: new Date('2026-09-21T10:00:00Z'), requestId: 'r-old' });
    await t.db.insert(drmsRegistrations).values({
      drmsEquipmentId: 'd1',
      serial: 'SER-d1',
      status: 'approved',
      request: payload('SER-d1'),
      retryRequestedBy: userId,
      retryRequestedAt: NOW,
    });
    const drms = fakeDrms({ status: { d1: ['Deleted', 'PreRegistered'] } });
    await run(drms);
    expect(drms.sends()).toHaveLength(1);
    expect((await rows()).map((r) => r.status)).toEqual(['failed', 'registered']);
  });

  it('does not send a first attempt for a device DRMS set to Deleted', async () => {
    await approved('d1');
    const drms = fakeDrms({ status: { d1: ['Deleted'] } });
    await run(drms);
    expect(drms.sends()).toHaveLength(0);
  });
  it.each([
    ['ErpId set by someone else', { ErpId: '99999' }, 'ErpId'],
    ['a different CsrcId', { CsrcId: 'csrc-other' }, 'CsrcId'],
    ['a different serial', { SerialNumber: 'SER-other' }, 'SerialNumber'],
    ['a different customer code', { CustomerErpId: 'CUST0002' }, 'CustomerErpId'],
  ] as const)('does not send when DRMS has %s since approval', async (_what, record, field) => {
    await approved('d1');
    const drms = fakeDrms({ record: { d1: record } });
    const result = await run(drms);
    expect(drms.sends()).toHaveLength(0);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed', requestId: null, submittedAt: null });
    expect(row?.error).toContain('Changed in DRMS since approval');
    expect(row?.error).toContain(field);
    expect(row?.error).toContain('rescan');
    expect(result.stats).toMatchObject({ failed: 1, sent: 0 });
  });

  it('accepts an ErpId that is a copy of the serial, and our own Vantage id on a retry only', async () => {
    await approved('d1');
    const copy = fakeDrms({ record: { d1: { ErpId: 'ser-d1' } } });
    await run(copy);
    expect(copy.sends()).toHaveLength(1);

    await approved('d2');
    const ours = fakeDrms({ record: { d2: { ErpId: '4321' } } });
    await run(ours);
    expect(ours.sends()).toHaveLength(0);

    await approved('d3', { retryRequestedBy: userId, retryRequestedAt: NOW, decidedBy: null, decidedAt: null });
    const retry = fakeDrms({ status: { d3: ['Deleted', 'PreRegistered'] }, record: { d3: { ErpId: '4321' } } });
    await run(retry);
    expect(retry.sends()).toHaveLength(1);
  });

  it('stops the run on a 429 at the pre-check with nothing sent', async () => {
    await approved('d1');
    await approved('d2');
    const drms = fakeDrms({ status: { d1: [new RateLimitError('DRMS Equipment/{id} returned 429', new Date())] } });
    const result = await run(drms);
    expect(drms.sends()).toHaveLength(0);
    expect(drms.calls.filter((c) => c.arg === 'd2')).toHaveLength(0);
    expect((await rows()).map((r) => [r.status, r.submittedAt])).toEqual([
      ['approved', null],
      ['approved', null],
    ]);
    expect(result).toMatchObject({ status: 'failed', stats: { stopped: true } });
  });

  it('keeps the recorded result when the status-after read hits a 429', async () => {
    await approved('d1');
    await approved('d2');
    const drms = fakeDrms({ status: { d1: ['Discovered', new RateLimitError('429', new Date())] } });
    const result = await run(drms);
    const list = await rows();
    expect(list[0]).toMatchObject({ status: 'registered', requestId: 'req-SER-d1', drmsStatusAfter: null });
    expect(list[1]).toMatchObject({ status: 'approved', submittedAt: null });
    expect(drms.sends()).toHaveLength(1);
    expect(result).toMatchObject({ status: 'failed', stats: { stopped: true, registered: 1 } });
  });
});
