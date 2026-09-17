import {
  AuthError,
  ErrorCollector,
  RateLimitError,
  chunk,
  errorMessage,
  mapPool,
  parseApiDate,
} from '@mps/core';
import { counterNames, counterSnapshots, counterValues, drmsEquipment, type Db } from '@mps/db';
import type { DrmsClient, DrmsCounter, DrmsLatestCounters } from '@mps/drms';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';
import { startOfUtcDay } from '../time';

const CHUNK = 500;

export interface FlatCounter {
  itemNumber: string | null;
  name: string;
  value: number | null;
  colorMode: string | null;
  mode: string | null;
}

function toNumber(v: DrmsCounter['Value']): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function flattenCounters(c: DrmsLatestCounters): FlatCounter[] {
  const flat = (x: DrmsCounter, colorMode: string | null, mode: string | null): FlatCounter => ({
    itemNumber: x.ItemNumber == null ? null : String(x.ItemNumber),
    name: x.Name,
    value: toNumber(x.Value),
    colorMode,
    mode,
  });
  const out = (c.Counters ?? []).map((x) => flat(x, null, null));
  for (const group of c.ModeSizeCounters ?? []) {
    for (const x of group.Counters ?? []) out.push(flat(x, group.ColorMode ?? null, group.Mode ?? null));
  }
  return out;
}

export async function saveSnapshot(db: Db, drmsId: string, c: DrmsLatestCounters, fetchedAt: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [snap] = await tx
      .insert(counterSnapshots)
      .values({
        drmsEquipmentId: drmsId,
        counterId: c.CounterId,
        receivedTime: parseApiDate(c.ReceivedTime),
        fetchedAt,
        raw: c,
      })
      .onConflictDoNothing({ target: [counterSnapshots.drmsEquipmentId, counterSnapshots.counterId] })
      .returning({ id: counterSnapshots.id });
    if (!snap) return false;

    const values = flattenCounters(c);
    for (const rows of chunk(values, CHUNK)) {
      await tx.insert(counterValues).values(rows.map((v) => ({ ...v, snapshotId: snap.id })));
    }

    const firstByName = new Map<string, FlatCounter>();
    for (const v of values) if (!firstByName.has(v.name)) firstByName.set(v.name, v);
    for (const rows of chunk([...firstByName.values()], CHUNK)) {
      await tx
        .insert(counterNames)
        .values(rows.map((v) => ({ name: v.name, firstSeen: fetchedAt, sampleValue: v.value, updatedAt: fetchedAt })))
        .onConflictDoUpdate({
          target: counterNames.name,
          set: { sampleValue: sql.raw('excluded."sample_value"'), updatedAt: fetchedAt },
        });
    }
    return true;
  });
}

export interface DrmsSnapshotDeps {
  db: Db;
  drms: Pick<DrmsClient, 'latestCounters'>;
  now?: () => Date;
  concurrency?: number;
}

export async function runDrmsSnapshot(deps: DrmsSnapshotDeps): Promise<JobResult> {
  const { db, drms } = deps;
  const now = deps.now ?? (() => new Date());
  const dayStart = startOfUtcDay(now());

  const devices = await db
    .select({ drmsId: drmsEquipment.drmsId })
    .from(drmsEquipment)
    .where(
      and(
        sql`upper(${drmsEquipment.status}) in ('REGISTERED', 'DISCOVERED')`,
        isNull(drmsEquipment.missingSince),
        or(isNull(drmsEquipment.lastSnapshotFetchAt), lt(drmsEquipment.lastSnapshotFetchAt, dayStart)),
      ),
    )
    .orderBy(asc(drmsEquipment.drmsId));

  const stats = { devices: devices.length, inserted: 0, unchanged: 0, empty: 0, errors: 0, skippedAfterStop: 0 };
  const errors = new ErrorCollector();
  let stopError: unknown = null;
  let attempted = 0;

  await mapPool(
    devices,
    deps.concurrency ?? 5,
    async ({ drmsId }) => {
      attempted++;
      try {
        const counters = await drms.latestCounters(drmsId);
        if (!counters) stats.empty++;
        else if (await saveSnapshot(db, drmsId, counters, now())) stats.inserted++;
        else stats.unchanged++;
        await db.update(drmsEquipment).set({ lastSnapshotFetchAt: now() }).where(eq(drmsEquipment.drmsId, drmsId));
      } catch (err) {
        if (err instanceof RateLimitError || err instanceof AuthError) {
          stopError ??= err;
          return;
        }
        errors.add(drmsId, err);
      }
    },
    () => stopError !== null,
  );

  stats.errors = errors.count;
  stats.skippedAfterStop = devices.length - attempted;
  if (stopError) {
    return { status: 'partial', stats, errorSample: `stopped: ${errorMessage(stopError)}` };
  }
  return { status: errors.count > 0 ? 'partial' : 'success', stats, errorSample: errors.sample };
}
