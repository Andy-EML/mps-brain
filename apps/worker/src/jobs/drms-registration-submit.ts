import { AuthError, ErrorCollector, HttpError, RateLimitError, UncertainWriteError, errorMessage, normaliseSerial } from '@mps/core';
import { drmsRegistrations, type Db } from '@mps/db';
import type { DrmsClient, DrmsEquipment, DrmsEquipmentRequest } from '@mps/drms';
import { and, asc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

/**
 * `drms-registration-submit`: registers **approved** devices in DRMS — the one DRMS write this
 * project makes (`EquipmentRequest/Register`, then polling `EquipmentRequest/{id}`). Queued by the
 * web app when someone approves, and swept every 10 minutes.
 *
 * Safety, learnt registering ~550 devices by hand on 2026-09-21:
 * - strictly one at a time: each device is pre-checked, sent, polled to a final answer and
 *   re-read before the next one is touched;
 * - a pause between registrations (`AUTO_REGISTER_PAUSE_SECONDS`, default 90 — the DRMS backbone
 *   deadlocks under a steady stream), measured from the last send in any run;
 * - at most `AUTO_REGISTER_MAX_PER_RUN` sends per run;
 * - a row with a request id is only ever polled, never sent again, and a send whose outcome is
 *   unknown (5xx, timeout, the worker dying mid-POST) is recorded as failed for a person to check;
 * - a 429 or an auth error stops the run; a pre-check read that fails skips the device unsent.
 */
export interface RegistrationSubmitDeps {
  db: Db;
  drms: Pick<DrmsClient, 'getEquipment' | 'registerEquipment' | 'getEquipmentRequest'>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** `AUTO_REGISTER_PAUSE_SECONDS`. */
  pauseSeconds?: number;
  /** `AUTO_REGISTER_MAX_PER_RUN`. */
  maxPerRun?: number;
  /** 30 s between polls, up to 40 polls: about 20 minutes per request. */
  pollIntervalMs?: number;
  maxPolls?: number;
}

export const DEFAULT_PAUSE_SECONDS = 90;
export const DEFAULT_MAX_PER_RUN = 40;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_POLLS = 40;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A 429 or an auth failure: continuing would extend the block or fail every call. */
const isStop = (err: unknown) => err instanceof RateLimitError || err instanceof AuthError;

type Row = typeof drmsRegistrations.$inferSelect;

const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '');

/**
 * What differs between the live DRMS record and the approved payload, so a device that someone
 * changed in DRMS after approval is never registered on stale data. ErpId must still be empty or
 * a copy of the serial — or, for a retry, the Vantage id our own failed attempt may have left.
 */
export function changedSinceApproval(live: DrmsEquipment, payload: Record<string, unknown>, isRetry: boolean): string[] {
  const out: string[] = [];
  const erpId = live.ErpId ?? '';
  if (erpId.trim() !== '' && normaliseSerial(erpId) !== normaliseSerial(live.SerialNumber) && !(isRetry && erpId === payload.EquipmentErpId)) {
    out.push('ErpId');
  }
  if (!same(live.CsrcId, payload.EquipmentCsrcId)) out.push('CsrcId');
  if (!same(live.SerialNumber, payload.EquipmentSerialNumber)) out.push('SerialNumber');
  if (!same(live.CustomerErpId, payload.CustomerErpId)) out.push('CustomerErpId');
  return out;
}

export async function runRegistrationSubmit(deps: RegistrationSubmitDeps): Promise<JobResult> {
  const { db, drms } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? realSleep;
  const pauseMs = (deps.pauseSeconds ?? DEFAULT_PAUSE_SECONDS) * 1000;
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  const r = drmsRegistrations;

  const stats = { resumed: 0, sent: 0, registered: 0, failed: 0, precheckFailed: 0, stillProcessing: 0, uncertain: 0 };
  const errors = new ErrorCollector();

  const finish = (id: number, values: Partial<typeof r.$inferInsert>) =>
    db.update(r).set({ finishedAt: now(), ...values }).where(eq(r.id, id));

  /** Status after, as register.mjs recorded it: `PreRegistered (ErpId 4321)`. */
  async function statusAfter(drmsId: string): Promise<string> {
    try {
      const e = await drms.getEquipment(drmsId);
      return `${e.Status ?? 'unknown'} (ErpId ${e.ErpId ?? ''})`;
    } catch (err) {
      if (isStop(err)) throw err;
      return err instanceof HttpError ? `HTTP ${err.status}` : errorMessage(err);
    }
  }

  /**
   * Polls one request until DRMS gives a final answer, then records it. `resume` = the request was
   * sent in an earlier run, so the first poll goes straight away.
   */
  async function pollAndRecord(row: Row, requestId: string, resume: boolean): Promise<void> {
    let last: DrmsEquipmentRequest | null = null;
    let final = false;
    for (let i = 0; i < maxPolls && !final; i++) {
      if (i > 0 || !resume) await sleep(pollIntervalMs);
      try {
        last = await drms.getEquipmentRequest(requestId);
      } catch (err) {
        if (isStop(err)) throw err;
        errors.add(`poll ${requestId}`, err); // a GET: safe to keep polling
        continue;
      }
      final = last.Status === 'ProcessedSuccessful' || !!last.ErrorMessage || /fail|error|reject/i.test(last.Status ?? '');
    }

    if (!final) {
      stats.stillProcessing++;
      await db
        .update(r)
        .set({
          response: last,
          error: `DRMS was still processing after ${maxPolls} polls; it is polled again on the next run.`,
        })
        .where(eq(r.id, row.id));
      return;
    }

    const ok = last!.Status === 'ProcessedSuccessful' && !last!.ErrorMessage;
    // Record the outcome before the status-after read, so a 429 there cannot lose it.
    await finish(row.id, {
      status: ok ? 'registered' : 'failed',
      response: last,
      error: ok ? null : [last!.Status, last!.ErrorMessage].filter(Boolean).join(': ') || 'DRMS reported a failure',
    });
    if (ok) stats.registered++;
    else stats.failed++;
    await db.update(r).set({ drmsStatusAfter: await statusAfter(row.drmsEquipmentId) }).where(eq(r.id, row.id));
  }

  let stopped: unknown = null;
  try {
    // 1. A send that started but never saved its request id: the worker died mid-POST. DRMS may
    //    have the request, so it is never sent again automatically.
    const interrupted = await db
      .update(r)
      .set({
        status: 'failed',
        finishedAt: now(),
        error:
          'The worker stopped while sending this registration, so DRMS may or may not have it. Check the device in DRMS before retrying.',
      })
      .where(and(eq(r.status, 'approved'), isNull(r.requestId), isNotNull(r.submittedAt)))
      .returning({ id: r.id });
    stats.uncertain += interrupted.length;

    // 2. Requests sent in an earlier run and not yet final: poll only.
    const resumable = await db
      .select()
      .from(r)
      .where(and(eq(r.status, 'approved'), isNotNull(r.requestId)))
      .orderBy(asc(r.id));
    for (const row of resumable) {
      stats.resumed++;
      await pollAndRecord(row, row.requestId!, true);
    }

    // 3. New sends, oldest decision first.
    const queue = await db
      .select()
      .from(r)
      .where(and(eq(r.status, 'approved'), isNull(r.requestId), isNull(r.submittedAt)))
      .orderBy(sql`coalesce(${r.retryRequestedAt}, ${r.decidedAt}, ${r.createdAt})`, asc(r.id));
    const [{ lastSent } = { lastSent: null }] = await db.select({ lastSent: max(r.submittedAt) }).from(r);
    let lastSentAt: Date | null = lastSent ? new Date(lastSent) : null;

    for (const row of queue) {
      if (stats.sent >= maxPerRun) break;

      // The pause comes first, so the live pre-check below is the last thing before the POST.
      if (lastSentAt) {
        const wait = lastSentAt.getTime() + pauseMs - now().getTime();
        if (wait > 0) await sleep(wait);
      }

      // Pre-check: the device must still be Discovered (or Deleted, for a retry of a registration
      // DRMS rolled back) and still be the device that was approved. A failed read skips the
      // device without sending anything.
      let live: DrmsEquipment;
      try {
        live = await drms.getEquipment(row.drmsEquipmentId);
      } catch (err) {
        if (isStop(err)) throw err;
        stats.precheckFailed++;
        errors.add(`pre-check ${row.serial ?? row.drmsEquipmentId}`, err);
        continue;
      }
      const drmsStatus = live.Status ?? null;
      const allowed = row.retryRequestedAt ? ['Discovered', 'Deleted'] : ['Discovered'];
      if (!allowed.includes(drmsStatus ?? '')) {
        stats.failed++;
        await finish(row.id, {
          status: 'failed',
          drmsStatusAfter: drmsStatus,
          error: `DRMS shows the device as ${drmsStatus ?? 'unknown'}, not ${allowed.join(' or ')}, so it was not sent.`,
        });
        continue;
      }
      const changed = changedSinceApproval(live, (row.request ?? {}) as Record<string, unknown>, row.retryRequestedAt !== null);
      if (changed.length > 0) {
        stats.failed++;
        await finish(row.id, {
          status: 'failed',
          drmsStatusAfter: drmsStatus,
          error: `Changed in DRMS since approval (${changed.join(', ')}) — not sent; rescan.`,
        });
        continue;
      }

      // Mark the send before it happens (guarded), so a crash mid-POST is never re-sent.
      const sendAt = now();
      const claimed = await db
        .update(r)
        .set({ submittedAt: sendAt })
        .where(and(eq(r.id, row.id), eq(r.status, 'approved'), isNull(r.requestId), isNull(r.submittedAt)))
        .returning({ id: r.id });
      if (claimed.length === 0) continue;
      lastSentAt = sendAt;
      stats.sent++;

      let requestId: string;
      try {
        requestId = await drms.registerEquipment(row.request as Record<string, unknown>);
      } catch (err) {
        if (isStop(err)) {
          // Refused before DRMS accepted anything: the row simply goes back to unsent.
          await db.update(r).set({ submittedAt: null }).where(eq(r.id, row.id));
          stats.sent--;
          throw err;
        }
        stats.failed++;
        if (err instanceof HttpError) {
          await finish(row.id, {
            status: 'failed',
            response: { status: err.status, body: err.body ?? null },
            error: `DRMS rejected the registration (HTTP ${err.status}): ${err.body ?? err.message}`,
          });
        } else {
          if (err instanceof UncertainWriteError) stats.uncertain++;
          await finish(row.id, {
            status: 'failed',
            response: err instanceof UncertainWriteError ? { status: err.status, body: err.body ?? null } : null,
            error: `No clear answer from DRMS (${errorMessage(err)}): it may or may not have accepted the registration. Check DRMS before retrying.`,
          });
        }
        continue;
      }

      await db.update(r).set({ requestId, response: { requestId } }).where(eq(r.id, row.id));
      await pollAndRecord(row, requestId, false);
    }
  } catch (err) {
    if (!isStop(err)) throw err;
    stopped = err;
  }

  if (stopped) {
    return {
      status: 'failed',
      stats: { ...stats, stopped: true },
      errorSample: `Stopped: ${errorMessage(stopped)}${errors.sample ? `\n${errors.sample}` : ''}`,
    };
  }
  return {
    status: stats.precheckFailed > 0 ? 'partial' : 'success',
    stats,
    errorSample: errors.sample,
  };
}
