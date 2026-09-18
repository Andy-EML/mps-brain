import { chunk, errorMessage, normaliseSerial, parseApiDate } from '@mps/core';
import { drmsCustomers, drmsEquipment, excluded, type Db } from '@mps/db';
import type { DrmsClient, DrmsCustomer, DrmsEquipment } from '@mps/drms';
import { and, isNull, lt, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';
import { evaluateOfflineAlerts } from './alerts-evaluate';

const CHUNK = 500;
const DEFAULT_OFFLINE_ALERT_HOURS = 24;

export function mapDrmsEquipment(e: DrmsEquipment, seenAt: Date): typeof drmsEquipment.$inferInsert {
  return {
    drmsId: e.Id,
    erpId: e.ErpId ?? null,
    serial: e.SerialNumber ?? null,
    serialNorm: normaliseSerial(e.SerialNumber),
    modelName: e.ModelName ?? null,
    productName: e.ProductName ?? null,
    status: e.Status ?? null,
    communicationType: e.CommunicationType ?? null,
    customerErpId: e.CustomerErpId ?? null,
    customerName: e.CustomerName ?? null,
    customerCsrcId: e.CustomerCsrcId ?? null,
    registrationTime: parseApiDate(e.RegistrationTime),
    initialConnectionTime: parseApiDate(e.InitialConnectionTime),
    lastCounterReceivedTime: parseApiDate(e.LastCounterReceivedTime),
    // Only takes effect on first INSERT: onConflictDoUpdate keeps the existing row's
    // firstSeenAt (see `excluded(..., ['firstSeenAt', ...])` below), so this seeds it
    // deterministically from `seenAt` instead of falling back to the column's
    // defaultNow() (real wall-clock time), which broke determinism against `now()`.
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    missingSince: null,
    raw: e,
    syncedAt: seenAt,
  };
}

function mapDrmsCustomer(c: DrmsCustomer, syncedAt: Date): typeof drmsCustomers.$inferInsert {
  return {
    drmsId: c.Id,
    erpId: c.ErpId ?? null,
    name: c.Name ?? null,
    csrcIds: c.CsrcIds ?? null,
    raw: c,
    syncedAt,
  };
}

export interface DrmsPullDeps {
  db: Db;
  drms: Pick<DrmsClient, 'listEquipment' | 'listCustomers'>;
  now?: () => Date;
  thresholdHours?: number;
}

export async function runDrmsPull(deps: DrmsPullDeps): Promise<JobResult> {
  const { db, drms } = deps;
  const seenAt = (deps.now ?? (() => new Date()))();

  const equipment = await drms.listEquipment();
  if (equipment.length === 0) {
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(drmsEquipment);
    if (n > 0) throw new Error('DRMS returned 0 devices; refusing to mark the fleet missing');
  }

  for (const rows of chunk(equipment.map((e) => mapDrmsEquipment(e, seenAt)), CHUNK)) {
    await db
      .insert(drmsEquipment)
      .values(rows)
      .onConflictDoUpdate({
        target: drmsEquipment.drmsId,
        set: excluded(drmsEquipment, ['drmsId', 'firstSeenAt', 'lastSnapshotFetchAt']),
      });
  }

  const markedMissing = (
    await db
      .update(drmsEquipment)
      .set({ missingSince: seenAt })
      .where(and(lt(drmsEquipment.lastSeenAt, seenAt), isNull(drmsEquipment.missingSince)))
      .returning({ id: drmsEquipment.drmsId })
  ).length;

  const alerts = await evaluateOfflineAlerts(db, {
    now: seenAt,
    thresholdHours: deps.thresholdHours ?? DEFAULT_OFFLINE_ALERT_HOURS,
  });

  let customers = 0;
  let errorSample: string | undefined;
  try {
    const list = await drms.listCustomers();
    for (const rows of chunk(list.map((c) => mapDrmsCustomer(c, seenAt)), CHUNK)) {
      await db
        .insert(drmsCustomers)
        .values(rows)
        .onConflictDoUpdate({ target: drmsCustomers.drmsId, set: excluded(drmsCustomers, ['drmsId']) });
    }
    customers = list.length;
  } catch (err) {
    errorSample = `customers: ${errorMessage(err)}`;
  }

  return {
    status: errorSample ? 'partial' : 'success',
    stats: {
      equipment: equipment.length,
      markedMissing,
      customers,
      alertsOpened: alerts.opened,
      alertsCleared: alerts.cleared,
    },
    errorSample,
  };
}
