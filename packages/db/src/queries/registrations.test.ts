import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, drmsEquipment, drmsRegistrations, users } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import {
  RegistrationError,
  approveRegistrations,
  rejectRegistrations,
  requestRetry,
  unrejectRegistration,
} from './registration-actions';
import { countAwaitingApproval, getRegistrationCounts, listRegistrationLog, listRegistrations } from './registrations';

const NOW = new Date('2026-09-22T10:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const request = (serial: string) => ({ EquipmentErpId: '4321', EquipmentSerialNumber: serial });

describe('DRMS registration queue', () => {
  let t: TestDb;
  let userId: number;

  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(drmsEquipment).values(
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((id) => ({ drmsId: id, serial: `SER-${id}`, modelName: `Model ${id}`, raw: {} })),
    );
  });
  afterEach(() => t.close());

  async function row(drmsId: string, status: typeof drmsRegistrations.$inferInsert.status, extra: Partial<typeof drmsRegistrations.$inferInsert> = {}) {
    const [r] = await t.db
      .insert(drmsRegistrations)
      .values({
        drmsEquipmentId: drmsId,
        serial: `SER-${drmsId}`,
        deviceName: `Device ${drmsId}`,
        drmsCustomerName: 'Acme Ltd',
        vantageCustomerName: 'Acme Limited',
        status,
        request: status === 'waiting' ? null : request(`SER-${drmsId}`),
        customerMatch: status === 'waiting' ? null : 'match',
        createdAt: hoursAgo(10),
        ...extra,
      })
      .returning();
    return r!;
  }

  const byId = async (id: number) => (await t.db.select().from(drmsRegistrations).where(eq(drmsRegistrations.id, id)))[0]!;
  const audits = () => t.db.select().from(auditLog).orderBy(asc(auditLog.id));

  describe('reads', () => {
    it('lists each tab, with counts, the badge and the latest failed row per device only', async () => {
      const a1 = await row('d1', 'awaiting_approval');
      const ap = await row('d2', 'approved', { decidedBy: userId, decidedAt: hoursAgo(1) });
      const w = await row('d3', 'waiting', { reason: 'No active contract on the Vantage equipment' });
      const reg = await row('d4', 'registered', { finishedAt: hoursAgo(2), requestId: 'r4', drmsStatusAfter: 'PreRegistered (ErpId 4321)' });
      const oldFail = await row('d5', 'failed', { finishedAt: hoursAgo(5), error: 'Backbone deadlock' });
      await row('d5', 'registered', { finishedAt: hoursAgo(1), retryRequestedBy: userId, retryRequestedAt: hoursAgo(2) });
      const fail = await row('d6', 'failed', { finishedAt: hoursAgo(3), error: 'Rejected' });

      const awaiting = await listRegistrations(t.db, { tab: 'awaiting' });
      // Approved ones (on their way to DRMS) first, then those awaiting a decision.
      expect(awaiting.rows.map((r) => [r.id, r.status])).toEqual([
        [ap.id, 'approved'],
        [a1.id, 'awaiting_approval'],
      ]);
      expect(awaiting.rows[0]).toMatchObject({ decidedBy: 'op', model: 'Model d2', serial: 'SER-d2', deviceName: 'Device d2', vantageCustomerName: 'Acme Limited', customerMatch: 'match' });
      expect(awaiting.total).toBe(2);

      expect((await listRegistrations(t.db, { tab: 'waiting' })).rows.map((r) => [r.id, r.reason])).toEqual([
        [w.id, 'No active contract on the Vantage equipment'],
      ]);
      const registered = await listRegistrations(t.db, { tab: 'registered' });
      expect(registered.rows.map((r) => r.drmsId)).toEqual(['d5', 'd4']);
      expect(registered.rows[0]).toMatchObject({ isRetry: true, retryRequestedBy: 'op' });
      expect(registered.rows.find((r) => r.id === reg.id)).toMatchObject({ drmsStatusAfter: 'PreRegistered (ErpId 4321)', isRetry: false });

      // d5's failure was retried successfully, so only d6 still needs a person.
      const failed = await listRegistrations(t.db, { tab: 'failed' });
      expect(failed.rows.map((r) => r.id)).toEqual([fail.id]);
      expect(failed.rows.map((r) => r.id)).not.toContain(oldFail.id);

      expect(await getRegistrationCounts(t.db)).toEqual({ awaitingApproval: 1, approved: 1, waiting: 1, registered: 2, failed: 1, rejected: 0 });
      // The sidebar badge must equal the *Awaiting approval* tab's own count (awaiting.total, above) —
      // awaiting_approval rows plus approved ones still being sent, not just the former.
      expect(await countAwaitingApproval(t.db)).toBe(awaiting.total);
      expect(await countAwaitingApproval(t.db)).toBe(2);
    });

    it('searches serial, device and both customer names, and pages', async () => {
      await row('d1', 'waiting', { vantageCustomerName: 'Zebra Printing' });
      await row('d2', 'waiting', { createdAt: hoursAgo(9) });
      expect((await listRegistrations(t.db, { tab: 'waiting', search: 'zebra' })).rows.map((r) => r.drmsId)).toEqual(['d1']);
      expect((await listRegistrations(t.db, { tab: 'waiting', search: 'ser-d2' })).rows.map((r) => r.drmsId)).toEqual(['d2']);
      const page = await listRegistrations(t.db, { tab: 'waiting', limit: 1, offset: 1 });
      expect(page).toMatchObject({ total: 2 });
      expect(page.rows).toHaveLength(1);
    });

    it('exports every attempt with its request and response for the log', async () => {
      await row('d1', 'failed', { requestId: 'r1', response: { Status: 'Failed', ErrorMessage: 'Backbone' }, error: 'Failed: Backbone', submittedAt: hoursAgo(3), finishedAt: hoursAgo(2) });
      await row('d1', 'registered', { retryRequestedBy: userId, retryRequestedAt: hoursAgo(1) });
      const log = await listRegistrationLog(t.db);
      expect(log.map((r) => r.status)).toEqual(['failed', 'registered']);
      expect(log[0]).toMatchObject({ requestId: 'r1', request: request('SER-d1'), response: { Status: 'Failed', ErrorMessage: 'Backbone' } });
      expect(log[1]).toMatchObject({ retryRequestedBy: 'op' });
    });
  });

  describe('approveRegistrations', () => {
    it('approves awaiting rows in one audited write', async () => {
      const a = await row('d1', 'awaiting_approval');
      const b = await row('d2', 'awaiting_approval');
      expect(await approveRegistrations(t.db, { ids: [a.id, b.id, a.id], userId, now: NOW })).toEqual({ approved: 2 });
      for (const id of [a.id, b.id]) expect(await byId(id)).toMatchObject({ status: 'approved', decidedBy: userId, decidedAt: NOW });
      expect(await audits()).toEqual([
        expect.objectContaining({ action: 'registration.approve', entity: 'registration', entityIds: [a.id, b.id], userId }),
      ]);
    });

    it('is all or nothing when one has moved on', async () => {
      const a = await row('d1', 'awaiting_approval');
      const b = await row('d2', 'waiting');
      await expect(approveRegistrations(t.db, { ids: [a.id, b.id], userId, now: NOW })).rejects.toMatchObject({ code: 'stale' });
      expect((await byId(a.id)).status).toBe('awaiting_approval');
      expect(await audits()).toEqual([]);
    });

    it('refuses an empty selection', async () => {
      await expect(approveRegistrations(t.db, { ids: [], userId })).rejects.toBeInstanceOf(RegistrationError);
    });
  });

  describe('rejectRegistrations and unrejectRegistration', () => {
    it('rejects awaiting rows with a note, and un-rejecting puts it back for approval', async () => {
      const a = await row('d1', 'awaiting_approval');
      expect(await rejectRegistrations(t.db, { ids: [a.id], userId, note: '  Loan machine  ', now: NOW })).toEqual({ rejected: 1 });
      expect(await byId(a.id)).toMatchObject({ status: 'rejected', decidedBy: userId, note: 'Loan machine' });
      expect((await listRegistrations(t.db, { tab: 'rejected' })).rows.map((r) => r.id)).toEqual([a.id]);

      await unrejectRegistration(t.db, { registrationId: a.id, userId, now: NOW });
      expect(await byId(a.id)).toMatchObject({ status: 'awaiting_approval', decidedBy: null, decidedAt: null, note: null });
      expect((await audits()).map((x) => [x.action, x.entityIds, x.details])).toEqual([
        ['registration.reject', [a.id], { note: 'Loan machine' }],
        ['registration.unreject', [a.id], {}],
      ]);
    });

    it('cannot reject an approved row or un-reject one that is not rejected', async () => {
      const a = await row('d1', 'approved');
      await expect(rejectRegistrations(t.db, { ids: [a.id], userId })).rejects.toMatchObject({ code: 'stale' });
      await expect(unrejectRegistration(t.db, { registrationId: a.id, userId })).rejects.toMatchObject({ code: 'bad_state' });
      await expect(unrejectRegistration(t.db, { registrationId: 999, userId })).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('requestRetry', () => {
    it('queues a new approved attempt with the same request, keeping the failed one as history', async () => {
      const f = await row('d1', 'failed', { requestId: 'r-old', error: 'Backbone deadlock', submittedAt: hoursAgo(3), finishedAt: hoursAgo(2), vantageEquipmentId: 4321 });
      const { registrationId } = await requestRetry(t.db, { registrationId: f.id, userId, now: NOW });
      const fresh = await byId(registrationId);
      expect(fresh).toMatchObject({
        drmsEquipmentId: 'd1',
        status: 'approved',
        request: request('SER-d1'),
        requestId: null,
        submittedAt: null,
        vantageEquipmentId: 4321,
        retryRequestedBy: userId,
        retryRequestedAt: NOW,
      });
      expect(await byId(f.id)).toMatchObject({ status: 'failed', requestId: 'r-old' });
      expect(await audits()).toEqual([
        expect.objectContaining({ action: 'registration.retry', entityIds: [f.id], details: { newRegistrationId: registrationId } }),
      ]);
    });

    it('maps a clash with a live row (a concurrent retry) to stale, writing nothing', async () => {
      // A live row with a lower id than the failed one: what a racing second retry would meet.
      await row('d1', 'approved');
      const f = await row('d1', 'failed');
      await expect(requestRetry(t.db, { registrationId: f.id, userId })).rejects.toMatchObject({ name: 'RegistrationError', code: 'stale' });
      expect((await t.db.select().from(drmsRegistrations)).map((x) => x.status).sort()).toEqual(['approved', 'failed']);
      expect(await audits()).toEqual([]);
    });

    it('refuses a row that is not failed, or a failure already retried', async () => {
      const ok = await row('d1', 'registered');
      await expect(requestRetry(t.db, { registrationId: ok.id, userId })).rejects.toMatchObject({ code: 'bad_state' });
      const f = await row('d2', 'failed');
      await requestRetry(t.db, { registrationId: f.id, userId });
      await expect(requestRetry(t.db, { registrationId: f.id, userId })).rejects.toMatchObject({ code: 'bad_state' });
    });
  });
});
