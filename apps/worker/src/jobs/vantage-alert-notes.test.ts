import { AuthError, HttpError } from '@mps/core';
import { vantageAlertNotes, vantageCustomerPeople } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import type { VantageRecord } from '@mps/vantage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVantageAlertNotes } from './vantage-alert-notes';

const NOW = new Date('2026-11-28T03:50:00Z');
// Field names as returned by GetNotesViaKeyword (checked live 2026-11-27).
const n = (Id: number, ParentType: string, ParentId: number, extra: object = {}) => ({
  Id,
  Rank: 1,
  ParentId,
  ParentType,
  ParentReference: ParentType === 'Customer' ? 'APLA44' : 'SER1',
  Text: `text ${Id}`,
  IsAlert: true,
  IsInternal: false,
  IsEmail: false,
  LoggedDate: '2020-03-04T09:15:00Z',
  LoggedBy: 'J Bloggs',
  ModifiedDate: '2021-01-02T10:00:00Z',
  ...extra,
});

// Field names as returned by GET /customerperson (checked live 2026-11-27).
const p = (Id: number, CustomerId: number, extra: object = {}) => ({
  Id,
  CustomerId,
  FirstName: 'Jane',
  LastName: `Smith${Id}`,
  FullName: `Jane Smith${Id}`,
  Role: 'Office Manager',
  PhoneNumber: '01234 567890',
  PhoneNumberExtension: null,
  MobileNumber: null,
  EmailAddress: 'jane@example.com',
  IsPrimary: false,
  IsActive: true,
  ModifiedDate: '2022-02-18T11:19:22Z',
  ...extra,
});

function fakeSearch(byWord: Record<string, VantageRecord[] | Error>, people: VantageRecord[] | Error = []) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async listCustomerPeople() {
        calls.push('<people>');
        if (people instanceof Error) throw people;
        return people;
      },
      async searchNotes(word: string) {
        calls.push(word);
        const r = byWord[word] ?? [];
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

describe('runVantageAlertNotes', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('searches each keyword in turn and upserts alert notes on customers and machines only', async () => {
    const v = fakeSearch({
      call: [n(1, 'Customer', 55), n(2, 'Equipment', 9), n(3, 'Customer', 55, { IsAlert: false }), n(4, 'Work', 7)],
      ahead: [n(1, 'Customer', 55), n(5, 'Customer', 56)],
    });
    const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call', 'ahead', 'park'] });
    expect(v.calls).toEqual(['<people>', 'call', 'ahead', 'park']);
    expect(res).toEqual({
      status: 'success',
      stats: {
        keywords: 3,
        failedKeywords: 0,
        hits: 6,
        alerts: 3,
        customerAlerts: 2,
        equipmentAlerts: 1,
        people: 0,
        primaryPeople: 0,
        peopleDeleted: 0,
        peopleFailed: false,
      },
    });
    const rows = (await t.db.select().from(vantageAlertNotes)).sort((a, b) => a.noteId - b.noteId);
    expect(rows.map((r) => [r.noteId, r.parentType, r.parentId])).toEqual([
      [1, 'Customer', 55],
      [2, 'Equipment', 9],
      [5, 'Customer', 56],
    ]);
    expect(rows[0]).toMatchObject({
      parentReference: 'APLA44',
      text: 'text 1',
      loggedBy: 'J Bloggs',
      loggedDate: new Date('2020-03-04T09:15:00Z'),
      lastSeenAt: NOW,
    });
  });

  it('updates a note it sees again and leaves a missing one with its old last-seen time', async () => {
    const OLD = new Date('2026-11-20T03:50:00Z');
    await t.db.insert(vantageAlertNotes).values([
      { noteId: 1, parentType: 'Customer', parentId: 55, text: 'old', raw: {}, lastSeenAt: OLD },
      { noteId: 9, parentType: 'Customer', parentId: 55, text: 'gone', raw: {}, lastSeenAt: OLD },
    ]);
    const v = fakeSearch({ call: [n(1, 'Customer', 55, { Text: 'new' })] });
    await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call'] });
    const rows = (await t.db.select().from(vantageAlertNotes)).sort((a, b) => a.noteId - b.noteId);
    expect(rows.map((r) => [r.noteId, r.text, r.lastSeenAt.toISOString()])).toEqual([
      [1, 'new', NOW.toISOString()],
      [9, 'gone', OLD.toISOString()],
    ]);
  });

  it('skips a keyword that fails and carries on', async () => {
    const v = fakeSearch({ call: new HttpError('bad', 400), ahead: [n(5, 'Customer', 56)] });
    const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call', 'ahead'] });
    expect(res.status).toBe('partial');
    expect(res.stats).toMatchObject({ keywords: 2, failedKeywords: 1, alerts: 1 });
    expect(res.errorSample).toContain('call');
    expect((await t.db.select().from(vantageAlertNotes)).map((r) => r.noteId)).toEqual([5]);
  });

  it('stops on an auth error or a 429, keeping what it found so far', async () => {
    const v = fakeSearch({ call: [n(1, 'Customer', 55)], ahead: new AuthError('no', 401), park: [n(2, 'Customer', 1)] });
    const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call', 'ahead', 'park'] });
    expect(v.calls).toEqual(['<people>', 'call', 'ahead']);
    expect(res.status).toBe('partial');
    expect(res.errorSample).toMatch(/^stopped/);
    expect((await t.db.select().from(vantageAlertNotes)).map((r) => r.noteId)).toEqual([1]);

    const v2 = fakeSearch({ call: new HttpError('slow down', 429) });
    const res2 = await runVantageAlertNotes({ db: t.db, vantage: v2.client, now: () => NOW, keywords: ['call', 'ahead'] });
    expect(v2.calls).toEqual(['<people>', 'call']);
    expect(res2.status).toBe('partial');
  });

  it('is partial, keeping the contacts, when every keyword fails', async () => {
    const v = fakeSearch({ call: new HttpError('down', 503) }, [p(1, 55)]);
    const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call'] });
    expect(res.status).toBe('partial');
    expect(res.stats).toMatchObject({ people: 1, failedKeywords: 1 });
  });

  it('fails when the contacts pull and every keyword fail', async () => {
    const v = fakeSearch({ call: new HttpError('down', 503), ahead: new HttpError('down', 503) }, new HttpError('down', 503));
    await expect(runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call', 'ahead'] })).rejects.toBeInstanceOf(HttpError);
  });

  it('never sends an invalid keyword', async () => {
    const v = fakeSearch({});
    const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['', ' ', 'a', 'call'] });
    expect(v.calls).toEqual(['<people>', 'call']);
    expect(res.stats).toMatchObject({ keywords: 1 });
  });

  describe('site contacts', () => {
    it('upserts every person from a full pull, with separate stats', async () => {
      const v = fakeSearch({}, [p(1, 55, { IsPrimary: true, PhoneNumberExtension: '12' }), p(2, 55), p(3, 56, { IsPrimary: true }), { Id: 4 }]);
      const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call'] });
      expect(res.status).toBe('success');
      expect(res.stats).toMatchObject({ people: 3, primaryPeople: 2, peopleDeleted: 0, peopleFailed: false });
      const rows = (await t.db.select().from(vantageCustomerPeople)).sort((a, b) => a.personId - b.personId);
      expect(rows.map((r) => [r.personId, r.customerId, r.isPrimary])).toEqual([
        [1, 55, true],
        [2, 55, false],
        [3, 56, true],
      ]);
      expect(rows[0]).toMatchObject({
        fullName: 'Jane Smith1',
        role: 'Office Manager',
        phone: '01234 567890',
        extension: '12',
        mobile: null,
        email: 'jane@example.com',
        modifiedDate: new Date('2022-02-18T11:19:22Z'),
        lastSeenAt: NOW,
        deletedAt: null,
      });
    });

    it('marks people missing from the pull as deleted and revives one who comes back', async () => {
      const OLD = new Date('2026-11-27T03:50:00Z');
      await t.db.insert(vantageCustomerPeople).values([
        { personId: 1, customerId: 55, fullName: 'old', raw: {}, lastSeenAt: OLD },
        { personId: 2, customerId: 55, fullName: 'leaves', raw: {}, lastSeenAt: OLD },
        { personId: 3, customerId: 55, fullName: 'back', raw: {}, lastSeenAt: OLD, deletedAt: OLD },
        { personId: 4, customerId: 55, fullName: 'long gone', raw: {}, lastSeenAt: OLD, deletedAt: OLD },
      ]);
      const v = fakeSearch({}, [p(1, 55, { FullName: 'new' }), p(3, 55)]);
      const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call'] });
      expect(res.stats).toMatchObject({ people: 2, peopleDeleted: 1 });
      const rows = (await t.db.select().from(vantageCustomerPeople)).sort((a, b) => a.personId - b.personId);
      expect(rows.map((r) => [r.personId, r.fullName, r.deletedAt?.toISOString() ?? null])).toEqual([
        [1, 'new', null],
        [2, 'leaves', NOW.toISOString()],
        [3, 'Jane Smith3', null],
        [4, 'long gone', OLD.toISOString()],
      ]);
    });

    it('marks nobody deleted when the pull comes back empty', async () => {
      await t.db.insert(vantageCustomerPeople).values({ personId: 1, customerId: 55, raw: {}, lastSeenAt: new Date('2026-11-27T03:50:00Z') });
      const res = await runVantageAlertNotes({ db: t.db, vantage: fakeSearch({}, []).client, now: () => NOW, keywords: ['call'] });
      expect(res.stats).toMatchObject({ people: 0, peopleDeleted: 0 });
      expect((await t.db.select().from(vantageCustomerPeople))[0]?.deletedAt).toBeNull();
    });

    it('still searches notes when the contacts pull fails, and says so', async () => {
      const v = fakeSearch({ call: [n(1, 'Customer', 55)] }, new HttpError('bad', 500));
      const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call'] });
      expect(v.calls).toEqual(['<people>', 'call']);
      expect(res.status).toBe('partial');
      expect(res.stats).toMatchObject({ alerts: 1, people: 0, peopleFailed: true });
      expect(res.errorSample).toMatch(/^contacts:/);
    });

    it('stops the whole run on an auth error from the contacts pull', async () => {
      const v = fakeSearch({ call: [n(1, 'Customer', 55)] }, new AuthError('no', 401));
      const res = await runVantageAlertNotes({ db: t.db, vantage: v.client, now: () => NOW, keywords: ['call'] });
      expect(v.calls).toEqual(['<people>']);
      expect(res.status).toBe('partial');
      expect(res.errorSample).toMatch(/^stopped at contacts/);
    });
  });
});
