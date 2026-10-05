import { deviceLinks, drmsEquipment, vantageEquipment, vantageSalesOrderLines, vantageSalesOrders } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reclassifyOrderLines } from './reclassify-order-lines';

describe('reclassifyOrderLines', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageSalesOrders).values([
      { vantageId: 1, reference: 'SO1', vantageEquipmentId: 100, raw: {} },
      { vantageId: 2, reference: 'SO2', vantageEquipmentId: 200, raw: {} },
      { vantageId: 3, reference: 'SO3', vantageEquipmentId: 100, raw: {} },
    ]);
  });
  afterEach(() => t.close());

  async function line(vantageId: number, salesOrderId: number, extra: Partial<typeof vantageSalesOrderLines.$inferInsert> = {}) {
    await t.db.insert(vantageSalesOrderLines).values({
      vantageId,
      salesOrderId,
      colour: 'unknown',
      colourSource: 'none',
      raw: {},
      ...extra,
    });
  }

  it('reclassifies an unknown toner line as black for a linked mono device, in dry-run by default (no write)', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd-mono', isColour: false, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 100, description: 'bizhub 4750i', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd-mono', vantageEquipmentId: 100, method: 'serial' });
    await line(10, 1, { details: 'Konica Minolta 4700i Toner' });

    const dry = await reclassifyOrderLines(t.db, { apply: false });
    expect(dry.scanned).toBe(1);
    expect(dry.changed).toBe(1);
    expect(dry.byTransition.get('unknown->black')).toBe(1);
    expect(dry.samples.get('unknown->black')?.[0]).toContain('Konica Minolta 4700i Toner');

    const [row] = await t.db.select().from(vantageSalesOrderLines).where(eq(vantageSalesOrderLines.vantageId, 10));
    expect(row).toMatchObject({ colour: 'unknown', colourSource: 'none' }); // dry-run never writes
  });

  it('writes the new colour and source only when apply is true', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd-mono', isColour: false, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 100, description: 'bizhub 4750i', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd-mono', vantageEquipmentId: 100, method: 'serial' });
    await line(11, 1, { details: 'TNP90 Konica Minolta bizhub 4750i/4050i Toner' });

    const result = await reclassifyOrderLines(t.db, { apply: true });
    expect(result.changed).toBe(1);

    const [row] = await t.db.select().from(vantageSalesOrderLines).where(eq(vantageSalesOrderLines.vantageId, 11));
    expect(row).toMatchObject({ colour: 'black', colourSource: 'mono-device' });
  });

  it('falls back to the order header equipment id when the line has none of its own', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd-mono', isColour: false, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 200, description: 'bizhub 4750i', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd-mono', vantageEquipmentId: 200, method: 'serial' });
    // order 2 -> vantageEquipmentId 200; line itself has no vantageEquipmentId.
    await line(12, 2, { details: 'Konica Minolta 4700i Toner' });

    const result = await reclassifyOrderLines(t.db, { apply: true });
    expect(result.changed).toBe(1);
    const [row] = await t.db.select().from(vantageSalesOrderLines).where(eq(vantageSalesOrderLines.vantageId, 12));
    expect(row?.colour).toBe('black');
  });

  it('leaves non-toner unknown lines (staples, misc) unchanged on a mono device', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd-mono', isColour: false, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 100, description: 'bizhub 4750i', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd-mono', vantageEquipmentId: 100, method: 'serial' });
    await line(13, 1, { details: 'SK-704 Staples Cartridge' });
    await line(14, 1, { details: 'misc' });

    const result = await reclassifyOrderLines(t.db, { apply: true });
    expect(result.changed).toBe(0);
    const rows = await t.db.select().from(vantageSalesOrderLines);
    expect(rows.every((r) => r.colour === 'unknown')).toBe(true);
  });

  it('leaves an unknown line on a colour device unchanged', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd-colour', isColour: true, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 100, description: 'bizhub C3350i', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd-colour', vantageEquipmentId: 100, method: 'serial' });
    await line(15, 1, { details: 'Konica Minolta 4700i Toner' });

    const result = await reclassifyOrderLines(t.db, { apply: true });
    expect(result.changed).toBe(0);
  });

  it('is idempotent: a second run after apply finds nothing left to change', async () => {
    await t.db.insert(drmsEquipment).values({ drmsId: 'd-mono', isColour: false, raw: {} });
    await t.db.insert(vantageEquipment).values({ vantageId: 100, description: 'bizhub 4750i', raw: {} });
    await t.db.insert(deviceLinks).values({ drmsEquipmentId: 'd-mono', vantageEquipmentId: 100, method: 'serial' });
    await line(16, 1, { details: 'Konica Minolta 4700i Toner' });

    await reclassifyOrderLines(t.db, { apply: true });
    const second = await reclassifyOrderLines(t.db, { apply: true });
    expect(second.scanned).toBe(0);
    expect(second.changed).toBe(0);
  });

  it('never touches a line that already has a real colour', async () => {
    await line(17, 1, { details: 'Cyan Toner', colour: 'cyan', colourSource: 'details' });
    const result = await reclassifyOrderLines(t.db, { apply: true });
    expect(result.scanned).toBe(0);
    const [row] = await t.db.select().from(vantageSalesOrderLines).where(eq(vantageSalesOrderLines.vantageId, 17));
    expect(row).toMatchObject({ colour: 'cyan', colourSource: 'details' });
  });
});
