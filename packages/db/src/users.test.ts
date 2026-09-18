import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from './schema';
import { createTestDb, type TestDb } from './testing';
import { ensureAdminUser, hashPassword, verifyPassword } from './users';

describe('users', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).not.toContain('correct');
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('creates the admin only when no users exist', async () => {
    expect(await ensureAdminUser(t.db, 'admin', 'a-long-password')).toBe(true);
    expect(await ensureAdminUser(t.db, 'other', 'a-long-password')).toBe(false);
    const rows = await t.db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ username: 'admin', role: 'admin', active: true });
  });
});
