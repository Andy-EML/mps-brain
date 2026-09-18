import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { counterNames, users } from '../schema';
import { createTestDb, type TestDb } from '../testing';
import { verifyPassword } from '../users';
import {
  AdminActionError,
  applyDefaultCounterCategories,
  createUser,
  resetPassword,
  setCounterCategory,
  setUserActive,
} from './admin-actions';

/** Twelve characters is the floor, so the fixtures sit either side of it deliberately. */
const GOOD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'another twelve plus password';
const SHORT_PASSWORD = 'eleven char';

describe('admin-actions', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  const rowById = (id: number) =>
    t.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0]);

  describe('createUser', () => {
    it('stores a hash, never the password itself', async () => {
      const id = await createUser(t.db, { username: 'jo', password: GOOD_PASSWORD, role: 'operator' });

      const row = await rowById(id);
      expect(row).toBeDefined();
      // Not just "the column isn't the password" — the whole row must not contain it anywhere.
      expect(JSON.stringify(row)).not.toContain(GOOD_PASSWORD);
      expect(row!.passwordHash).toMatch(/^\$argon2/);
      expect(await verifyPassword(row!.passwordHash, GOOD_PASSWORD)).toBe(true);
    });

    it('stores the username lower-cased and trimmed, and keeps the role and active default', async () => {
      const id = await createUser(t.db, { username: '  Jo.Bloggs  ', password: GOOD_PASSWORD, role: 'admin' });

      const row = await rowById(id);
      expect(row!.username).toBe('jo.bloggs');
      expect(row!.role).toBe('admin');
      expect(row!.active).toBe(true);
    });

    it('rejects a duplicate username, whatever the case', async () => {
      await createUser(t.db, { username: 'jo', password: GOOD_PASSWORD, role: 'operator' });

      await expect(
        createUser(t.db, { username: 'JO', password: GOOD_PASSWORD, role: 'admin' }),
      ).rejects.toThrow(AdminActionError);
      // The code is what the web layer round-trips through a URL, so it is part of the contract.
      await expect(
        createUser(t.db, { username: 'JO', password: GOOD_PASSWORD, role: 'admin' }),
      ).rejects.toMatchObject({ code: 'duplicate_username' });

      const all = await t.db.select().from(users);
      expect(all).toHaveLength(1);
      expect(all[0]!.role).toBe('operator');
    });

    it('rejects a password under 12 characters and writes nothing', async () => {
      await expect(
        createUser(t.db, { username: 'jo', password: SHORT_PASSWORD, role: 'operator' }),
      ).rejects.toThrow(/12/);

      expect(await t.db.select().from(users)).toHaveLength(0);
    });

    it('rejects an empty or whitespace-only username', async () => {
      await expect(createUser(t.db, { username: '   ', password: GOOD_PASSWORD, role: 'operator' })).rejects.toThrow(
        AdminActionError,
      );
      await expect(createUser(t.db, { username: 'a b', password: GOOD_PASSWORD, role: 'operator' })).rejects.toThrow(
        AdminActionError,
      );

      expect(await t.db.select().from(users)).toHaveLength(0);
    });
  });

  describe('setUserActive', () => {
    let jo: number;
    let admin: number;

    beforeEach(async () => {
      admin = await createUser(t.db, { username: 'admin', password: GOOD_PASSWORD, role: 'admin' });
      jo = await createUser(t.db, { username: 'jo', password: GOOD_PASSWORD, role: 'operator' });
    });

    it('deactivates and reactivates a user', async () => {
      await setUserActive(t.db, { userId: jo, active: false });
      expect((await rowById(jo))!.active).toBe(false);

      await setUserActive(t.db, { userId: jo, active: true });
      expect((await rowById(jo))!.active).toBe(true);
    });

    it('refuses to let a user deactivate their own account', async () => {
      await expect(setUserActive(t.db, { userId: admin, active: false, actorUserId: admin })).rejects.toMatchObject({
        name: 'AdminActionError',
        code: 'self_deactivate',
      });

      expect((await rowById(admin))!.active).toBe(true);
    });

    it('still lets an admin deactivate somebody else', async () => {
      await setUserActive(t.db, { userId: jo, active: false, actorUserId: admin });
      expect((await rowById(jo))!.active).toBe(false);
    });

    it('rejects a user id that does not exist', async () => {
      await expect(setUserActive(t.db, { userId: 99_999, active: false })).rejects.toThrow(AdminActionError);
    });
  });

  describe('resetPassword', () => {
    let jo: number;

    beforeEach(async () => {
      jo = await createUser(t.db, { username: 'jo', password: GOOD_PASSWORD, role: 'operator' });
    });

    it('invalidates the old password and accepts the new one', async () => {
      const before = (await rowById(jo))!.passwordHash;

      await resetPassword(t.db, { userId: jo, password: NEW_PASSWORD });

      const after = (await rowById(jo))!.passwordHash;
      expect(after).not.toBe(before);
      expect(await verifyPassword(after, GOOD_PASSWORD)).toBe(false);
      expect(await verifyPassword(after, NEW_PASSWORD)).toBe(true);
      expect(JSON.stringify(await rowById(jo))).not.toContain(NEW_PASSWORD);
    });

    it('rejects a password under 12 characters and leaves the old one working', async () => {
      await expect(resetPassword(t.db, { userId: jo, password: SHORT_PASSWORD })).rejects.toThrow(/12/);

      const hash = (await rowById(jo))!.passwordHash;
      expect(await verifyPassword(hash, GOOD_PASSWORD)).toBe(true);
    });

    it('rejects a user id that does not exist', async () => {
      await expect(resetPassword(t.db, { userId: 99_999, password: NEW_PASSWORD })).rejects.toThrow(AdminActionError);
    });
  });

  describe('setCounterCategory', () => {
    beforeEach(async () => {
      await t.db.insert(counterNames).values([
        { name: 'Black:Total', sampleValue: 15_000 },
        { name: 'A4', sampleValue: 29 },
      ]);
    });

    const categoryOf = (name: string) =>
      t.db
        .select()
        .from(counterNames)
        .where(eq(counterNames.name, name))
        .then((rows) => rows[0]?.category ?? null);

    it('sets a category and clears it again', async () => {
      await setCounterCategory(t.db, { name: 'Black:Total', category: 'meter' });
      expect(await categoryOf('Black:Total')).toBe('meter');

      await setCounterCategory(t.db, { name: 'Black:Total', category: 'supply' });
      expect(await categoryOf('Black:Total')).toBe('supply');

      await setCounterCategory(t.db, { name: 'Black:Total', category: null });
      expect(await categoryOf('Black:Total')).toBeNull();
    });

    it('touches only the counter it is given', async () => {
      await setCounterCategory(t.db, { name: 'Black:Total', category: 'meter' });
      expect(await categoryOf('A4')).toBeNull();
    });

    it('rejects a counter name the snapshot job has never seen', async () => {
      await expect(setCounterCategory(t.db, { name: 'NoSuchCounter', category: 'meter' })).rejects.toThrow(
        AdminActionError,
      );
    });
  });

  describe('applyDefaultCounterCategories', () => {
    beforeEach(async () => {
      await t.db.insert(counterNames).values([
        { name: 'Black:Total' },
        { name: 'Full Color:Total' },
        { name: 'Scanner/FAX:Scan' },
        { name: 'BlackTonerLevel' },
        { name: 'CyanTonerLevel' },
        { name: 'MagentaTonerLevel' },
        { name: 'YellowTonerLevel' },
        { name: 'A4', category: 'other' },
      ]);
    });

    it('marks the three meters and four toner levels, and nothing else', async () => {
      const changed = await applyDefaultCounterCategories(t.db);
      expect(changed).toBe(7);

      const rows = await t.db.select().from(counterNames);
      const byName = Object.fromEntries(rows.map((r) => [r.name, r.category]));
      expect(byName).toEqual({
        'Black:Total': 'meter',
        'Full Color:Total': 'meter',
        'Scanner/FAX:Scan': 'meter',
        BlackTonerLevel: 'supply',
        CyanTonerLevel: 'supply',
        MagentaTonerLevel: 'supply',
        YellowTonerLevel: 'supply',
        A4: 'other',
      });
    });

    it('is idempotent and ignores names the fleet has not reported', async () => {
      await t.db.delete(counterNames).where(eq(counterNames.name, 'YellowTonerLevel'));

      expect(await applyDefaultCounterCategories(t.db)).toBe(6);
      expect(await applyDefaultCounterCategories(t.db)).toBe(6);
    });
  });
});
