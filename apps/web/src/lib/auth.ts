import { users, verifyPassword, type Db } from '@mps/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getSession, type SessionData } from './session';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'operator';
}

export type CurrentUser = SessionData & { userId: number };

/**
 * A real argon2id hash of a throwaway string. When the username doesn't exist we still verify
 * against this, so a missing user costs the same as a wrong password and the login form can't be
 * used to enumerate accounts. Nothing verifies against it successfully.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$dYJb5PlhGPFFm3LoUayzXw$8NI2l+P4NyxUXDSUYTTiXqxGF+i2mtzrEv+uDBF0weA';

/** Looks the user up, requires `active`, and checks the password. Returns null on any failure. */
export async function authenticate(db: Db, username: string, password: string): Promise<AuthUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      active: users.active,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  // Always verify, even when there's no user, so every failure path takes the same time.
  const passwordOk = await verifyPassword(row?.passwordHash ?? DUMMY_HASH, password);

  if (!row || !row.active || !passwordOk) return null;
  return { id: row.id, username: row.username, role: row.role };
}

/** The signed-in user, or a redirect to the login page. */
export async function requireUser(): Promise<CurrentUser> {
  const session = await getSession();
  if (!session.userId) redirect('/login');
  return { ...session, userId: session.userId };
}

/** Admin-only pages. Signed-out users go to the login page, operators back to the dashboard. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== 'admin') redirect('/');
  return user;
}
