import { AuthError, ParseError } from '@mps/core';
import { vantageEngineers } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeVantageEngineers } from '../test-helpers';
import { mapEngineer, runVantageEngineers } from './vantage-engineers';

const NOW = new Date('2026-11-23T03:15:00Z');
// Field names as seen on the live Engineer entity (checked 2026-11-23): Id, Name, IsActive, DeletedDate.
const eng = (Id: number, Name: string | null, extra: object = {}) => ({ Id, Name, IsActive: true, DeletedDate: null, ...extra });

describe('mapEngineer', () => {
  it('maps id, name and the active flag', () => {
    expect(mapEngineer(eng(4, 'A Engineer'), NOW)).toMatchObject({ vantageId: 4, name: 'A Engineer', isActive: true, syncedAt: NOW });
    expect(mapEngineer(eng(5, 'B', { IsActive: false }), NOW)?.isActive).toBe(false);
  });
  it('skips a record without an id', () => {
    expect(mapEngineer({ Name: 'x' }, NOW)).toBeNull();
  });
});

describe('runVantageEngineers', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('replaces the table with the fetched engineers and skips id-less records', async () => {
    await t.db.insert(vantageEngineers).values({ vantageId: 99, name: 'Gone', raw: {} });
    const v = fakeVantageEngineers([eng(1, 'A'), eng(2, 'B', { IsActive: false }), { Name: 'no id' }]);
    const res = await runVantageEngineers({ db: t.db, vantage: v.client, now: () => NOW });
    expect(res).toMatchObject({ status: 'success', stats: { engineers: 2, skipped: 1 } });
    const rows = (await t.db.select().from(vantageEngineers)).sort((a, b) => a.vantageId - b.vantageId);
    expect(rows.map((r) => [r.vantageId, r.name, r.isActive])).toEqual([[1, 'A', true], [2, 'B', false]]);
  });

  it('fails on an empty answer and keeps the previous rows', async () => {
    await t.db.insert(vantageEngineers).values({ vantageId: 7, name: 'Keep', raw: {} });
    await expect(runVantageEngineers({ db: t.db, vantage: fakeVantageEngineers([]).client, now: () => NOW })).rejects.toBeInstanceOf(ParseError);
    expect((await t.db.select().from(vantageEngineers)).map((r) => r.vantageId)).toEqual([7]);
  });

  it('reports partial on an auth error and keeps the previous rows', async () => {
    await t.db.insert(vantageEngineers).values({ vantageId: 7, name: 'Keep', raw: {} });
    const res = await runVantageEngineers({ db: t.db, vantage: fakeVantageEngineers(new AuthError('no', 401)).client, now: () => NOW });
    expect(res.status).toBe('partial');
    expect((await t.db.select().from(vantageEngineers)).map((r) => r.vantageId)).toEqual([7]);
  });
});
