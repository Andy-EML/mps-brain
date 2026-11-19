import {
  cartridgeChanges,
  deviceAlarms,
  deviceLinks,
  drmsEquipment,
  replenishmentProposals,
  replenishmentSettings,
  vantageEquipment,
  vantageSalesOrderLines,
  vantageSalesOrders,
} from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveSnapshot } from './drms-snapshot';
import { evaluateSpareBlack } from './spare-black';

const NOW = new Date('2026-11-20T12:00:00Z');
const FROM = new Date('2026-11-01T00:00:00Z');

describe('evaluateSpareBlack', () => {
  let t: TestDb;
  let seq = 0;

  beforeEach(async () => {
    seq = 0;
    t = await createTestDb();
    await t.db.update(replenishmentSettings).set({ spareBlackFrom: FROM, spareBlack: true, autoReplenish: true }).where(eq(replenishmentSettings.scope, 'default'));
    await t.db.insert(drmsEquipment).values({ drmsId: 'dA', modelName: 'bizhub 4752', status: 'Registered', isColour: false, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 1, vantageCustomerId: 100, raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'dA', vantageEquipmentId: 1, method: 'serial', linkedAt: new Date('2026-10-01T00:00:00Z') });
  });
  afterEach(() => t.close());

  const level = (at: string, black: number) =>
    saveSnapshot(t.db, 'dA', { CounterId: `r${++seq}`, ReceivedTime: at, Counters: [{ Name: 'BlackTonerLevel', Value: black }], ModeSizeCounters: [] } as never, NOW);
  const empty = (at: string, description = 'Toner Empty(K)') =>
    t.db.insert(deviceAlarms).values({
      alarmId: `a${++seq}`, drmsEquipmentId: 'dA', receivedTime: new Date(at.replace(' ', 'T') + 'Z'), category: 'toner', status: 'Acknowledged', description, raw: {},
    });
  const proposals = () => t.db.select().from(replenishmentProposals);
  const changes = () => t.db.select().from(cartridgeChanges).orderBy(cartridgeChanges.changedAt);

  it('low then high after start -> one pending spare_used proposal', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    const stats = await evaluateSpareBlack(t.db, NOW);
    expect(stats).toEqual({ changes: 1, proposed: 1, covered: 0, ineligible: 0 });
    const [p] = await proposals();
    expect(p).toMatchObject({ drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'spare_used', quantity: 1, status: 'pending', level: 90, alarmId: null });
    const [c] = await changes();
    expect(c).toMatchObject({ source: 'level', outcome: 'proposed', reason: null, proposalId: p!.id, lowLevel: 10, highLevel: 90 });
    // A second run sees nothing new.
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 0, proposed: 0, covered: 0, ineligible: 0 });
    expect(await proposals()).toHaveLength(1);
  });

  it('Review Focus 1: shelf holds black -> ineligible shelf, no proposal', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    const stats = await evaluateSpareBlack(t.db, NOW, new Map([['dA', new Set(['black' as const])]]));
    expect(stats).toEqual({ changes: 1, proposed: 0, covered: 0, ineligible: 1 });
    expect(await proposals()).toHaveLength(0);
    expect((await changes())[0]).toMatchObject({ outcome: 'ineligible', reason: 'shelf', proposalId: null });
  });

  it('Review Focus 2: approved threshold black proposal created after cartridge start -> covered', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'ordered', createdAt: new Date('2026-11-04T00:00:00Z'),
    });
    const stats = await evaluateSpareBlack(t.db, NOW);
    expect(stats).toEqual({ changes: 1, proposed: 0, covered: 1, ineligible: 0 });
    const [p] = await proposals();
    expect(await proposals()).toHaveLength(1);
    expect((await changes())[0]).toMatchObject({ outcome: 'covered', reason: 'proposal', proposalId: p!.id });
  });

  it('first change: an order placed before go-live but after the real cartridge start (last >=50 reading) covers', async () => {
    await level('2026-10-15 02:00:00', 95); // before counting starts (1 Nov): marks when this cartridge went in
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'ordered', createdAt: new Date('2026-10-20T00:00:00Z'),
    });
    const [p0] = await proposals();
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 1, proposed: 0, covered: 1, ineligible: 0 });
    expect((await changes())[0]).toMatchObject({ outcome: 'covered', reason: 'proposal', proposalId: p0!.id });
  });

  it('first change: an order placed before the real cartridge start does not cover', async () => {
    await level('2026-10-15 02:00:00', 95);
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'ordered', createdAt: new Date('2026-10-10T00:00:00Z'),
    });
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ proposed: 1, covered: 0 });
  });

  it('first change by Empty alarm: the cartridge start is the last >=50 reading before the Empty', async () => {
    await level('2026-10-15 02:00:00', 95);
    await empty('2026-11-05 08:00:00');
    await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'ordered', createdAt: new Date('2026-10-20T00:00:00Z'),
    });
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 1, proposed: 0, covered: 1, ineligible: 0 });
  });

  it('first change with no earlier >=50 reading: the cartridge start is counting start minus 30 days', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'ordered', createdAt: new Date('2026-10-05T00:00:00Z'),
    });
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ proposed: 0, covered: 1 });
  });

  it('first change with no earlier >=50 reading: an order older than 30 days before counting start does not cover', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'ordered', createdAt: new Date('2026-09-20T00:00:00Z'),
    });
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ proposed: 1, covered: 0 });
  });

  it('a live approved proposal from before the start blocks the insert -> covered live_proposal with its id', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    const [old] = await t.db.insert(replenishmentProposals).values({
      drmsEquipmentId: 'dA', vantageEquipmentId: 1, colour: 'black', trigger: 'threshold', level: 12, threshold: 15, status: 'approved', createdAt: new Date('2026-09-20T00:00:00Z'),
    }).returning();
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 1, proposed: 0, covered: 1, ineligible: 0 });
    expect((await changes())[0]).toMatchObject({ outcome: 'covered', reason: 'live_proposal', proposalId: old!.id });
  });

  it('one proposal covers one change: change k proposed and ordered, change k+1 proposes again', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await evaluateSpareBlack(t.db, NOW);
    await t.db.update(replenishmentProposals).set({ status: 'ordered' });
    await level('2026-11-10 02:00:00', 8);
    await level('2026-11-11 02:00:00', 92);
    expect(await evaluateSpareBlack(t.db, new Date('2026-11-21T12:00:00Z'))).toEqual({ changes: 1, proposed: 1, covered: 0, ineligible: 0 });
    expect(await proposals()).toHaveLength(2);
  });

  it('two changes in one run: the first proposes; the second cannot (one live black proposal per machine) and records live_proposal', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await level('2026-11-10 02:00:00', 8);
    await level('2026-11-11 02:00:00', 92);
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 2, proposed: 1, covered: 1, ineligible: 0 });
    expect((await changes())[1]).toMatchObject({ outcome: 'covered', reason: 'live_proposal' });
  });

  it('an Empty alarm change then the next cartridge: the alarm-path proposal does not cover the next swap', async () => {
    await empty('2026-11-05 08:00:00');
    await evaluateSpareBlack(t.db, NOW);
    await t.db.update(replenishmentProposals).set({ status: 'ordered' });
    await level('2026-11-06 02:00:00', 90);
    await level('2026-11-10 02:00:00', 8);
    await level('2026-11-11 02:00:00', 92);
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ changes: 1, proposed: 1, covered: 0 });
  });

  it('one Vantage line covers the first change only; a second change with no new order proposes', async () => {
    await t.db.insert(vantageSalesOrders).values({ vantageId: 500, orderDate: new Date('2026-11-04T00:00:00Z'), vantageEquipmentId: 1, raw: {} });
    await t.db.insert(vantageSalesOrderLines).values({ vantageId: 501, salesOrderId: 500, colour: 'black', raw: {} });
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await level('2026-11-10 02:00:00', 8);
    await level('2026-11-11 02:00:00', 92);
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 2, proposed: 1, covered: 1, ineligible: 0 });
    const cs = await changes();
    expect(cs[0]).toMatchObject({ outcome: 'covered', reason: 'vantage_order', coveredLineId: 501, proposalId: null });
    expect(cs[1]).toMatchObject({ outcome: 'proposed', coveredLineId: null });
  });

  it('a Vantage line linked to a consumed proposal does not cover a later change', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await evaluateSpareBlack(t.db, NOW);
    await t.db.insert(vantageSalesOrders).values({ vantageId: 500, orderDate: new Date('2026-11-07T00:00:00Z'), vantageEquipmentId: 1, raw: {} });
    await t.db.insert(vantageSalesOrderLines).values({ vantageId: 501, salesOrderId: 500, colour: 'black', raw: {} });
    await t.db.update(replenishmentProposals).set({ status: 'ordered', vantageSalesOrderId: 500, vantageSalesOrderLineId: 501 });
    await level('2026-11-10 02:00:00', 8);
    await level('2026-11-11 02:00:00', 92);
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ proposed: 1, covered: 0 });
  });

  it('a deleted Vantage order or a returned line does not cover', async () => {
    await t.db.insert(vantageSalesOrders).values([
      { vantageId: 500, orderDate: new Date('2026-11-04T00:00:00Z'), vantageEquipmentId: 1, deletedDate: new Date('2026-11-05T00:00:00Z'), raw: {} },
      { vantageId: 510, orderDate: new Date('2026-11-04T00:00:00Z'), vantageEquipmentId: 1, raw: {} },
    ]);
    await t.db.insert(vantageSalesOrderLines).values([
      { vantageId: 501, salesOrderId: 500, colour: 'black', raw: {} },
      { vantageId: 511, salesOrderId: 510, colour: 'black', returnedDate: new Date('2026-11-05T00:00:00Z'), raw: {} },
    ]);
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ proposed: 1, covered: 0 });
  });

  it('Vantage black line ordered after cartridge start -> covered vantage_order', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await t.db.insert(vantageSalesOrders).values({ vantageId: 500, orderDate: new Date('2026-11-04T00:00:00Z'), vantageEquipmentId: null, raw: {} });
    await t.db.insert(vantageSalesOrderLines).values({ vantageId: 501, salesOrderId: 500, vantageEquipmentId: 1, colour: 'black', raw: {} });
    const stats = await evaluateSpareBlack(t.db, NOW);
    expect(stats).toEqual({ changes: 1, proposed: 0, covered: 1, ineligible: 0 });
    expect((await changes())[0]).toMatchObject({ outcome: 'covered', reason: 'vantage_order' });
    expect(await proposals()).toHaveLength(0);
  });

  it('a black Vantage line ordered before the cartridge start does not cover', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await t.db.insert(vantageSalesOrders).values({ vantageId: 500, orderDate: new Date('2026-09-20T00:00:00Z'), vantageEquipmentId: 1, raw: {} });
    await t.db.insert(vantageSalesOrderLines).values({ vantageId: 501, salesOrderId: 500, colour: 'black', raw: {} });
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ proposed: 1 });
  });

  it('Review Focus 3: run 1 sees Empty(K) -> proposal; run 2 sees 4 then 90 -> no new change', async () => {
    await empty('2026-11-05 08:00:00');
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 1, proposed: 1, covered: 0, ineligible: 0 });
    const [p] = await proposals();
    expect(p).toMatchObject({ trigger: 'spare_used', alarmDescription: 'Toner Empty(K)', level: null });
    expect(p!.alarmId).not.toBeNull();
    await level('2026-11-05 20:00:00', 4);
    await level('2026-11-06 02:00:00', 90);
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 0, proposed: 0, covered: 0, ineligible: 0 });
    expect(await changes()).toHaveLength(1);
    expect(await proposals()).toHaveLength(1);
  });

  it('Review Focus 4: readings before spare_black_from -> nothing recorded', async () => {
    await level('2026-10-20 02:00:00', 10);
    await level('2026-10-21 02:00:00', 90);
    await empty('2026-10-22 08:00:00');
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 0, proposed: 0, covered: 0, ineligible: 0 });
    expect(await changes()).toHaveLength(0);
    expect(await proposals()).toHaveLength(0);
  });

  it('Review Focus 5: proposal rejected, rerun -> still one change, no new proposal', async () => {
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await evaluateSpareBlack(t.db, NOW);
    await t.db.update(replenishmentProposals).set({ status: 'rejected', decidedAt: NOW });
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 0, proposed: 0, covered: 0, ineligible: 0 });
    expect(await changes()).toHaveLength(1);
    expect(await proposals()).toHaveLength(1);
  });

  it('spare_black off at customer -> ineligible spare_off', async () => {
    await t.db.insert(replenishmentSettings).values({ scope: 'customer', vantageCustomerId: 100, spareBlack: false });
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 1, proposed: 0, covered: 0, ineligible: 1 });
    expect((await changes())[0]).toMatchObject({ outcome: 'ineligible', reason: 'spare_off' });
    expect(await proposals()).toHaveLength(0);
  });

  it('auto-replenish off -> ineligible auto_off; unlinked -> ineligible unlinked', async () => {
    await t.db.insert(replenishmentSettings).values({ scope: 'device', drmsEquipmentId: 'dA', autoReplenish: false });
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await evaluateSpareBlack(t.db, NOW);
    expect((await changes())[0]).toMatchObject({ outcome: 'ineligible', reason: 'auto_off' });

    await t.db.insert(drmsEquipment).values({ drmsId: 'dU', status: 'Registered', isColour: false, raw: {} });
    await t.db.insert(deviceAlarms).values({ alarmId: 'u1', drmsEquipmentId: 'dU', receivedTime: new Date('2026-11-05T08:00:00Z'), category: 'toner', status: 'x', description: 'Toner Empty(BK)', raw: {} });
    await evaluateSpareBlack(t.db, NOW);
    const u = (await changes()).find((c) => c.drmsEquipmentId === 'dU');
    expect(u).toMatchObject({ outcome: 'ineligible', reason: 'unlinked' });
  });

  it('hidden device -> ineligible hidden', async () => {
    const { hiddenDevices } = await import('@mps/db');
    await t.db.insert(hiddenDevices).values({ drmsEquipmentId: 'dA' });
    await empty('2026-11-05 08:00:00');
    await evaluateSpareBlack(t.db, NOW);
    expect((await changes())[0]).toMatchObject({ outcome: 'ineligible', reason: 'hidden' });
  });

  it('device linked after spare_black_from: readings before linked_at are ignored', async () => {
    await t.db.update(deviceLinks).set({ linkedAt: new Date('2026-11-10T00:00:00Z') });
    await level('2026-11-05 02:00:00', 10);
    await level('2026-11-06 02:00:00', 90);
    await empty('2026-11-07 08:00:00');
    expect(await evaluateSpareBlack(t.db, NOW)).toEqual({ changes: 0, proposed: 0, covered: 0, ineligible: 0 });
    await level('2026-11-11 02:00:00', 8);
    await level('2026-11-12 02:00:00', 95);
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ changes: 1, proposed: 1 });
  });

  it('ignores Near Empty alarms', async () => {
    await empty('2026-11-05 08:00:00', 'Toner Near Empty(K)');
    expect(await evaluateSpareBlack(t.db, NOW)).toMatchObject({ changes: 0 });
  });
});
