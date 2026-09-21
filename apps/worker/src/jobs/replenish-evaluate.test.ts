import { deviceAlarms, deviceLinks, drmsEquipment, replenishmentProposals, vantageEquipment } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { updateDeviceSettings } from '@mps/db/queries';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot } from './drms-snapshot';
import { runReplenishEvaluate } from './replenish-evaluate';

const NOW = new Date('2026-09-21T14:00:00Z');

describe('runReplenishEvaluate', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(drmsEquipment).values([
      { drmsId: 'colour', status: 'Registered', isColour: true, raw: {} },
      { drmsId: 'mono', status: 'Registered', isColour: false, raw: {} },
      { drmsId: 'loose', status: 'Registered', isColour: true, raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([{ vantageId: 1, raw: {} }, { vantageId: 2, raw: {} }]);
    await t.db.insert(deviceLinks).values([
      { drmsEquipmentId: 'colour', vantageEquipmentId: 1, method: 'serial' },
      { drmsEquipmentId: 'mono', vantageEquipmentId: 2, method: 'serial' },
    ]);
  });
  afterEach(() => t.close());

  const levels = (id: string, counterId: string, k: number, c: number, m = 50, y = 50) =>
    saveSnapshot(t.db, id, {
      CounterId: counterId,
      ReceivedTime: '2026-09-21 09:00:00',
      Counters: [
        { Name: 'BlackTonerLevel', Value: k },
        { Name: 'CyanTonerLevel', Value: c },
        { Name: 'MagentaTonerLevel', Value: m },
        { Name: 'YellowTonerLevel', Value: y },
      ],
      ModeSizeCounters: [],
    } as never, NOW);

  it('proposes low channels for linked devices only, respecting mono', async () => {
    await levels('colour', 'c1', 12, 4);
    await levels('mono', 'm1', 5, 0);
    await levels('loose', 'l1', 1, 1);
    const r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.status).toBe('success');
    expect(r.stats).toMatchObject({ proposed: 3, unlinked: 1 });
    const rows = await t.db.select().from(replenishmentProposals).orderBy(replenishmentProposals.drmsEquipmentId, replenishmentProposals.colour);
    expect(rows.map((p) => [p.drmsEquipmentId, p.colour, p.trigger, p.level, p.threshold, p.status, p.vantageEquipmentId])).toEqual([
      ['colour', 'black', 'threshold', 12, 15, 'pending', 1],
      ['colour', 'cyan', 'threshold', 4, 10, 'pending', 1],
      ['mono', 'black', 'threshold', 5, 15, 'pending', 2],
    ]);
  });

  it('is idempotent: a second run proposes nothing new', async () => {
    await levels('colour', 'c1', 12, 50);
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    const again = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(again.stats).toMatchObject({ proposed: 0, suppressed: 1 });
    expect(await t.db.select().from(replenishmentProposals)).toHaveLength(1);
  });

  it('proposes waste from a ready alarm', async () => {
    await t.db.insert(deviceAlarms).values({
      alarmId: 'w1', drmsEquipmentId: 'colour', receivedTime: new Date('2026-09-20T08:00:00Z'), category: 'waste',
      status: 'ReadyForErpDelivery', description: 'Waste Toner Bottle Almost Full', raw: {},
    });
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    const [p] = await t.db.select().from(replenishmentProposals);
    expect(p).toMatchObject({ colour: 'waste', trigger: 'alarm', alarmId: 'w1', level: null });
  });

  it('supersedes a pending threshold proposal once the level recovers, or auto-replenish is switched off', async () => {
    await levels('colour', 'c1', 12, 4);
    await runReplenishEvaluate({ db: t.db, now: () => NOW });
    await levels('colour', 'c2', 98, 4); // black cartridge replaced
    let r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1 });
    await updateDeviceSettings(t.db, { drmsIds: ['colour'], patch: { autoReplenish: false }, userId: await userId() });
    r = await runReplenishEvaluate({ db: t.db, now: () => NOW });
    expect(r.stats).toMatchObject({ superseded: 1, autoOff: 1 });
    const live = await t.db.select().from(replenishmentProposals).where(eq(replenishmentProposals.status, 'pending'));
    expect(live).toEqual([]);
  });

  async function userId() {
    const { users } = await import('@mps/db');
    const [u] = await t.db.insert(users).values({ username: 'op', passwordHash: 'x' }).returning();
    return u!.id;
  }
});
