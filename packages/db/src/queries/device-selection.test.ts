import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drmsEquipment } from '../schema';
import { createTestDb, seedDemoFixture, type DemoFixture, type TestDb } from '../testing';
import { describeSelection, resolveDeviceSelection } from './device-selection';
import { listDevices, type DeviceListOptions } from './devices';

// Same frozen clock as queries.test.ts: the offline filter compares against Date.now().
const FIXED_NOW = new Date('2026-09-18T12:00:00Z');

describe('device selection', () => {
  let t: TestDb;
  let f: DemoFixture;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    t = await createTestDb();
    f = await seedDemoFixture(t.db);
    // A mono device with no customer link, so `hasMono` and the "no customer" group both have
    // something to find.
    await t.db.insert(drmsEquipment).values({
      drmsId: 'M1',
      serial: 'SNMONO0001',
      modelName: 'bizhub 4050i',
      isColour: false,
      productName: 'Delta Mono Printer',
      customerName: 'Delta Ltd',
      raw: {},
    });
  });
  afterEach(async () => {
    await t.close();
    vi.useRealTimers();
  });

  describe('resolveDeviceSelection', () => {
    const cases: Pick<DeviceListOptions, 'search' | 'filter'>[] = [
      {},
      { filter: 'all' },
      { filter: 'needs-toner' },
      { filter: 'manual' },
      { filter: 'offline' },
      { filter: 'unlinked' },
      { search: 'acme' },
      { search: 'sn0000002' },
      { search: 'ltd', filter: 'unlinked' },
      { search: 'nothing matches this' },
    ];

    it.each(cases)('returns exactly the ids listDevices pages through for %o', async (o) => {
      const listed = await listDevices(t.db, { ...o, limit: 10_000 });
      const selected = await resolveDeviceSelection(t.db, o);
      expect(selected.drmsIds).toEqual(listed.rows.map((r) => r.drmsId));
      expect(selected.drmsIds).toHaveLength(listed.total);
    });

    it('counts distinct Vantage customers, with every unlinked device in one "no customer" group', async () => {
      const all = await resolveDeviceSelection(t.db, {});
      // Acme (1), Beta (2), and D3 + M1 together as "no customer".
      expect(all.customers).toBe(3);

      const unlinked = await resolveDeviceSelection(t.db, { filter: 'unlinked' });
      expect(unlinked.drmsIds).toEqual([f.drms.unlinked, 'M1']);
      expect(unlinked.customers).toBe(1);

      const acme = await resolveDeviceSelection(t.db, { search: 'acme' });
      expect(acme.customers).toBe(1);

      const none = await resolveDeviceSelection(t.db, { search: 'nothing matches this' });
      expect(none).toEqual({ drmsIds: [], customers: 0, hasMono: false });
    });

    it('sets hasMono when any selected device is mono', async () => {
      expect((await resolveDeviceSelection(t.db, {})).hasMono).toBe(true);
      expect((await resolveDeviceSelection(t.db, { search: 'acme' })).hasMono).toBe(false);
      expect((await resolveDeviceSelection(t.db, { search: 'delta' })).hasMono).toBe(true);
    });
  });

  describe('describeSelection', () => {
    it('counts devices, customers and mono devices, and names them customer first', async () => {
      const d = await describeSelection(t.db, [f.drms.online, f.drms.offline, 'M1']);
      expect(d).toEqual({
        count: 3,
        customers: 3,
        hasMono: true,
        mono: 1,
        names: [
          'Acme Ltd (Vantage) · SN0000001',
          'Beta Co (Vantage) · SN0000002',
          'Delta Ltd · SNMONO0001',
        ],
      });
    });

    it('ignores ids that are not devices, and duplicates', async () => {
      const d = await describeSelection(t.db, [f.drms.online, f.drms.online, 'no-such-device']);
      expect(d).toMatchObject({ count: 1, customers: 1, hasMono: false, mono: 0 });
    });

    it('returns an empty description for an empty selection', async () => {
      expect(await describeSelection(t.db, [])).toEqual({
        count: 0,
        customers: 0,
        hasMono: false,
        mono: 0,
        names: [],
      });
    });

    it('caps the names at 50 but counts every device', async () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        drmsId: `X${String(i).padStart(2, '0')}`,
        serial: `SNX${String(i).padStart(2, '0')}`,
        customerName: 'Echo Ltd',
        raw: {},
      }));
      await t.db.insert(drmsEquipment).values(many);
      const d = await describeSelection(
        t.db,
        many.map((m) => m.drmsId),
      );
      expect(d.count).toBe(60);
      expect(d.customers).toBe(1);
      expect(d.names).toHaveLength(50);
      expect(d.names[0]).toBe('Echo Ltd · SNX00');
    });
  });
});
