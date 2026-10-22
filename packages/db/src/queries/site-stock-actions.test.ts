import type { ImportRow, ShelfConsumableCounts } from '@mps/core';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  cartridgeFamilies,
  cartridgeFamilyModels,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  replenishmentSettings,
  siteStockShelves,
  users,
  vantageCustomers,
  vantageEquipment,
} from '../schema';
import { createTestDb, type TestDb } from '../testing';
import {
  SiteStockError,
  applyImport,
  createShelf,
  deleteFamily,
  deleteShelf,
  previewImport,
  resetAutoReplenishForShelf,
  saveFamily,
  updateShelf,
} from './site-stock-actions';

const NOW = new Date('2026-10-01T09:00:00Z');
const LATER = new Date('2026-10-02T09:00:00Z');

const counts = (o: Partial<ShelfConsumableCounts> = {}): ShelfConsumableCounts => ({ black: 0, cyan: 0, magenta: 0, yellow: 0, waste: 0, ...o });
const row = (line: number, customer: number, family: string, hold: Partial<ShelfConsumableCounts>, used: Partial<ShelfConsumableCounts> = {}): ImportRow => ({
  line,
  vantageCustomerId: customer,
  family,
  holding: counts(hold),
  used: counts(used),
});

describe('site stock writes', () => {
  let t: TestDb;
  let alice: number;
  let famId: number;

  const audits = (action: string) => t.db.select().from(auditLog).where(eq(auditLog.action, action));
  const shelves = () => t.db.select().from(siteStockShelves);

  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'alice', passwordHash: 'x', role: 'operator' }).returning({ id: users.id });
    alice = u!.id;
    await t.db.insert(vantageCustomers).values([
      { vantageId: 1, name: 'Site One', raw: {} },
      { vantageId: 2, name: 'Site Two', raw: {} },
      { vantageId: 3, name: 'Site Three', raw: {} },
    ]);
    const made = await saveFamily(t.db, {
      name: 'C-series',
      isColour: true,
      models: ['bizhub C300i'],
      ratedYield: { black: 20000 },
      userId: alice,
      now: NOW,
    });
    famId = made.familyId;
  });
  afterEach(() => t.close());

  describe('families', () => {
    it('creates with models and yields, and audits', async () => {
      const [f] = await t.db.select().from(cartridgeFamilies).where(eq(cartridgeFamilies.id, famId));
      expect(f).toMatchObject({ name: 'C-series', isColour: true, ratedYieldBlack: 20000, ratedYieldCyan: null });
      expect(await t.db.select().from(cartridgeFamilyModels)).toEqual([{ model: 'bizhub C300i', familyId: famId }]);
      const a = await audits('family.create');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ userId: alice, entity: 'family', entityIds: [famId] });
    });

    it('accepts a null user (the seed script)', async () => {
      const { familyId } = await saveFamily(t.db, { name: 'Seeded', isColour: false, models: [], ratedYield: {}, userId: null, now: NOW });
      const a = (await audits('family.create')).find((r) => (r.entityIds as number[])[0] === familyId);
      expect(a?.userId).toBeNull();
    });

    it('updates in place, replacing its models', async () => {
      await saveFamily(t.db, { id: famId, name: 'C-series II', isColour: true, models: ['bizhub C360i'], ratedYield: {}, notes: ' n ', userId: alice, now: LATER });
      const [f] = await t.db.select().from(cartridgeFamilies).where(eq(cartridgeFamilies.id, famId));
      expect(f).toMatchObject({ name: 'C-series II', ratedYieldBlack: null, notes: 'n' });
      expect((await t.db.select().from(cartridgeFamilyModels)).map((m) => m.model)).toEqual(['bizhub C360i']);
      expect(await audits('family.update')).toHaveLength(1);
    });

    it('a model already in another family is a duplicate and nothing is written', async () => {
      await expect(
        saveFamily(t.db, { name: 'Other', isColour: false, models: ['bizhub C300i'], ratedYield: {}, userId: alice }),
      ).rejects.toMatchObject({ code: 'duplicate' });
      expect(await t.db.select().from(cartridgeFamilies)).toHaveLength(1);
    });

    it('a name clash (any case) is a duplicate; an unknown id is not_found', async () => {
      await expect(saveFamily(t.db, { name: 'c-SERIES', isColour: true, models: [], ratedYield: {}, userId: alice })).rejects.toMatchObject({ code: 'duplicate' });
      await expect(saveFamily(t.db, { id: 9999, name: 'Zed', isColour: true, models: [], ratedYield: {}, userId: alice })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('deletes an unused family with its models; refuses one a shelf uses', async () => {
      await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 1 }, userId: alice, now: NOW });
      await expect(deleteFamily(t.db, { id: famId, userId: alice })).rejects.toMatchObject({ code: 'in_use' });

      const { familyId } = await saveFamily(t.db, { name: 'Temp', isColour: false, models: ['m1'], ratedYield: {}, userId: alice });
      await deleteFamily(t.db, { id: familyId, userId: alice, now: NOW });
      expect((await t.db.select().from(cartridgeFamilies)).map((f) => f.id)).toEqual([famId]);
      expect((await t.db.select().from(cartridgeFamilyModels)).map((m) => m.model)).toEqual(['bizhub C300i']);
      expect(await audits('family.delete')).toHaveLength(1);
    });
  });

  describe('shelves', () => {
    it('creates a shelf counting from now, and audits', async () => {
      const { shelfId } = await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 3, waste: 1 }, used: { black: 2 }, userId: alice, now: NOW });
      const [s] = await shelves();
      expect(s).toMatchObject({ id: shelfId, holdingBlack: 3, holdingWaste: 1, holdingCyan: 0, usedBlack: 2, createdBy: alice });
      expect(s!.countingFrom).toEqual(NOW);
      const a = await audits('shelf.create');
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ userId: alice, entityIds: [shelfId] });
    });

    it('rejects a holding of 21, a negative used, a second shelf, and unknown customer or family', async () => {
      await expect(createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 21 }, userId: alice })).rejects.toMatchObject({ code: 'bad_value' });
      await expect(createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: {}, used: { cyan: -1 }, userId: alice })).rejects.toMatchObject({ code: 'bad_value' });
      await expect(createShelf(t.db, { vantageCustomerId: 99, familyId: famId, holding: {}, userId: alice })).rejects.toMatchObject({ code: 'not_found' });
      await expect(createShelf(t.db, { vantageCustomerId: 1, familyId: 99, holding: {}, userId: alice })).rejects.toMatchObject({ code: 'not_found' });
      await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: {}, userId: alice });
      await expect(createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: {}, userId: alice })).rejects.toMatchObject({ code: 'duplicate' });
      expect(await shelves()).toHaveLength(1);
    });

    it('updates holding and used (the manual correction) and audits before and after', async () => {
      const { shelfId } = await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 3 }, used: { black: 2 }, userId: alice, now: NOW });
      await updateShelf(t.db, { shelfId, holding: { black: 4 }, used: { black: 0 }, userId: alice, now: LATER });
      const [s] = await shelves();
      expect(s).toMatchObject({ holdingBlack: 4, usedBlack: 0, updatedBy: alice });
      expect(s!.countingFrom).toEqual(NOW);
      const [a] = await audits('shelf.update');
      expect(a!.details).toMatchObject({ holding: { from: { black: 3 }, set: { black: 4 } }, used: { from: { black: 2 }, set: { black: 0 } } });
    });

    it('update refuses 21, an empty patch and an unknown shelf, writing nothing', async () => {
      const { shelfId } = await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 3 }, userId: alice });
      await expect(updateShelf(t.db, { shelfId, holding: { black: 21 }, userId: alice })).rejects.toBeInstanceOf(SiteStockError);
      await expect(updateShelf(t.db, { shelfId, holding: { black: 21 }, userId: alice })).rejects.toMatchObject({ code: 'bad_value' });
      await expect(updateShelf(t.db, { shelfId, userId: alice })).rejects.toMatchObject({ code: 'empty' });
      await expect(updateShelf(t.db, { shelfId: 9999, holding: { black: 1 }, userId: alice })).rejects.toMatchObject({ code: 'not_found' });
      expect((await shelves())[0]!.holdingBlack).toBe(3);
      expect(await audits('shelf.update')).toHaveLength(0);
    });
  });

  describe('deleteShelf', () => {
    let shelfId: number;
    const proposal = (colour: 'black' | 'cyan' | 'magenta', status: 'pending' | 'approved' | 'rejected') =>
      t.db
        .insert(replenishmentProposals)
        .values({ drmsEquipmentId: 'd1', colour, trigger: 'site_stock', status, shelfId })
        .returning({ id: replenishmentProposals.id });

    beforeEach(async () => {
      ({ shelfId } = await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 2 }, userId: alice, now: NOW }));
      await t.db.insert(drmsEquipment).values({ drmsId: 'd1', modelName: 'bizhub C300i', serial: 'S1', status: 'Registered', raw: {} });
    });

    it('supersedes pending top-ups, keeps decided history with a null shelf, and audits', async () => {
      const [pending] = await proposal('black', 'pending');
      const [rejected] = await proposal('cyan', 'rejected');
      await deleteShelf(t.db, { shelfId, userId: alice, now: LATER });
      expect(await shelves()).toHaveLength(0);
      const [p] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, pending!.id));
      expect(p).toMatchObject({ status: 'superseded', note: 'shelf deleted', shelfId: null });
      const [r] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, rejected!.id));
      expect(r).toMatchObject({ status: 'rejected', shelfId: null });
      const [a] = await audits('shelf.delete');
      expect(a).toMatchObject({ userId: alice, entityIds: [shelfId], details: { supersededProposalIds: [pending!.id] } });
    });

    it('refuses while a top-up is approved, changing nothing', async () => {
      await proposal('black', 'approved');
      await proposal('cyan', 'pending');
      await expect(deleteShelf(t.db, { shelfId, userId: alice })).rejects.toMatchObject({ code: 'in_use' });
      expect(await shelves()).toHaveLength(1);
      const pend = await t.db.select().from(replenishmentProposals).where(and(eq(replenishmentProposals.status, 'pending')));
      expect(pend).toHaveLength(1);
    });

    it('unknown shelf is not_found', async () => {
      await expect(deleteShelf(t.db, { shelfId: 9999, userId: alice })).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('resetAutoReplenishForShelf', () => {
    it('nulls an explicit auto_replenish=false on the shelf devices only', async () => {
      const { shelfId } = await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 2 }, userId: alice });
      await t.db.insert(drmsEquipment).values([
        { drmsId: 'd1', modelName: 'bizhub C300i', serial: 'S1', status: 'Registered', raw: {} },
        { drmsId: 'd2', modelName: 'bizhub C300i', serial: 'S2', status: 'Registered', raw: {} },
        { drmsId: 'd3', modelName: 'bizhub C300i', serial: 'S3', status: 'Registered', raw: {} },
      ]);
      await t.db.insert(vantageEquipment).values([
        { vantageId: 10, vantageCustomerId: 1, raw: {} },
        { vantageId: 11, vantageCustomerId: 1, raw: {} },
        { vantageId: 12, vantageCustomerId: 2, raw: {} },
      ]);
      await t.db.insert(deviceLinks).values([
        { drmsEquipmentId: 'd1', vantageEquipmentId: 10, method: 'serial' },
        { drmsEquipmentId: 'd2', vantageEquipmentId: 11, method: 'serial' },
        { drmsEquipmentId: 'd3', vantageEquipmentId: 12, method: 'serial' },
      ]);
      await t.db.insert(replenishmentSettings).values([
        { scope: 'device', drmsEquipmentId: 'd1', autoReplenish: false, thresholdBlack: 10 },
        { scope: 'device', drmsEquipmentId: 'd2', autoReplenish: true },
        { scope: 'device', drmsEquipmentId: 'd3', autoReplenish: false },
      ]);
      expect(await resetAutoReplenishForShelf(t.db, { shelfId, userId: alice, now: NOW })).toEqual({ updated: 1 });
      const rs = await t.db.select().from(replenishmentSettings);
      const by = new Map(rs.map((r) => [r.drmsEquipmentId, r]));
      expect(by.get('d1')).toMatchObject({ autoReplenish: null, thresholdBlack: 10 });
      expect(by.get('d2')!.autoReplenish).toBe(true);
      expect(by.get('d3')!.autoReplenish).toBe(false); // other customer's shelf
      expect(await resetAutoReplenishForShelf(t.db, { shelfId, userId: alice })).toEqual({ updated: 0 });
    });
  });

  describe('import', () => {
    beforeEach(async () => {
      await createShelf(t.db, { vantageCustomerId: 1, familyId: famId, holding: { black: 3 }, used: { black: 2 }, userId: alice, now: NOW });
    });

    it('previews create, update, unchanged and errors (family name case-insensitive)', async () => {
      const out = await previewImport(t.db, [
        row(2, 1, 'c-SERIES', { black: 5 }, { black: 9 }),
        row(3, 2, 'C-series', { black: 1 }),
        row(4, 2, 'C-series', {}),
        row(5, 1, 'C-series', { black: 3 }),
        row(6, 99, 'C-series', { black: 1 }),
        row(7, 1, 'Nope', { black: 1 }),
      ]);
      expect(out.map((o) => o.action)).toEqual(['update', 'create', 'unchanged', 'unchanged', 'error', 'error']);
      expect(out[0]).toMatchObject({ line: 2, siteName: 'Site One', family: 'c-SERIES', changes: ['black 3 to 5'] });
      expect(out[1]!.changes).toEqual(['black 0 to 1']);
      expect(out[4]!.message).toMatch(/customer/i);
      expect(out[5]!.message).toMatch(/family/i);
    });

    it('apply: update touches holdings only; create keeps used; one audit row', async () => {
      const res = await applyImport(t.db, {
        rows: [row(2, 1, 'C-series', { black: 5 }, { black: 9 }), row(3, 2, 'C-series', { cyan: 4 }, { cyan: 1 }), row(4, 3, 'c-series', {})],
        userId: alice,
        now: LATER,
      });
      expect(res).toEqual({ created: 1, updated: 1, unchanged: 1 });
      const all = await shelves();
      const one = all.find((s) => s.vantageCustomerId === 1)!;
      const two = all.find((s) => s.vantageCustomerId === 2)!;
      expect(one).toMatchObject({ holdingBlack: 5, usedBlack: 2 });
      expect(one.countingFrom).toEqual(NOW);
      expect(two).toMatchObject({ holdingCyan: 4, usedCyan: 1, createdBy: alice });
      expect(two.countingFrom).toEqual(LATER);
      expect(await audits('shelf.import')).toHaveLength(1);
    });

    it('one bad line applies nothing and writes no audit row', async () => {
      await expect(
        applyImport(t.db, { rows: [row(2, 1, 'C-series', { black: 7 }), row(3, 99, 'C-series', { black: 1 })], userId: alice }),
      ).rejects.toMatchObject({ code: 'bad_value', message: expect.stringContaining('Line 3') });
      expect((await shelves()).map((s) => s.holdingBlack)).toEqual([3]);
      expect(await audits('shelf.import')).toHaveLength(0);
    });

    it('an empty import is refused', async () => {
      await expect(applyImport(t.db, { rows: [], userId: alice })).rejects.toMatchObject({ code: 'empty' });
    });
  });
});
