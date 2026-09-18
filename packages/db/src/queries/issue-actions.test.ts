import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceLinks, drmsEquipment, linkIssues, users, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { manualLink, setIssueStatus, unlinkDevice } from './issue-actions';

const NOW = new Date('2026-09-18T12:00:00Z');

describe('issue actions', () => {
  let t: TestDb;
  let userId: number;

  beforeEach(async () => {
    t = await createTestDb();
    const [user] = await t.db
      .insert(users)
      .values({ username: 'operator', passwordHash: 'x', role: 'operator' })
      .returning({ id: users.id });
    userId = user!.id;

    await t.db.insert(drmsEquipment).values([
      { drmsId: 'D1', serial: 'SN0000001', serialNorm: 'sn0000001', status: 'Registered', raw: {} },
      { drmsId: 'D2', serial: 'SN0000002', serialNorm: 'sn0000002', status: 'Registered', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 1001, serial: 'SN0000001', serialNorm: 'sn0000001', raw: {} },
      { vantageId: 1002, serial: 'SN0000002', serialNorm: 'sn0000002', raw: {} },
    ]);
  });

  afterEach(() => t.close());

  const links = () => t.db.select().from(deviceLinks).orderBy(deviceLinks.id);
  const activeLinks = () =>
    t.db.select().from(deviceLinks).where(isNull(deviceLinks.unlinkedAt)).orderBy(deviceLinks.id);

  describe('manualLink', () => {
    it('closes the device’s existing link and creates a manual one', async () => {
      await t.db
        .insert(deviceLinks)
        .values({ drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'serial' });

      await manualLink(t.db, { drmsId: 'D1', vantageId: 1002, userId, now: NOW });

      const all = await links();
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({
        vantageEquipmentId: 1001,
        method: 'serial',
        unlinkedReason: 'manual_relink',
      });
      expect(all[0]?.unlinkedAt?.getTime()).toBe(NOW.getTime());
      expect(all[1]).toMatchObject({
        drmsEquipmentId: 'D1',
        vantageEquipmentId: 1002,
        method: 'manual',
        linkedBy: userId,
        unlinkedAt: null,
      });
      expect(all[1]?.linkedAt.getTime()).toBe(NOW.getTime());
    });

    it('closes the link another device holds on the same Vantage record', async () => {
      await t.db.insert(deviceLinks).values([
        { drmsEquipmentId: 'D2', vantageEquipmentId: 1002, method: 'erp_id' },
        { drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'serial' },
      ]);

      await manualLink(t.db, { drmsId: 'D1', vantageId: 1002, userId, now: NOW });

      // Both partial unique indexes (one active link per device, one per Vantage record) survive.
      const active = await activeLinks();
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ drmsEquipmentId: 'D1', vantageEquipmentId: 1002, method: 'manual' });
      const closed = (await links()).filter((l) => l.unlinkedAt !== null);
      expect(closed.map((l) => l.drmsEquipmentId).sort()).toEqual(['D1', 'D2']);
      expect(closed.every((l) => l.unlinkedReason === 'manual_relink')).toBe(true);
    });

    it('links a device that had no link at all', async () => {
      await manualLink(t.db, { drmsId: 'D1', vantageId: 1001, userId, now: NOW });
      expect(await activeLinks()).toMatchObject([
        { drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'manual', linkedBy: userId },
      ]);
    });

    it('resolves the open link issues on either side, and leaves the others alone', async () => {
      const seed = async (
        key: string,
        type: string,
        drmsId: string | null,
        vantageId: number | null,
        status: 'open' | 'ignored' = 'open',
      ) => {
        const [row] = await t.db
          .insert(linkIssues)
          .values({ issueKey: key, type, drmsEquipmentId: drmsId, vantageEquipmentId: vantageId, status })
          .returning({ id: linkIssues.id });
        return row!.id;
      };

      const onDrms = await seed('a', 'no_match_drms', 'D1', null);
      const onVantage = await seed('b', 'no_match_vantage', null, 1002);
      const ambiguous = await seed('c', 'serial_ambiguous', 'D1', null);
      const duplicate = await seed('d', 'duplicate_target', 'D1', 1002);
      const disagree = await seed('e', 'erp_serial_disagree', 'D1', 1002);
      const otherType = await seed('f', 'customer_mismatch', 'D1', 1002);
      const otherDevice = await seed('g', 'no_match_drms', 'D2', null);
      const alreadyIgnored = await seed('h', 'no_match_vantage', null, 1002, 'ignored');

      await manualLink(t.db, { drmsId: 'D1', vantageId: 1002, userId, now: NOW });

      const byId = new Map((await t.db.select().from(linkIssues)).map((i) => [i.id, i]));
      for (const id of [onDrms, onVantage, ambiguous, duplicate, disagree]) {
        expect(byId.get(id)).toMatchObject({ status: 'resolved', resolvedBy: userId });
        expect(byId.get(id)?.resolvedAt?.getTime()).toBe(NOW.getTime());
      }
      // customer_mismatch is not a "this device has no link" problem, so a link does not fix it.
      expect(byId.get(otherType)).toMatchObject({ status: 'open', resolvedAt: null, resolvedBy: null });
      expect(byId.get(otherDevice)).toMatchObject({ status: 'open', resolvedAt: null });
      // An operator who ignored an issue shouldn't have it quietly flipped to resolved.
      expect(byId.get(alreadyIgnored)).toMatchObject({ status: 'ignored', resolvedAt: null });
    });

    it('rolls back the closes when the new link cannot be inserted', async () => {
      await t.db
        .insert(deviceLinks)
        .values({ drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'serial' });

      // 9999 is not a Vantage equipment row, so the foreign key rejects the insert.
      await expect(manualLink(t.db, { drmsId: 'D1', vantageId: 9999, userId, now: NOW })).rejects.toThrow();

      expect(await activeLinks()).toMatchObject([
        { drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'serial', unlinkedReason: null },
      ]);
    });
  });

  describe('unlinkDevice', () => {
    it('closes the active link with the given reason and leaves issues alone', async () => {
      await t.db
        .insert(deviceLinks)
        .values({ drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'serial' });
      await t.db
        .insert(linkIssues)
        .values({ issueKey: 'a', type: 'link_broken', drmsEquipmentId: 'D1', vantageEquipmentId: 1001 });

      await unlinkDevice(t.db, { drmsId: 'D1', userId, reason: 'wrong_customer', now: NOW });

      expect(await activeLinks()).toEqual([]);
      const [closed] = await links();
      expect(closed).toMatchObject({ unlinkedReason: 'wrong_customer', unlinkedBy: userId });
      expect(closed?.unlinkedAt?.getTime()).toBe(NOW.getTime());
      expect((await t.db.select().from(linkIssues))[0]).toMatchObject({ status: 'open', resolvedAt: null });
    });

    it('defaults the reason and ignores links that are already closed', async () => {
      await t.db.insert(deviceLinks).values({
        drmsEquipmentId: 'D1',
        vantageEquipmentId: 1001,
        method: 'serial',
        unlinkedAt: new Date('2026-01-01T00:00:00Z'),
        unlinkedReason: 'relinked',
      });
      await t.db
        .insert(deviceLinks)
        .values({ drmsEquipmentId: 'D1', vantageEquipmentId: 1002, method: 'erp_id' });

      await unlinkDevice(t.db, { drmsId: 'D1', userId, now: NOW });

      const all = await links();
      expect(all[0]).toMatchObject({ unlinkedReason: 'relinked' });
      expect(all[0]?.unlinkedAt?.getTime()).toBe(new Date('2026-01-01T00:00:00Z').getTime());
      expect(all[1]).toMatchObject({ unlinkedReason: 'manual_unlink', unlinkedBy: userId });
      expect(all[1]?.unlinkedAt?.getTime()).toBe(NOW.getTime());
    });

    it('is a no-op for a device with no active link', async () => {
      await expect(unlinkDevice(t.db, { drmsId: 'D2', userId, now: NOW })).resolves.toBeUndefined();
      expect(await links()).toEqual([]);
    });
  });

  describe('setIssueStatus', () => {
    let issueId: number;
    beforeEach(async () => {
      const [row] = await t.db
        .insert(linkIssues)
        .values({ issueKey: 'a', type: 'no_match_drms', drmsEquipmentId: 'D1' })
        .returning({ id: linkIssues.id });
      issueId = row!.id;
    });

    it('ignores an issue without stamping a resolver', async () => {
      await setIssueStatus(t.db, { issueId, status: 'ignored', userId, now: NOW });
      expect((await t.db.select().from(linkIssues))[0]).toMatchObject({
        status: 'ignored',
        resolvedBy: null,
        resolvedAt: null,
      });
    });

    it('resolves an issue with who and when', async () => {
      await setIssueStatus(t.db, { issueId, status: 'resolved', userId, now: NOW });
      const [row] = await t.db.select().from(linkIssues);
      expect(row).toMatchObject({ status: 'resolved', resolvedBy: userId });
      expect(row?.resolvedAt?.getTime()).toBe(NOW.getTime());
    });

    it('clears the resolver when an issue is reopened', async () => {
      await setIssueStatus(t.db, { issueId, status: 'resolved', userId, now: NOW });
      await setIssueStatus(t.db, { issueId, status: 'open', userId, now: NOW });
      expect((await t.db.select().from(linkIssues))[0]).toMatchObject({
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
      });
    });

    it('touches only the issue it is given', async () => {
      const [other] = await t.db
        .insert(linkIssues)
        .values({ issueKey: 'b', type: 'no_match_drms', drmsEquipmentId: 'D2' })
        .returning({ id: linkIssues.id });
      await setIssueStatus(t.db, { issueId, status: 'ignored', userId, now: NOW });
      const [row] = await t.db.select().from(linkIssues).where(eq(linkIssues.id, other!.id));
      expect(row).toMatchObject({ status: 'open' });
    });
  });

  it('keeps a manually linked device linked to the same Vantage record', async () => {
    // Guards the pair of partial unique indexes from the other direction: D2 already holds 1002,
    // and D1 already holds 1001, so a straight insert would violate both at once.
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'D1', vantageEquipmentId: 1001, method: 'serial' },
      { drmsEquipmentId: 'D2', vantageEquipmentId: 1002, method: 'serial' },
    ]);
    await manualLink(t.db, { drmsId: 'D1', vantageId: 1002, userId, now: NOW });
    const active = await t.db
      .select()
      .from(deviceLinks)
      .where(and(isNull(deviceLinks.unlinkedAt), eq(deviceLinks.drmsEquipmentId, 'D1')));
    expect(active).toMatchObject([{ vantageEquipmentId: 1002, method: 'manual' }]);
  });
});
