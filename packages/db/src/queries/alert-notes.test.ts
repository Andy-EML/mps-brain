import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../testing';
import { vantageAlertNotes, vantageCustomerPeople, vantageCustomers, vantageEquipment } from '../schema';
import {
  getContactPhone,
  getCustomerAlerts,
  getCustomerContact,
  getCustomerPeople,
  getCustomerPhone,
  getDeviceAlerts,
  getDeviceContact,
} from './alert-notes';

const NOW = new Date('2026-11-27T12:00:00Z');
const DAY = 86_400_000;

function note(noteId: number, parentType: 'Customer' | 'Equipment', parentId: number, extra: Partial<typeof vantageAlertNotes.$inferInsert> = {}) {
  return {
    noteId,
    parentType,
    parentId,
    parentReference: parentType === 'Customer' ? 'APLA44' : 'A1B2C3',
    text: `note ${noteId}`,
    loggedDate: new Date('2025-01-01T00:00:00Z'),
    loggedBy: 'J Bloggs',
    raw: {},
    lastSeenAt: NOW,
    ...extra,
  };
}

describe('alert notes and phone', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageCustomers).values([
      { vantageId: 1, name: 'Acme', raw: { PhoneNumber: ' 01234 567890 ' } },
      { vantageId: 2, name: 'Blank', raw: { PhoneNumber: '   ' } },
      { vantageId: 3, name: 'None', raw: {} },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 10, serial: 'A1B2C3', vantageCustomerId: 1, raw: {} },
      { vantageId: 11, serial: 'X', vantageCustomerId: 2, raw: {} },
      { vantageId: 12, serial: 'Y', vantageCustomerId: null, raw: {} },
    ]);
    await t.db.insert(vantageAlertNotes).values([
      note(100, 'Customer', 1, { loggedDate: new Date('2024-01-01T00:00:00Z') }),
      note(101, 'Customer', 1, { loggedDate: new Date('2025-06-01T00:00:00Z') }),
      // Not seen for 8 days: gone.
      note(102, 'Customer', 1, { lastSeenAt: new Date(NOW.getTime() - 8 * DAY) }),
      // Seen 6 days ago: still shown.
      note(103, 'Customer', 1, { loggedDate: null, lastSeenAt: new Date(NOW.getTime() - 6 * DAY) }),
      note(200, 'Equipment', 10),
      note(201, 'Equipment', 11),
      note(202, 'Equipment', 12),
      // Same numeric id as a machine, but a customer note: must not attach to machine 10.
      note(300, 'Customer', 10),
    ]);
  });
  afterEach(() => t.close());

  it('getCustomerAlerts: the customer’s own fresh notes, newest first, nulls last', async () => {
    const rows = await getCustomerAlerts(t.db, 1, NOW);
    expect(rows.map((r) => r.noteId)).toEqual([101, 100, 103]);
    expect(rows[0]).toMatchObject({ parentType: 'Customer', parentReference: 'APLA44', text: 'note 101', loggedBy: 'J Bloggs' });
    expect(await getCustomerAlerts(t.db, 3, NOW)).toEqual([]);
  });

  it('getDeviceAlerts: the machine’s notes first, then its customer’s', async () => {
    const rows = await getDeviceAlerts(t.db, { vantageEquipmentId: 10 }, NOW);
    expect(rows.map((r) => [r.noteId, r.parentType])).toEqual([
      [200, 'Equipment'],
      [101, 'Customer'],
      [100, 'Customer'],
      [103, 'Customer'],
    ]);
  });

  it('getDeviceAlerts: a machine with no customer, or not synced, gets its own notes only', async () => {
    expect((await getDeviceAlerts(t.db, { vantageEquipmentId: 12 }, NOW)).map((r) => r.noteId)).toEqual([202]);
    expect(await getDeviceAlerts(t.db, { vantageEquipmentId: 999 }, NOW)).toEqual([]);
  });

  it('getCustomerPhone: trimmed, blank or missing is null', async () => {
    expect(await getCustomerPhone(t.db, 1)).toBe('01234 567890');
    expect(await getCustomerPhone(t.db, 2)).toBeNull();
    expect(await getCustomerPhone(t.db, 3)).toBeNull();
    expect(await getCustomerPhone(t.db, 999)).toBeNull();
  });

  it('getCustomerContact and getDeviceContact combine phone and alerts', async () => {
    const c = await getCustomerContact(t.db, 1, NOW);
    expect(c).toMatchObject({ vantageCustomerId: 1, phone: '01234 567890' });
    expect(c.alerts).toHaveLength(3);

    const d = await getDeviceContact(t.db, { vantageEquipmentId: 11 }, NOW);
    expect(d).toMatchObject({ vantageCustomerId: 2, phone: null });
    expect(d.alerts.map((r) => r.noteId)).toEqual([201]);

    expect(await getDeviceContact(t.db, { vantageEquipmentId: 12 }, NOW)).toMatchObject({ vantageCustomerId: null, phone: null });
  });
});

describe('head office phone fallback and site contacts', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await t.db.insert(vantageCustomers).values([
      // Head office with its own number.
      { vantageId: 1, name: 'HQ', raw: { PhoneNumber: '0207 000000', HeadOfficeId: null } },
      // Site with no number: falls back to HQ.
      { vantageId: 2, name: 'Site A', raw: { PhoneNumber: ' ', HeadOfficeId: 1 } },
      // Site with its own number.
      { vantageId: 3, name: 'Site B', raw: { PhoneNumber: '01234 567890', HeadOfficeId: 1 } },
      // Site whose head office has no number either.
      { vantageId: 4, name: 'Site C', raw: { HeadOfficeId: 5 } },
      { vantageId: 5, name: 'HQ2', raw: { PhoneNumber: '' } },
      // Names itself as head office.
      { vantageId: 6, name: 'Self', raw: { HeadOfficeId: 6 } },
      // Head office not synced.
      { vantageId: 7, name: 'Orphan', raw: { HeadOfficeId: 999 } },
    ]);
    await t.db.insert(vantageEquipment).values([
      { vantageId: 20, serial: 'S20', vantageCustomerId: 2, raw: {} },
      { vantageId: 21, serial: 'S21', vantageCustomerId: 3, raw: {} },
    ]);
    const person = (personId: number, customerId: number, extra: Partial<typeof vantageCustomerPeople.$inferInsert> = {}) => ({
      personId,
      customerId,
      fullName: `Person ${personId}`,
      phone: '01234 111111',
      raw: {},
      lastSeenAt: NOW,
      ...extra,
    });
    await t.db.insert(vantageCustomerPeople).values([
      person(1, 1, { isPrimary: true, fullName: 'HQ Boss' }),
      person(2, 2, { fullName: 'Zoe', role: 'Reception' }),
      person(3, 2, { fullName: 'Adam', isPrimary: true, role: 'Office Manager', extension: '12', mobile: '07700 900123', email: 'adam@example.com' }),
      person(4, 2, { fullName: 'Bea' }),
      person(5, 2, { fullName: 'Gone', deletedAt: NOW }),
      person(6, 3, { fullName: null }),
    ]);
  });
  afterEach(() => t.close());

  it('getContactPhone: the site’s own number, else the head office’s, labelled', async () => {
    expect(await getContactPhone(t.db, 1)).toEqual({ phone: '0207 000000', source: 'site' });
    expect(await getContactPhone(t.db, 2)).toEqual({ phone: '0207 000000', source: 'headOffice' });
    expect(await getContactPhone(t.db, 3)).toEqual({ phone: '01234 567890', source: 'site' });
    expect(await getContactPhone(t.db, 4)).toBeNull();
    expect(await getContactPhone(t.db, 6)).toBeNull();
    expect(await getContactPhone(t.db, 7)).toBeNull();
    expect(await getContactPhone(t.db, 999)).toBeNull();
  });

  it('getCustomerPeople: the site’s live contacts, primary first then by name; never the head office’s', async () => {
    const rows = await getCustomerPeople(t.db, 2);
    expect(rows.map((r) => [r.personId, r.fullName, r.isPrimary])).toEqual([
      [3, 'Adam', true],
      [4, 'Bea', false],
      [2, 'Zoe', false],
    ]);
    expect(rows[0]).toEqual({
      personId: 3,
      fullName: 'Adam',
      role: 'Office Manager',
      phone: '01234 111111',
      extension: '12',
      mobile: '07700 900123',
      email: 'adam@example.com',
      isPrimary: true,
    });
    expect((await getCustomerPeople(t.db, 3)).map((r) => r.personId)).toEqual([6]);
    expect(await getCustomerPeople(t.db, 999)).toEqual([]);
  });

  it('getCustomerContact and getDeviceContact carry the fallback phone and the site contacts', async () => {
    const site = await getCustomerContact(t.db, 2, NOW);
    expect(site).toMatchObject({ vantageCustomerId: 2, phone: '0207 000000', phoneSource: 'headOffice' });
    expect(site.contacts.map((c) => c.personId)).toEqual([3, 4, 2]);

    const hq = await getCustomerContact(t.db, 1, NOW);
    expect(hq).toMatchObject({ phone: '0207 000000', phoneSource: 'site' });
    expect(hq.contacts.map((c) => c.personId)).toEqual([1]);

    const d = await getDeviceContact(t.db, { vantageEquipmentId: 20 }, NOW);
    expect(d).toMatchObject({ vantageCustomerId: 2, phone: '0207 000000', phoneSource: 'headOffice' });
    expect(d.contacts.map((c) => c.personId)).toEqual([3, 4, 2]);

    const d2 = await getDeviceContact(t.db, { vantageEquipmentId: 21 }, NOW);
    expect(d2).toMatchObject({ phone: '01234 567890', phoneSource: 'site' });

    expect(await getDeviceContact(t.db, { vantageEquipmentId: 999 }, NOW)).toEqual({
      vantageCustomerId: null,
      phone: null,
      phoneSource: null,
      alerts: [],
      contacts: [],
    });
  });
});
