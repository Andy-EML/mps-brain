import { createDb, type Db } from '@mps/db';
import type pg from 'pg';
import { requiredEnv } from './env';

/**
 * One pooled connection per process. Next.js re-evaluates route modules on every hot reload in
 * dev, so the pool is parked on `globalThis` — without that, each edit would leak a pool and the
 * server would run out of Postgres connections within a few saves.
 */
const globalForDb = globalThis as typeof globalThis & {
  __mpsDb?: { db: Db; pool: pg.Pool };
};

function connect(): { db: Db; pool: pg.Pool } {
  return createDb(requiredEnv('DATABASE_URL'));
}

/** The shared `Db` for this process. Created on first use so `next build` never needs the env. */
export function getDb(): Db {
  globalForDb.__mpsDb ??= connect();
  return globalForDb.__mpsDb.db;
}
