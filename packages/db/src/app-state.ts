import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { appState } from './schema';

export async function getAppState<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select({ value: appState.value }).from(appState).where(eq(appState.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function setAppState(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: new Date() } });
}
