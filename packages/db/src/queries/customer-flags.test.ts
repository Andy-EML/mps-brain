import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, cartridgeChanges, cartridgeFamilies, customerFlags, replenishmentProposals, users, deviceLinks, drmsEquipment, siteStockShelves, vantageCustomers, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { effectiveSettingsSubquery } from './settings';
import {
  customerScopeIds,
  getSelfManaged,
  headOfficeIdSql,
  isFlaggableCustomer,
  previewSelfManaged,
  selfManagedSourceSql,
  setSelfManaged,
  supersedeSelfManagedProposals,
  SELF_MANAGED_NOTE,
} from './customer-flags';

const A = 10; // site, head office H
const H = 20; // head office
const B = 30; // no head office
const SELF = 40; // HeadOfficeId equal to its own id

describe('selfManagedSourceSql', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageCustomers).values([
      { vantageId: A, name: 'Site A', raw: { HeadOfficeId: H } },
      { vantageId: H, name: 'Head Office', raw: {} },
      { vantageId: B, name: 'Solo B', raw: {} },
      { vantageId: SELF, name: 'Self ref', raw: { HeadOfficeId: SELF } },
    ]);
    await t.db.insert(drmsEquipment).values(['dA', 'dH', 'dB', 'dSelf', 'dNone'].map((drmsId) => ({ drmsId, raw: {} })));
    await t.db.insert(vantageEquipment).values([
      { vantageId: 1, vantageCustomerId: A, raw: {} },
      { vantageId: 2, vantageCustomerId: H, raw: {} },
      { vantageId: 3, vantageCustomerId: B, raw: {} },
      { vantageId: 4, vantageCustomerId: SELF, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'dA', vantageEquipmentId: 1, method: 'serial' },
      { drmsEquipmentId: 'dH', vantageEquipmentId: 2, method: 'serial' },
      { drmsEquipmentId: 'dB', vantageEquipmentId: 3, method: 'serial' },
      { drmsEquipmentId: 'dSelf', vantageEquipmentId: 4, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  async function resolve() {
    const eff = effectiveSettingsSubquery(t.db);
    const rows = await t.db.select({ drmsId: eff.drmsId, sm: eff.selfManaged, src: eff.selfManagedSource }).from(eff);
    return Object.fromEntries(rows.map((r) => [r.drmsId, { sm: r.sm, src: r.src }]));
  }
  const flag = (id: number, selfManaged = true) => t.db.insert(customerFlags).values({ vantageCustomerId: id, selfManaged });

  it('is false with null source when nothing is flagged', async () => {
    const r = await resolve();
    for (const id of ['dA', 'dH', 'dB', 'dSelf', 'dNone']) expect(r[id]).toEqual({ sm: false, src: null });
  });

  it('a flagged head office covers its sites (head_office) and itself (site)', async () => {
    await flag(H);
    const r = await resolve();
    expect(r.dA).toEqual({ sm: true, src: 'head_office' });
    expect(r.dH).toEqual({ sm: true, src: 'site' });
    expect(r.dB).toEqual({ sm: false, src: null });
  });

  it('a flag on a site alone does not reach the head office', async () => {
    await flag(A);
    const r = await resolve();
    expect(r.dA).toEqual({ sm: true, src: 'site' });
    expect(r.dH).toEqual({ sm: false, src: null });
  });

  it('a site row saying false does not override a flagged head office', async () => {
    await flag(A, false);
    await flag(H);
    expect((await resolve()).dA).toEqual({ sm: true, src: 'head_office' });
  });

  it('site flag wins over head office when both are set', async () => {
    await flag(A);
    await flag(H);
    expect((await resolve()).dA).toEqual({ sm: true, src: 'site' });
  });

  it('follows the active link when a device moves customer', async () => {
    await flag(A);
    await t.db.update(deviceLinks).set({ unlinkedAt: new Date() }).where(eq(deviceLinks.drmsEquipmentId, 'dA'));
    await t.db.insert(vantageEquipment).values({ vantageId: 5, vantageCustomerId: B, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dA', vantageEquipmentId: 5, method: 'manual' });
    expect((await resolve()).dA).toEqual({ sm: false, src: null });
  });

  it('an unlinked device is never self-managed', async () => {
    await flag(H);
    expect((await resolve()).dNone).toEqual({ sm: false, src: null });
  });

  it('a HeadOfficeId equal to the own id counts as no head office', async () => {
    await flag(SELF, false);
    const rows = await t.db
      .select({ id: vantageCustomers.vantageId, ho: headOfficeIdSql() })
      .from(vantageCustomers);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.ho]));
    expect(byId[SELF]).toBeNull();
    expect(byId[A]).toBe(H);
    expect(byId[B]).toBeNull();
    expect((await resolve()).dSelf).toEqual({ sm: false, src: null });
    // and it is not treated as its own head office when flagged only via a row saying false
    await t.db.update(customerFlags).set({ selfManaged: true }).where(eq(customerFlags.vantageCustomerId, SELF));
    expect((await resolve()).dSelf).toEqual({ sm: true, src: 'site' });
  });

  it('works in a plain single-table select on vantage_customers (unqualified column)', async () => {
    await flag(H);
    const rows = await t.db
      .select({ id: vantageCustomers.vantageId, src: selfManagedSourceSql(vantageCustomers.vantageId) })
      .from(vantageCustomers);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.src]));
    expect(byId).toEqual({ [A]: 'head_office', [H]: 'site', [B]: null, [SELF]: null });
  });

  it('works in a plain single-table select on site_stock_shelves (unqualified column)', async () => {
    await flag(H);
    const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'F', isColour: false }).returning();
    const countingFrom = new Date('2026-01-01T00:00:00Z');
    await t.db.insert(siteStockShelves).values([A, H, B].map((c) => ({ vantageCustomerId: c, familyId: fam!.id, countingFrom })));
    const rows = await t.db
      .select({ id: siteStockShelves.vantageCustomerId, src: selfManagedSourceSql(siteStockShelves.vantageCustomerId) })
      .from(siteStockShelves);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.src]))).toEqual({ [A]: 'head_office', [H]: 'site', [B]: null });
  });
});

describe('setSelfManaged and supersede helpers', () => {
  let t: TestDb;
  let userId: number;
  let shelfA: number;
  const ids: Record<string, number> = {};
  beforeEach(async () => {
    t = await createTestDb();
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    userId = u!.id;
    await t.db.insert(vantageCustomers).values([
      { vantageId: A, name: 'Site A', raw: { HeadOfficeId: H } },
      { vantageId: H, name: 'Head Office', raw: {} },
      { vantageId: B, name: 'Solo B', raw: {} },
    ]);
    await t.db.insert(drmsEquipment).values(['dA', 'dH', 'dB'].map((drmsId) => ({ drmsId, raw: {} })));
    await t.db.insert(vantageEquipment).values([
      { vantageId: 1, vantageCustomerId: A, raw: {} },
      { vantageId: 2, vantageCustomerId: H, raw: {} },
      { vantageId: 3, vantageCustomerId: B, raw: {} },
    ]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'dA', vantageEquipmentId: 1, method: 'serial' },
      { drmsEquipmentId: 'dH', vantageEquipmentId: 2, method: 'serial' },
      { drmsEquipmentId: 'dB', vantageEquipmentId: 3, method: 'serial' },
    ]);
    const [fam] = await t.db.insert(cartridgeFamilies).values({ name: 'F', isColour: false }).returning();
    const [shelf] = await t.db
      .insert(siteStockShelves)
      .values({ vantageCustomerId: A, familyId: fam!.id, countingFrom: new Date('2026-01-01T00:00:00Z') })
      .returning();
    shelfA = shelf!.id;
    const ins = async (key: string, v: typeof replenishmentProposals.$inferInsert) => {
      const [r] = await t.db.insert(replenishmentProposals).values(v).returning();
      ids[key] = r!.id;
    };
    await ins('thrA', { drmsEquipmentId: 'dA', colour: 'black', trigger: 'threshold', status: 'pending' });
    await ins('apprA', { drmsEquipmentId: 'dA', colour: 'cyan', trigger: 'threshold', status: 'approved' });
    // top-up: shelf of A, device at B
    await ins('topup', { drmsEquipmentId: 'dB', colour: 'black', trigger: 'site_stock', status: 'pending', shelfId: shelfA });
    await ins('spare', { drmsEquipmentId: 'dH', colour: 'black', trigger: 'spare_used', status: 'pending' });
    await ins('thrB', { drmsEquipmentId: 'dB', colour: 'yellow', trigger: 'threshold', status: 'pending' });
  });
  afterEach(() => t.close());

  const status = async (key: string) =>
    (await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, ids[key]!)))[0]!;

  it('scope ids = itself plus its sites', async () => {
    expect((await customerScopeIds(t.db, H)).sort()).toEqual([A, H]);
    expect(await customerScopeIds(t.db, B)).toEqual([B]);
  });

  it('preview counts what the switch would clear', async () => {
    // in scope of H: thrA (dA, A), topup (shelf A, device dB at B), spare (dH, H). thrB is B only.
    expect(await previewSelfManaged(t.db, H)).toEqual({ pending: 3, devices: 3, sites: 2 });
  });

  it('on: supersedes pending proposals across sites and shelves, leaves approved alone, audits', async () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const r = await setSelfManaged(t.db, { vantageCustomerId: H, on: true, note: 'runs own stock', userId, now });
    expect(r).toEqual({ superseded: 3 });
    for (const k of ['thrA', 'topup', 'spare']) {
      const p = await status(k);
      expect(p.status).toBe('superseded');
      expect(p.note).toBe(SELF_MANAGED_NOTE);
      expect(p.decidedAt).toEqual(now);
    }
    expect((await status('apprA')).status).toBe('approved');
    expect((await status('thrB')).status).toBe('pending');
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'customer.self_managed.on'));
    expect(a!.entityIds).toEqual([H]);
    expect(a!.details).toEqual({ note: 'runs own stock', supersededProposalIds: [ids.thrA, ids.topup, ids.spare].sort((x, y) => x! - y!) });
  });

  it('keeps cartridge_changes.proposal_id on a superseded spare_used proposal', async () => {
    const [cc] = await t.db
      .insert(cartridgeChanges)
      .values({ drmsEquipmentId: 'dH', colour: 'black', changedAt: new Date('2026-11-01T00:00:00Z'), source: 'level', outcome: 'proposed', proposalId: ids.spare })
      .returning();
    await setSelfManaged(t.db, { vantageCustomerId: H, on: true, userId });
    expect((await status('spare')).status).toBe('superseded');
    const [after] = await t.db.select().from(cartridgeChanges).where(eq(cartridgeChanges.id, cc!.id));
    expect(after!.proposalId).toBe(ids.spare);
  });

  it('off: flips the flag, supersedes nothing, audits', async () => {
    await setSelfManaged(t.db, { vantageCustomerId: H, on: true, userId });
    const r = await setSelfManaged(t.db, { vantageCustomerId: H, on: false, userId });
    expect(r).toEqual({ superseded: 0 });
    const [f] = await t.db.select().from(customerFlags).where(eq(customerFlags.vantageCustomerId, H));
    expect(f!.selfManaged).toBe(false);
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'customer.self_managed.off'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({ note: null, supersededProposalIds: [] });
  });

  it('on: the audit row and count only cover the flagged customer scope; the worker sweep stays global', async () => {
    const C = 50;
    await t.db.insert(vantageCustomers).values({ vantageId: C, name: 'Other C', raw: {} });
    await t.db.insert(drmsEquipment).values({ drmsId: 'dC', raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 6, vantageCustomerId: C, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dC', vantageEquipmentId: 6, method: 'serial' });
    // C was flagged without its pending proposal being cleared yet (the worker would sweep it).
    await t.db.insert(customerFlags).values({ vantageCustomerId: C, selfManaged: true });
    const [stale] = await t.db
      .insert(replenishmentProposals)
      .values({ drmsEquipmentId: 'dC', colour: 'black', trigger: 'threshold', status: 'pending' })
      .returning();
    const r = await setSelfManaged(t.db, { vantageCustomerId: H, on: true, userId });
    expect(r).toEqual({ superseded: 3 });
    const [a] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'customer.self_managed.on'));
    expect(a!.details).toEqual({ note: null, supersededProposalIds: [ids.thrA, ids.topup, ids.spare].sort((x, y) => x! - y!) });
    const [still] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.id, stale!.id));
    expect(still!.status).toBe('pending');
    expect(await supersedeSelfManagedProposals(t.db, new Date())).toEqual([stale!.id]);
  });

  it('supersedeSelfManagedProposals returns the ids it changed, and nothing on a second run', async () => {
    await t.db.insert(customerFlags).values({ vantageCustomerId: B, selfManaged: true });
    const now = new Date('2026-11-20T10:00:00Z');
    const first = await supersedeSelfManagedProposals(t.db, now);
    expect(first).toEqual([ids.topup, ids.thrB].sort((x, y) => x! - y!));
    expect(await supersedeSelfManagedProposals(t.db, now)).toEqual([]);
  });

  it('isFlaggableCustomer: a live customer, or a deleted one that already has a flag row', async () => {
    const GONE = 60;
    const GONE_FLAGGED = 70;
    const deletedDate = new Date('2026-06-01T00:00:00Z');
    await t.db.insert(vantageCustomers).values([
      { vantageId: GONE, name: 'Gone', raw: {}, deletedDate },
      { vantageId: GONE_FLAGGED, name: 'Gone flagged', raw: {}, deletedDate },
    ]);
    await t.db.insert(customerFlags).values({ vantageCustomerId: GONE_FLAGGED, selfManaged: false });
    expect(await isFlaggableCustomer(t.db, H)).toBe(true);
    expect(await isFlaggableCustomer(t.db, GONE_FLAGGED)).toBe(true);
    expect(await isFlaggableCustomer(t.db, GONE)).toBe(false);
    expect(await isFlaggableCustomer(t.db, 999)).toBe(false);
  });

  it('getSelfManaged: site under a flagged head office; own flag; none', async () => {
    await setSelfManaged(t.db, { vantageCustomerId: H, on: true, note: 'hq note', userId });
    const a = await getSelfManaged(t.db, A);
    expect(a).toMatchObject({ selfManaged: true, source: 'head_office', note: 'hq note', updatedBy: 'op', headOffice: { vantageId: H, name: 'Head Office' } });
    expect(a.updatedAt).toBeInstanceOf(Date);
    expect(await getSelfManaged(t.db, H)).toMatchObject({ selfManaged: true, source: 'site', headOffice: null });
    expect(await getSelfManaged(t.db, B)).toMatchObject({ selfManaged: false, source: null, note: null });
  });
});
