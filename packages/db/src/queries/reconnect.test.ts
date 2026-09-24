import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deviceAlarms, deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import {
  getReconnectCounts,
  listReconnect,
  RECONNECT_DAYS,
  type ReconnectFilter,
} from './reconnect';

const NOW = new Date('2026-09-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
/** DRMS's own date format in `raw`: UTC, `YYYY-MM-DD HH:mm:ss`. */
const drmsDate = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

interface Device {
  id: string;
  customer: string;
  serial?: string;
  status?: string;
  counterDaysAgo?: number;
  raw?: Record<string, unknown>;
  initialConnection?: Date;
  missing?: boolean;
  /** `false` = no link at all, `'closed'` = a link that has been unlinked. */
  link?: false | 'closed';
  equipmentDeleted?: boolean;
}

let nextVantageId = 1;

async function seed(t: TestDb, devices: Device[]) {
  for (const d of devices) {
    await t.db.insert(drmsEquipment).values({
      drmsId: d.id,
      serial: d.serial ?? `SN-${d.id}`,
      productName: `${d.id} MFP`,
      modelName: 'bizhub C300i',
      status: d.status ?? 'Registered',
      customerName: `${d.customer} (DRMS)`,
      lastCounterReceivedTime: d.counterDaysAgo === undefined ? null : daysAgo(d.counterDaysAgo),
      initialConnectionTime: d.initialConnection ?? null,
      missingSince: d.missing ? daysAgo(1) : null,
      raw: d.raw ?? {},
    });
    if (d.link === false) continue;
    const vantageId = nextVantageId++;
    await t.db.insert(vantageEquipment).values({
      vantageId,
      customerName: d.customer,
      customerReference: `REF-${d.id}`,
      location: 'Reception',
      assetNumber: `AST-${d.id}`,
      deletedDate: d.equipmentDeleted ? daysAgo(2) : null,
      raw: {},
    });
    await t.db.insert(deviceLinks).values({
      drmsEquipmentId: d.id,
      vantageEquipmentId: vantageId,
      method: 'serial',
      unlinkedAt: d.link === 'closed' ? daysAgo(1) : null,
    });
  }
}

const ids = (rows: { drmsId: string }[]) => rows.map((r) => r.drmsId);

describe('needs reconnecting', () => {
  let t: TestDb;

  beforeEach(async () => {
    nextVantageId = 1;
    t = await createTestDb();
    await seed(t, [
      // Silent for 20 days on meter readings alone: newly silent.
      { id: 'new20', customer: 'Acme', serial: 'SNACME20', counterDaysAgo: 20 },
      // Reading three days ago: fine.
      { id: 'fresh', customer: 'Fresh Ltd', counterDaysAgo: 3 },
      // Only ever connected at install, never a meter reading: not monitored, never "silent".
      {
        id: 'install',
        customer: 'Frimley School',
        status: 'Discovered',
        initialConnection: new Date('2023-08-04T09:00:00Z'),
        raw: { InitialConnectionTime: '2023-08-04 09:00:00' },
      },
      // Old meter reading, but DRMS saw an alarm 5 days ago: still talking, not silent.
      {
        id: 'alarmRescue',
        customer: 'Rescued',
        counterDaysAgo: 40,
        raw: { LastAlarmReceivedTime: drmsDate(daysAgo(5)) },
      },
      // Old meter reading and an older DRMS alarm: long silent, last contact is the alarm.
      {
        id: 'long35',
        customer: 'Long Co',
        counterDaysAgo: 40,
        raw: { LastAlarmReceivedTime: drmsDate(daysAgo(35)) },
      },
      // Old everything in DRMS, but our own alarm feed heard from it 2 days ago.
      {
        id: 'ourAlarm',
        customer: 'Heard',
        counterDaysAgo: 60,
        raw: { LastAlarmReceivedTime: drmsDate(daysAgo(50)) },
      },
      // Excluded by scope.
      { id: 'unlinked', customer: 'Nolink', counterDaysAgo: 20, link: false },
      { id: 'closedLink', customer: 'Closed', counterDaysAgo: 20, link: 'closed' },
      { id: 'deleted', customer: 'Gone', counterDaysAgo: 20, status: 'Deleted' },
      { id: 'missing', customer: 'Missing', counterDaysAgo: 20, missing: true },
      { id: 'vDeleted', customer: 'Off contract', counterDaysAgo: 20, equipmentDeleted: true },
      // Registered but no reading yet: not monitored, "waiting for first reading".
      {
        id: 'waiting',
        customer: 'Waiting Ltd',
        status: 'Registered',
        raw: { LastAlarmReceivedTime: '' },
      },
      // The newly/long boundary: 30.5 days is "30 days" (newly), 31 days is "over 30" (long).
      { id: 'edge30', customer: 'Edge Thirty', counterDaysAgo: 30.5 },
      { id: 'edge31', customer: 'Edge ThirtyOne', counterDaysAgo: 31, raw: { Name: 'Edge ThirtyOne Hall C300i' } },
      // Empty and malformed DRMS dates are ignored rather than breaking the query.
      {
        id: 'badDates',
        customer: 'Bad Dates',
        counterDaysAgo: 100,
        raw: { LastAlarmReceivedTime: 'not a date' },
      },
    ]);
    await t.db
      .insert(deviceAlarms)
      .values({ alarmId: 'a1', drmsEquipmentId: 'ourAlarm', receivedTime: daysAgo(2), raw: {} });
  });
  afterEach(async () => {
    await t.close();
  });

  it('uses a 14-day threshold', () => {
    expect(RECONNECT_DAYS).toBe(14);
  });

  it('lists silent devices, most recently silent first', async () => {
    const { rows, total } = await listReconnect(t.db, { now: NOW });
    expect(ids(rows)).toEqual(['new20', 'edge30', 'edge31', 'long35', 'badDates']);
    expect(total).toBe(5);
  });

  it('fills in the row from DRMS and the linked Vantage equipment', async () => {
    const { rows } = await listReconnect(t.db, { now: NOW });
    const row = rows.find((r) => r.drmsId === 'new20');
    expect(row).toMatchObject({
      serial: 'SNACME20',
      name: 'new20 MFP',
      model: 'bizhub C300i',
      drmsStatus: 'Registered',
      customerName: 'Acme',
      customerReference: 'REF-new20',
      location: 'Reception',
      assetNumber: 'AST-new20',
      hasMeterReadings: true,
      daysSilent: 20,
    });
    expect(row?.vantageEquipmentId).toEqual(expect.any(Number));
    expect(row?.lastContactAt).toEqual(daysAgo(20));
  });

  it("names each device from DRMS's equipment Name when it adds something, else customer and model", async () => {
    const { rows } = await listReconnect(t.db, { now: NOW });
    const pick = (id: string) => rows.find((r) => r.drmsId === id);
    expect(pick('new20')).toMatchObject({ equipmentName: null, displayName: 'Acme bizhub C300i' });
    expect(pick('edge31')).toMatchObject({ equipmentName: 'Edge ThirtyOne Hall C300i', displayName: 'Edge ThirtyOne Hall C300i' });
  });

  it('takes the newest of the meter reading and DRMS alarms as last contact', async () => {
    const { rows } = await listReconnect(t.db, { now: NOW });
    const row = rows.find((r) => r.drmsId === 'long35');
    expect(row?.lastContactAt).toEqual(daysAgo(35));
    expect(row?.lastAlarmAt).toEqual(daysAgo(35));
    expect(row?.daysSilent).toBe(35);
  });

  it('never lists a device that has a recent alarm, from DRMS or our own feed', async () => {
    const all = ids((await listReconnect(t.db, { filter: 'all', now: NOW })).rows);
    expect(all).not.toContain('alarmRescue');
    expect(all).not.toContain('ourAlarm');
    expect(all).not.toContain('fresh');
  });

  it('leaves out unlinked, deleted, missing and off-contract devices', async () => {
    const everything = [
      ...(await listReconnect(t.db, { filter: 'all', now: NOW })).rows,
      ...(await listReconnect(t.db, { filter: 'unmonitored', now: NOW })).rows,
    ].map((r) => r.drmsId);
    for (const id of ['unlinked', 'closedLink', 'deleted', 'missing', 'vDeleted'])
      expect(everything).not.toContain(id);
  });

  it('splits silent devices into newly silent (14–30 days) and long silent (over 30)', async () => {
    expect(ids((await listReconnect(t.db, { filter: 'new', now: NOW })).rows)).toEqual([
      'new20',
      'edge30',
    ]);
    expect(ids((await listReconnect(t.db, { filter: 'long', now: NOW })).rows)).toEqual([
      'edge31',
      'long35',
      'badDates',
    ]);
  });

  it('puts devices with no meter reading ever under "not monitored", registered ones first, never silent', async () => {
    const { rows, total } = await listReconnect(t.db, { filter: 'unmonitored', now: NOW });
    expect(ids(rows)).toEqual(['waiting', 'install']);
    expect(total).toBe(2);
    expect(rows[0]).toMatchObject({
      registeredInDrms: true,
      hasMeterReadings: false,
      daysSilent: null,
      lastAlarmAt: null,
    });
    expect(rows[1]).toMatchObject({
      registeredInDrms: false,
      hasMeterReadings: false,
      daysSilent: null,
      drmsStatus: 'Discovered',
    });
    expect(rows[1]?.firstConnectedAt).toEqual(new Date('2023-08-04T09:00:00Z'));
  });

  it('searches customer name, reference and serial', async () => {
    expect(ids((await listReconnect(t.db, { search: 'acme', now: NOW })).rows)).toEqual(['new20']);
    expect(ids((await listReconnect(t.db, { search: 'snacme', now: NOW })).rows)).toEqual([
      'new20',
    ]);
    expect(ids((await listReconnect(t.db, { search: 'REF-long35', now: NOW })).rows)).toEqual([
      'long35',
    ]);
    expect(
      ids((await listReconnect(t.db, { search: 'frimley', filter: 'unmonitored', now: NOW })).rows),
    ).toEqual(['install']);
  });

  it('pages with limit and offset, keeping the total', async () => {
    const { rows, total } = await listReconnect(t.db, { now: NOW, limit: 2, offset: 2 });
    expect(ids(rows)).toEqual(['edge31', 'long35']);
    expect(total).toBe(5);
  });

  it('honours a different threshold', async () => {
    const { rows } = await listReconnect(t.db, { now: NOW, days: 32 });
    expect(ids(rows)).toEqual(['long35', 'badDates']);
  });

  it('counts agree with the filters', async () => {
    const counts = await getReconnectCounts(t.db, { now: NOW });
    expect(counts).toEqual({ silent: 5, newlySilent: 2, longSilent: 3, unmonitored: 2 });
    const filters: [ReconnectFilter, number][] = [
      ['all', counts.silent],
      ['new', counts.newlySilent],
      ['long', counts.longSilent],
      ['unmonitored', counts.unmonitored],
    ];
    for (const [filter, n] of filters)
      expect((await listReconnect(t.db, { filter, now: NOW })).total).toBe(n);
  });
});

describe('needs reconnecting: the correction rule and DRMS dates', () => {
  let t: TestDb;

  beforeEach(async () => {
    nextVantageId = 1;
    t = await createTestDb();
    await seed(t, [
      // Never a meter reading: an old alarm (DRMS's or ours) does not make a device "silent".
      {
        id: 'oldDrmsAlarm',
        customer: 'Old DRMS Alarm',
        raw: { LastAlarmReceivedTime: drmsDate(daysAgo(40)) },
      },
      { id: 'oldOurAlarm', customer: 'Old Our Alarm' },
      { id: 'pre', customer: 'Pre Ltd', status: 'PreRegistered' },
      // Impossible DRMS dates read as null; they neither throw nor count as contact.
      {
        id: 'zeros',
        customer: 'Zeros',
        counterDaysAgo: 100,
        raw: { LastAlarmReceivedTime: '0000-00-00 00:00:00' },
      },
      {
        id: 'outOfRange',
        customer: 'Out Of Range',
        counterDaysAgo: 100,
        raw: { LastAlarmReceivedTime: '2026-13-40 25:00:00' },
      },
      {
        id: 'feb31',
        customer: 'Feb Thirty-One',
        counterDaysAgo: 100,
        raw: { LastAlarmReceivedTime: '2026-02-31 10:00:00' },
      },
      // ISO-style 'T' separator parses.
      {
        id: 'tSeparated',
        customer: 'T Separated',
        counterDaysAgo: 100,
        raw: { LastAlarmReceivedTime: drmsDate(daysAgo(20)).replace(' ', 'T') },
      },
    ]);
    await t.db
      .insert(deviceAlarms)
      .values({
        alarmId: 'old',
        drmsEquipmentId: 'oldOurAlarm',
        receivedTime: daysAgo(40),
        raw: {},
      });
  });
  afterEach(async () => {
    await t.close();
  });

  it('puts a device with no meter reading under "not monitored" whatever its alarms say', async () => {
    const silent = ids((await listReconnect(t.db, { now: NOW })).rows);
    expect(silent).not.toContain('oldDrmsAlarm');
    expect(silent).not.toContain('oldOurAlarm');
    const { rows } = await listReconnect(t.db, { filter: 'unmonitored', now: NOW });
    expect(rows.find((r) => r.drmsId === 'oldDrmsAlarm')).toMatchObject({
      daysSilent: null,
      lastAlarmAt: daysAgo(40),
    });
    expect(rows.find((r) => r.drmsId === 'oldOurAlarm')).toMatchObject({
      daysSilent: null,
      lastAlarmAt: daysAgo(40),
    });
  });

  it('counts PreRegistered as registered in DRMS', async () => {
    const { rows } = await listReconnect(t.db, { filter: 'unmonitored', now: NOW });
    expect(rows.find((r) => r.drmsId === 'pre')?.registeredInDrms).toBe(true);
  });

  it('reads impossible DRMS dates as null', async () => {
    const { rows } = await listReconnect(t.db, { now: NOW });
    for (const id of ['zeros', 'outOfRange', 'feb31']) {
      expect(rows.find((r) => r.drmsId === id)).toMatchObject({
        lastAlarmAt: null,
        daysSilent: 100,
      });
    }
  });

  it('parses a T-separated DRMS date', async () => {
    const { rows } = await listReconnect(t.db, { now: NOW });
    expect(rows.find((r) => r.drmsId === 'tSeparated')).toMatchObject({
      lastAlarmAt: daysAgo(20),
      lastContactAt: daysAgo(20),
      daysSilent: 20,
    });
  });
});
