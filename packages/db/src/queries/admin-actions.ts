import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../client';
import { counterNames, users } from '../schema';
import { hashPassword } from '../users';
import { METER_NAMES, TONER_NAMES } from './shared';

/**
 * The write actions behind `/admin`. They live here rather than in the web app so they can be
 * tested against a real Postgres (PGlite) without React.
 *
 * Nothing in this file logs, returns or stores a plaintext password: the only thing that leaves
 * `createUser`/`resetPassword` is the argon2id hash, written straight to `users.password_hash`.
 */

export type AdminErrorCode =
  | 'invalid_username'
  | 'duplicate_username'
  | 'weak_password'
  | 'self_deactivate'
  | 'user_not_found'
  | 'unknown_counter';

/**
 * Anything an admin can get wrong from the UI — always safe to show to the person who did it.
 *
 * The `code` exists so a caller that has to round-trip the failure through a URL can send the
 * code and look the sentence up at the other end, rather than putting attacker-controllable text
 * on a page an admin trusts.
 */
export class AdminActionError extends Error {
  constructor(
    message: string,
    readonly code: AdminErrorCode,
  ) {
    super(message);
    this.name = 'AdminActionError';
  }
}

/** The floor from the plan. Argon2 has no upper bound worth enforcing. */
export const MIN_PASSWORD_LENGTH = 12;

export type UserRole = 'admin' | 'operator';
export type CounterCategory = 'meter' | 'supply' | 'other';

/**
 * Usernames are stored lower-case so `Jo` and `jo` are the same account: the login form looks the
 * user up by an exact match, and a case-varying duplicate would be an invisible second account
 * with its own password.
 */
export function normaliseUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

function assertUsername(raw: string): string {
  const username = normaliseUsername(raw);
  if (username.length < 2) throw new AdminActionError('A username needs at least 2 characters.', 'invalid_username');
  if (username.length > 64) throw new AdminActionError('A username can be at most 64 characters.', 'invalid_username');
  if (/\s/.test(username)) throw new AdminActionError('A username cannot contain spaces.', 'invalid_username');
  return username;
}

function assertPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AdminActionError(`A password needs at least ${MIN_PASSWORD_LENGTH} characters.`, 'weak_password');
  }
  return password;
}

/** Postgres `unique_violation`, wherever the driver happens to have parked it on the error. */
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (typeof e === 'object' && (e as { code?: string }).code === '23505') return true;
  }
  return false;
}

export interface CreateUserArgs {
  username: string;
  /** Plaintext, hashed here and never stored or returned. At least `MIN_PASSWORD_LENGTH` chars. */
  password: string;
  role: UserRole;
}

/**
 * Creates a user and returns the new id. New users are active.
 *
 * The duplicate check is the unique index, not a `select` first: two admins adding the same
 * username at once would both pass a pre-check and one would still hit the constraint, so the
 * constraint is what gets translated into the message.
 */
export async function createUser(db: Db, args: CreateUserArgs): Promise<number> {
  const username = assertUsername(args.username);
  assertPassword(args.password);

  const passwordHash = await hashPassword(args.password);

  try {
    const [row] = await db.insert(users).values({ username, passwordHash, role: args.role }).returning({ id: users.id });
    if (!row) throw new AdminActionError('The user could not be created.', 'duplicate_username');
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AdminActionError(`A user called “${username}” already exists.`, 'duplicate_username');
    throw err;
  }
}

export interface SetUserActiveArgs {
  userId: number;
  active: boolean;
  /**
   * The signed-in admin, from the session. Supplied so that "you cannot deactivate yourself" is
   * enforced here as well as in the UI — a server action is a public POST endpoint, and locking
   * the last admin out of the app is not a mistake worth allowing.
   */
  actorUserId?: number;
}

export async function setUserActive(db: Db, args: SetUserActiveArgs): Promise<void> {
  if (!args.active && args.actorUserId != null && args.actorUserId === args.userId) {
    throw new AdminActionError('You cannot deactivate your own account.', 'self_deactivate');
  }

  const rows = await db
    .update(users)
    .set({ active: args.active })
    .where(eq(users.id, args.userId))
    .returning({ id: users.id });

  if (rows.length === 0) throw new AdminActionError('That user no longer exists.', 'user_not_found');
}

export interface ResetPasswordArgs {
  userId: number;
  /** Plaintext, hashed here and never stored or returned. */
  password: string;
}

/**
 * Replaces a user's password hash. The old password stops working immediately.
 *
 * Sessions are stateless (an iron-session cookie), so an already signed-in browser keeps its
 * session until the cookie expires. Signing everyone out would need a session store or a token
 * version column; nothing in Part 2 has one, and it is called out in the report rather than
 * silently implied by the name "reset".
 */
export async function resetPassword(db: Db, args: ResetPasswordArgs): Promise<void> {
  assertPassword(args.password);
  const passwordHash = await hashPassword(args.password);

  const rows = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, args.userId))
    .returning({ id: users.id });

  if (rows.length === 0) throw new AdminActionError('That user no longer exists.', 'user_not_found');
}

export interface SetCounterCategoryArgs {
  name: string;
  /** `null` clears the category, putting the counter back into "unset". */
  category: CounterCategory | null;
}

/**
 * Categorises one counter name. The row has to exist already — `counter_names` is a catalogue the
 * snapshot job writes as it meets names, so a name nobody has reported is a bad request rather
 * than a new fact about the fleet.
 */
export async function setCounterCategory(db: Db, args: SetCounterCategoryArgs): Promise<void> {
  const rows = await db
    .update(counterNames)
    .set({ category: args.category, updatedAt: new Date() })
    .where(eq(counterNames.name, args.name))
    .returning({ name: counterNames.name });

  if (rows.length === 0) throw new AdminActionError(`No counter called “${args.name}” has been reported yet.`, 'unknown_counter');
}

/** The three billing meters, from the spec. */
export const DEFAULT_METER_CATEGORIES: readonly string[] = Object.values(METER_NAMES);
/** The four toner levels, from the spec. */
export const DEFAULT_SUPPLY_CATEGORIES: readonly string[] = Object.values(TONER_NAMES);

/**
 * The "Set defaults" button: marks the spec's three meters as `meter` and its four toner levels as
 * `supply`, and leaves every other name alone. Returns how many rows were updated, so the UI can
 * say what happened when some of the seven have not been reported by this fleet.
 */
export async function applyDefaultCounterCategories(db: Db): Promise<number> {
  const meters = await db
    .update(counterNames)
    .set({ category: 'meter', updatedAt: new Date() })
    .where(inArray(counterNames.name, [...DEFAULT_METER_CATEGORIES]))
    .returning({ name: counterNames.name });

  const supplies = await db
    .update(counterNames)
    .set({ category: 'supply', updatedAt: new Date() })
    .where(inArray(counterNames.name, [...DEFAULT_SUPPLY_CATEGORIES]))
    .returning({ name: counterNames.name });

  return meters.length + supplies.length;
}
