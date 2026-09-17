import { fileURLToPath } from 'node:url';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client';
import type * as schema from './schema';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db as unknown as NodePgDatabase<typeof schema>, { migrationsFolder });
}
