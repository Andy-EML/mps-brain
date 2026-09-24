import {
  AuthError,
  ErrorCollector,
  HttpError,
  RateLimitError,
  autoRegisterEligibility,
  drmsCandidateCheck,
  type DrmsRegistrationRecord,
  type DrmsSkipCode,
} from '@mps/core';
import { drmsEquipment, drmsRegistrations, type Db } from '@mps/db';
import type { VantageClient } from '@mps/vantage';
import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

/**
 * `drms-registration-scan` (nightly): finds devices newly connected to CSRC — DRMS status
 * Discovered, as last seen by `drms-pull` — and checks them against the registration rules,
 * including a live read-only Vantage lookup by serial. Eligible devices go to **Awaiting
 * approval**; devices that fail a Vantage rule go to **Waiting** with the reason. It never calls
 * DRMS and never registers anything: a person approves, and `drms-registration-submit` sends.
 *
 * One live row per device, upserted each run. Devices already approved, registered, failed or
 * rejected are left alone (a failed one comes back only through *Retry*, a rejected one only
 * through *Un-reject*). Queue rows for devices that are no longer candidates are removed.
 */
export interface RegistrationScanDeps {
  db: Db;
  vantage: Pick<VantageClient, 'findEquipmentBySerial'>;
  /** `AUTO_REGISTER_EXCLUDE`, case-insensitive, tested against the device and customer name. */
  excludeRegex: RegExp;
  now?: () => Date;
}

const LIVE_QUEUE = ['awaiting_approval', 'waiting'] as const;

const skipStat = (code: DrmsSkipCode) => `skipped${code.charAt(0).toUpperCase()}${code.slice(1)}`;

export async function runRegistrationScan(deps: RegistrationScanDeps): Promise<JobResult> {
  const { db, vantage, excludeRegex } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const r = drmsRegistrations;

  const devices = await db
    .select({ drmsId: drmsEquipment.drmsId, raw: drmsEquipment.raw })
    .from(drmsEquipment)
    .where(and(eq(drmsEquipment.status, 'Discovered'), isNull(drmsEquipment.missingSince)))
    .orderBy(drmsEquipment.drmsId);

  // The newest row per device decides what the scan may do with it.
  const latest = new Map(
    (
      await db
        .selectDistinctOn([r.drmsEquipmentId], { id: r.id, drmsId: r.drmsEquipmentId, status: r.status })
        .from(r)
        .orderBy(r.drmsEquipmentId, desc(r.id))
    ).map((row) => [row.drmsId, row]),
  );

  const stats: Record<string, number> = { discovered: devices.length, candidates: 0, awaitingApproval: 0, waiting: 0, alreadyHandled: 0 };
  const errors = new ErrorCollector();
  let lookupErrors = 0;
  // Devices whose live queue row stays; every other awaiting/waiting row is removed at the end.
  const keep = new Set<string>();

  for (const device of devices) {
    const record = { ...(device.raw as Record<string, unknown>), Id: device.drmsId } as DrmsRegistrationRecord;
    const skip = drmsCandidateCheck(record, excludeRegex);
    if (skip) {
      stats[skipStat(skip.code)] = (stats[skipStat(skip.code)] ?? 0) + 1;
      continue;
    }
    stats.candidates!++;

    const last = latest.get(device.drmsId);
    const live = last && (LIVE_QUEUE as readonly string[]).includes(last.status) ? last : null;
    if (last && !live) {
      stats.alreadyHandled!++;
      keep.add(device.drmsId);
      continue;
    }

    let matches: unknown[];
    try {
      matches = await vantage.findEquipmentBySerial(record.SerialNumber ?? '');
    } catch (err) {
      // Vantage refusing us (auth) or throttling us (429, which its GET throws as a plain
      // HttpError rather than RateLimitError) is not a per-device problem: stop rather than keep
      // calling.
      if (err instanceof AuthError || err instanceof RateLimitError || (err instanceof HttpError && err.status === 429)) throw err;
      lookupErrors++;
      errors.add(`${record.SerialNumber}`, err);
      keep.add(device.drmsId);
      continue;
    }

    const verdict = autoRegisterEligibility(record, matches, excludeRegex);
    if (!verdict.ok && verdict.stage === 'drms') continue; // already ruled out above; unreachable
    const vantageInfo = verdict.vantage;
    const values = {
      serial: record.SerialNumber ?? null,
      deviceName: record.Name ?? null,
      drmsCustomerName: record.CustomerName ?? null,
      vantageEquipmentId: vantageInfo?.equipmentId ?? null,
      vantageCustomerId: vantageInfo?.customerId ?? null,
      vantageCustomerName: vantageInfo?.customerName ?? null,
      status: verdict.ok ? ('awaiting_approval' as const) : ('waiting' as const),
      reason: verdict.ok ? null : verdict.reason,
      customerMatch: verdict.ok ? verdict.customerMatch : null,
      request: verdict.ok ? verdict.payload : null,
      checkedAt: now,
    };
    if (verdict.ok) stats.awaitingApproval!++;
    else stats.waiting!++;
    keep.add(device.drmsId);

    if (live) {
      // Guarded: a person may have approved or rejected the row since we read it.
      await db
        .update(r)
        .set(values)
        .where(and(eq(r.id, live.id), inArray(r.status, [...LIVE_QUEUE])));
    } else {
      await db.insert(r).values({ drmsEquipmentId: device.drmsId, createdAt: now, ...values });
    }
  }

  const removed = await db
    .delete(r)
    .where(
      keep.size > 0
        ? and(inArray(r.status, [...LIVE_QUEUE]), notInArray(r.drmsEquipmentId, [...keep]))
        : inArray(r.status, [...LIVE_QUEUE]),
    )
    .returning({ id: r.id });

  return {
    status: lookupErrors > 0 ? 'partial' : 'success',
    stats: { ...stats, lookupErrors, removed: removed.length },
    errorSample: errors.sample,
  };
}
