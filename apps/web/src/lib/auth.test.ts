import { hashPassword, users } from '@mps/db';
import { createTestDb, type TestDb } from '@mps/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from './auth';

describe('authenticate', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { username: 'ada', passwordHash: await hashPassword('correct horse'), role: 'admin', active: true },
      { username: 'grace', passwordHash: await hashPassword('correct horse'), role: 'operator', active: true },
      { username: 'dormant', passwordHash: await hashPassword('correct horse'), role: 'operator', active: false },
    ]);
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('returns the user for the correct password', async () => {
    const user = await authenticate(testDb.db, 'ada', 'correct horse');
    expect(user).toEqual({ id: expect.any(Number), username: 'ada', role: 'admin' });
  });

  it('keeps the role of non-admin users', async () => {
    const user = await authenticate(testDb.db, 'grace', 'correct horse');
    expect(user?.role).toBe('operator');
  });

  it('returns null for a wrong password', async () => {
    expect(await authenticate(testDb.db, 'ada', 'wrong horse')).toBeNull();
  });

  it('returns null for an unknown user', async () => {
    expect(await authenticate(testDb.db, 'nobody', 'correct horse')).toBeNull();
  });

  it('returns null for an inactive user even with the right password', async () => {
    expect(await authenticate(testDb.db, 'dormant', 'correct horse')).toBeNull();
  });

  it('never leaks the password hash', async () => {
    const user = await authenticate(testDb.db, 'ada', 'correct horse');
    expect(Object.keys(user ?? {})).toEqual(['id', 'username', 'role']);
  });

  it('takes a comparable amount of time for an unknown user as for a wrong password', async () => {
    const time = async (username: string) => {
      const started = performance.now();
      await authenticate(testDb.db, username, 'wrong horse');
      return performance.now() - started;
    };
    // Warm the argon2 module up so the first call doesn't skew the comparison.
    await time('ada');

    const wrongPassword = await time('ada');
    const unknownUser = await time('nobody');

    // A missing user must still pay for a hash verification (dummy-hash compare), so the two
    // paths land in the same ballpark rather than the unknown user returning instantly.
    expect(unknownUser).toBeGreaterThan(wrongPassword * 0.4);
  });
});
