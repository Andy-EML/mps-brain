import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deviceLinks,
  drmsEquipment,
  hiddenDevices,
  replenishmentProposals,
  users,
  vantageCustomers,
  vantageEquipment,
  vantageEquipmentContracts,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { listCustomers } from './customers';
import {
  hasWarning,
  listCustomerMachineStatus,
  listCustomerSiteStatus,
  listCustomerWarnings,
  NO_READING_DAYS,
} from './customer-status';
import { dismissPm, markPmBooked } from './pm-actions';
import { setOtherDealer } from './other-dealer';
import { getEquipmentPm } from './pm-queries';

const NOW = new Date('2026-11-18T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('customer status queries', () => {
  let t: TestDb;
  let n = 0;

  /** A linked machine for a customer: DRMS device + Vantage equipment + active link; a contract with no visits is PM-overdue. */
  const machine = async (
    customerId: number,
    o: { lastCounterAt?: Date | null; contract?: boolean; hidden?: boolean; unlinked?: boolean; location?: string; pending?: number } = {},
  ) => {
    const id = ++n;
    const drmsId = `d${id}`;
    await t.db.insert(drmsEquipment).values({
      drmsId,
      serial: `SER${id}`,
      modelName: 'bizhub C300i',
      lastCounterReceivedTime: o.lastCounterAt === undefined ? NOW : o.lastCounterAt,
      raw: {},
    });
    if (!o.unlinked) {
      await t.db.insert(vantageEquipment).values({
        vantageId: 1000 + id,
        vantageCustomerId: customerId,
        serial: `SER${id}`,
        location: o.location ?? null,
        raw: { Item: { IsMetered: true, NominalCode: '4000' } },
      });
      await t.db.insert(deviceLinks).values({ drmsEquipmentId: drmsId, vantageEquipmentId: 1000 + id, method: 'serial' });
      if (o.contract) {
        await t.db.insert(vantageEquipmentContracts).values({ vantageEquipmentId: 1000 + id, contractId: id, contractReference: `C${id}`, isActive: true });
      }
    }
    if (o.hidden) await t.db.insert(hiddenDevices).values({ drmsEquipmentId: drmsId });
    for (let i = 0; i < (o.pending ?? 0); i++) {
      await t.db.insert(replenishmentProposals).values({ drmsEquipmentId: drmsId, colour: i === 0 ? 'black' : 'cyan', trigger: 'threshold', status: 'pending' });
    }
    return { drmsId, vantageEquipmentId: 1000 + id };
  };

  beforeEach(async () => {
    t = await createTestDb();
    n = 0;
    await t.db.insert(vantageCustomers).values([
      { vantageId: 1, name: 'HO Group', reference: 'HO1', raw: {} },
      { vantageId: 2, name: 'Site A', reference: 'SA', raw: { HeadOfficeId: 1 } },
      { vantageId: 3, name: 'Site B', reference: 'SB', raw: { HeadOfficeId: 1 } },
      { vantageId: 4, name: 'Site C', reference: 'SC', raw: { HeadOfficeId: 1 } },
      { vantageId: 9, name: 'Empty Ltd', reference: 'EMP', raw: {} },
    ]);
  });
  afterEach(() => t.close());

  describe('listCustomerWarnings', () => {
    it('counts a no-reading machine only when lastCounterAt is null or >= 7 days old', async () => {
      expect(NO_READING_DAYS).toBe(7);
      await machine(9, { lastCounterAt: ago(7 * DAY - 60_000) }); // 6d23h59m: not
      await machine(9, { lastCounterAt: ago(7 * DAY) }); // exactly 7d: yes
      await machine(9, { lastCounterAt: null }); // never: yes
      const w = (await listCustomerWarnings(t.db, [9], NOW)).get(9)!;
      expect(w.noReading).toBe(2);
      expect(hasWarning(w)).toBe(true);
    });

    it('rolls a head office up from its sites, and a warning on one site flags only that site', async () => {
      await machine(2, { contract: true }); // PM overdue (no visits)
      await machine(3);
      await machine(4);
      const m = await listCustomerWarnings(t.db, [1, 2, 3, 4], NOW);
      expect(m.get(1)!.pmOverdue).toBe(1);
      expect(m.get(2)!.pmOverdue).toBe(1);
      expect(m.get(3)!.pmOverdue).toBe(0);
      expect(hasWarning(m.get(3)!)).toBe(false);
      expect(hasWarning(m.get(4)!)).toBe(false);
    });

    it('ignores hidden and unlinked devices', async () => {
      await machine(9, { lastCounterAt: null, hidden: true });
      await machine(9, { lastCounterAt: null, unlinked: true });
      const w = (await listCustomerWarnings(t.db, [9], NOW)).get(9)!;
      expect(w).toEqual({ noReading: 0, pmOverdue: 0, pending: 0 });
    });

    it('returns zeros for a customer with no machines', async () => {
      const m = await listCustomerWarnings(t.db, [9, 1], NOW);
      expect(m.get(9)).toEqual({ noReading: 0, pmOverdue: 0, pending: 0 });
      expect(hasWarning(m.get(9)!)).toBe(false);
      expect(m.get(1)).toEqual({ noReading: 0, pmOverdue: 0, pending: 0 });
      expect((await listCustomerWarnings(t.db, [], NOW)).size).toBe(0);
    });

    it('warns for a booking that passed unseen, not for a dismissed or a booked (not yet overdue) machine', async () => {
      const bookedLate = await machine(2, { contract: true });
      const dismissed = await machine(3, { contract: true });
      const booked = await machine(4, { contract: true });
      // No date, booked 45 days ago and no visit since: back in Due as booked-overdue.
      await markPmBooked(t.db, { vantageEquipmentId: bookedLate.vantageEquipmentId, bookedFor: null, reference: null, userId: null, now: ago(45 * DAY) });
      await dismissPm(t.db, { vantageEquipmentId: dismissed.vantageEquipmentId, reason: 'not_now', note: null, snoozeDays: 90, servicedOn: null, userId: null, now: NOW });
      await markPmBooked(t.db, { vantageEquipmentId: booked.vantageEquipmentId, bookedFor: new Date('2026-12-01T00:00:00Z'), reference: 'W1', userId: null, now: NOW });
      const m = await listCustomerWarnings(t.db, [1, 2, 3, 4], NOW);
      expect((await getEquipmentPm(t.db, bookedLate.vantageEquipmentId, NOW))!.bookedOverdue).toBe(true);
      expect(m.get(2)!.pmOverdue).toBe(1);
      expect(m.get(3)!.pmOverdue).toBe(0);
      expect(m.get(4)!.pmOverdue).toBe(0);
      expect(m.get(1)!.pmOverdue).toBe(1);
    });

    it("pending equals the customer list's Pending figure", async () => {
      await machine(2, { pending: 2 });
      await machine(3, { pending: 1 });
      const { rows } = await listCustomers(t.db, { tab: 'all' });
      const w = await listCustomerWarnings(t.db, rows.map((r) => r.vantageId), NOW);
      for (const r of rows) expect(w.get(r.vantageId)!.pending).toBe(r.pending);
      expect(w.get(1)!.pending).toBe(3);
      expect(w.get(2)!.pending).toBe(2);
    });
  });

  describe('listCustomerMachineStatus', () => {
    it('returns the Machines-count set with location, pm and pending', async () => {
      const a = await machine(2, { contract: true, location: 'Reception', pending: 2 });
      await machine(2, { lastCounterAt: null });
      await machine(2, { hidden: true });
      await machine(2, { unlinked: true });
      const rows = await listCustomerMachineStatus(t.db, 2, NOW);
      expect(rows).toHaveLength(2);
      const row = rows.find((r) => r.device.drmsId === a.drmsId)!;
      expect(row.location).toBe('Reception');
      const pm = (await getEquipmentPm(t.db, a.vantageEquipmentId, NOW))!;
      expect(row.pm).toEqual({ status: pm.result.status, overdueReason: pm.result.reason, bookedOverdue: pm.bookedOverdue, view: pm.view, otherDealer: null });
      expect(row.pm!.status).toBe('overdue');
      expect(row.pending).toBe(2);
      expect(row.warnings).toEqual({ noReading: false, pmOverdue: true, pending: true });
      expect(row.lastReadingAt).toEqual(NOW);
      const other = rows.find((r) => r.device.drmsId !== a.drmsId)!;
      expect(other.lastReadingAt).toBeNull();
      expect(other.warnings).toEqual({ noReading: true, pmOverdue: false, pending: false });
    });

    it('gives pm null for a machine with no active contract', async () => {
      await machine(2);
      const [row] = await listCustomerMachineStatus(t.db, 2, NOW);
      expect(row!.pm).toBeNull();
      expect(row!.warnings.pmOverdue).toBe(false);
    });

    it('returns nothing for a customer with no machines', async () => {
      expect(await listCustomerMachineStatus(t.db, 9, NOW)).toEqual([]);
    });
  });

  describe('other-dealer sites (PM only)', () => {
    let userId: number;
    beforeEach(async () => {
      await t.db.insert(vantageCustomers).values([
        { vantageId: 20, name: 'Dublin Print', reference: 'DUB', raw: { PostCode: 'D04 EK2K' } },
        { vantageId: 21, name: 'HO Dublin', reference: 'HOD', raw: { PostCode: 'D02 X285', HeadOfficeId: 1 } },
      ]);
      const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning({ id: users.id });
      userId = u!.id;
    });

    it('a PM-overdue machine at a region-flagged site raises no PM warning; toner/no-reading/pending still do', async () => {
      await machine(20, { contract: true, lastCounterAt: null, pending: 1 });
      const w = (await listCustomerWarnings(t.db, [20], NOW)).get(20)!;
      expect(w).toEqual({ noReading: 1, pmOverdue: 0, pending: 1 });
      const [row] = await listCustomerMachineStatus(t.db, 20, NOW);
      expect(row!.pm).toMatchObject({ status: 'overdue', otherDealer: 'MJ Flood' });
      expect(row!.warnings).toEqual({ noReading: true, pmOverdue: false, pending: true });
    });

    it("a head office's red ! leaves out its other-dealer site's PM, but counts an own-site overdue", async () => {
      await machine(21, { contract: true });
      expect((await listCustomerWarnings(t.db, [1, 21], NOW)).get(1)!.pmOverdue).toBe(0);
      await machine(2, { contract: true });
      const m = await listCustomerWarnings(t.db, [1, 2, 21], NOW);
      expect(m.get(1)!.pmOverdue).toBe(1);
      expect(m.get(21)!.pmOverdue).toBe(0);
      const sites = await listCustomerSiteStatus(t.db, 1, NOW);
      expect(sites.find((s) => s.customer.vantageId === 21)!.warnings.pmOverdue).toBe(0);
    });

    it('a manual dealer flag mutes the PM warning; setting the site back to ours restores it', async () => {
      await machine(3, { contract: true });
      await setOtherDealer(t.db, { vantageCustomerId: 3, mode: 'dealer', name: 'Acme Print', userId, now: NOW });
      expect((await listCustomerWarnings(t.db, [3], NOW)).get(3)!.pmOverdue).toBe(0);
      expect((await listCustomerMachineStatus(t.db, 3, NOW))[0]!.pm!.otherDealer).toBe('Acme Print');
      await machine(20, { contract: true });
      await setOtherDealer(t.db, { vantageCustomerId: 20, mode: 'ours', userId, now: NOW });
      expect((await listCustomerWarnings(t.db, [20], NOW)).get(20)!.pmOverdue).toBe(1);
      expect((await listCustomerMachineStatus(t.db, 20, NOW))[0]!.pm!.otherDealer).toBeNull();
    });
  });

  describe('listCustomerSiteStatus', () => {
    it('lists each site with its own counts and warnings', async () => {
      await machine(2, { contract: true });
      await machine(3, { lastCounterAt: null, pending: 1 });
      const rows = await listCustomerSiteStatus(t.db, 1, NOW);
      expect(rows.map((r) => r.customer.vantageId)).toEqual([2, 3, 4]);
      expect(rows.map((r) => r.customer.machines)).toEqual([1, 1, 0]);
      expect(rows[0]!.warnings).toEqual({ noReading: 0, pmOverdue: 1, pending: 0 });
      expect(rows[1]!.warnings).toEqual({ noReading: 1, pmOverdue: 0, pending: 1 });
      expect(hasWarning(rows[2]!.warnings)).toBe(false);
    });
  });
});
