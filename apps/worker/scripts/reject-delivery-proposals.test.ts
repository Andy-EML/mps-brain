import { auditLog, drmsEquipment, replenishmentProposals } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REJECT_REASON, rejectDeliveryProposals, summaryLine } from './reject-delivery-proposals';

const NOW = new Date('2026-11-28T09:00:00Z');

describe('rejectDeliveryProposals', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values({ drmsId: 'd1', modelName: 'bizhub C300i', isColour: true, raw: {} });
    const base = { drmsEquipmentId: 'd1', createdAt: NOW };
    await t.db.insert(replenishmentProposals).values([
      { ...base, colour: 'black', trigger: 'alarm', status: 'pending', alarmDescription: 'Toner Delivery(BK)' },
      { ...base, colour: 'waste', trigger: 'alarm', status: 'pending', alarmDescription: 'Waste Toner Bottle Delivery' },
      { ...base, colour: 'cyan', trigger: 'alarm', status: 'pending', alarmDescription: 'Toner Empty(C)' },
      { ...base, colour: 'magenta', trigger: 'threshold', status: 'pending', alarmDescription: 'Toner Delivery(BK)' },
      { ...base, colour: 'yellow', trigger: 'alarm', status: 'approved', alarmDescription: 'Toner Delivery(Y)' },
    ]);
  });
  afterEach(() => t.close());

  const statuses = async () => (await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.id)).map((p) => p.status);

  it('is a dry run by default: counts, writes nothing', async () => {
    const r = await rejectDeliveryProposals(t.db, { apply: false, now: NOW });
    expect(r).toMatchObject({ matched: 2, rejected: 0 });
    expect(Object.fromEntries(r.byColour)).toEqual({ black: 1, waste: 1 });
    expect(await statuses()).toEqual(['pending', 'pending', 'pending', 'pending', 'approved']);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(summaryLine(r, false)).toContain('dry run');
  });

  it('with apply rejects only pending Delivery alarm proposals, with the reason and one audit row, and is idempotent', async () => {
    expect(await rejectDeliveryProposals(t.db, { apply: true, now: NOW })).toMatchObject({ matched: 2, rejected: 2 });
    expect(await statuses()).toEqual(['rejected', 'rejected', 'pending', 'pending', 'approved']);
    const [waste] = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.colour, 'waste'));
    expect(waste).toMatchObject({ note: REJECT_REASON, decidedAt: NOW, decidedBy: null });
    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'proposal.reject', entity: 'proposal', userId: null, details: { note: REJECT_REASON } });
    expect(audit[0]!.entityIds).toHaveLength(2);
    expect(await rejectDeliveryProposals(t.db, { apply: true, now: NOW })).toMatchObject({ matched: 0, rejected: 0 });
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });
});
