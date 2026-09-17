import { hash, verify } from '@node-rs/argon2';
import type { Db } from './client';
import { users } from './schema';

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Creates the first admin only when the users table is empty. Returns true if created. */
export async function ensureAdminUser(db: Db, username: string, password: string): Promise<boolean> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return false;
  await db.insert(users).values({ username, passwordHash: await hashPassword(password), role: 'admin' });
  return true;
}
