import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLog, drmsRegistrations } from '../schema';

/**
 * The DRMS registration queue's decisions: approve, reject, un-reject, retry. Each is one
 * transaction with one `audit_log` row, and every state change is a guarded update
 * (`where status = <expected>`) so two people on stale pages cannot both act on a row — the loser
 * gets a `RegistrationError` and nothing is written.
 *
 * None of these call DRMS. Approval only marks rows `approved`; the `drms-registration-submit`
 * job sends them. `userId` always comes from the session, never from the form.
 */

export type RegistrationErrorCode = 'empty' | 'stale' | 'not_found' | 'bad_state';

/** Anything a person can run into from the UI; always safe to show them. */
export class RegistrationError extends Error {
  constructor(
    message: string,
    readonly code: RegistrationErrorCode,
  ) {
    super(message);
    this.name = 'RegistrationError';
  }
}

const STALE = 'Some of these have changed since the page loaded — refresh and try again.';
const r = drmsRegistrations;

function uniqueIds(ids: number[], what: string): number[] {
  const out = [...new Set(ids)];
  if (out.length === 0) throw new RegistrationError(`Select at least one machine to ${what}.`, 'empty');
  return out;
}

/** Approves rows awaiting approval, all or nothing. The submit job registers them. */
export async function approveRegistrations(
  db: Db,
  args: { ids: number[]; userId: number; now?: Date },
): Promise<{ approved: number }> {
  const now = args.now ?? new Date();
  const ids = uniqueIds(args.ids, 'approve');
  return db.transaction(async (tx) => {
    const done = await tx
      .update(r)
      .set({ status: 'approved', decidedBy: args.userId, decidedAt: now, note: null })
      .where(and(inArray(r.id, ids), eq(r.status, 'awaiting_approval')))
      .returning({ id: r.id });
    if (done.length !== ids.length) throw new RegistrationError(STALE, 'stale');
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'registration.approve',
      entity: 'registration',
      entityIds: ids,
      details: {},
    });
    return { approved: done.length };
  });
}

/** Says no to rows awaiting approval, all or nothing. The scan does not propose them again. */
export async function rejectRegistrations(
  db: Db,
  args: { ids: number[]; userId: number; note?: string; now?: Date },
): Promise<{ rejected: number }> {
  const now = args.now ?? new Date();
  const ids = uniqueIds(args.ids, 'reject');
  const note = args.note?.trim() || null;
  return db.transaction(async (tx) => {
    const done = await tx
      .update(r)
      .set({ status: 'rejected', decidedBy: args.userId, decidedAt: now, note })
      .where(and(inArray(r.id, ids), eq(r.status, 'awaiting_approval')))
      .returning({ id: r.id });
    if (done.length !== ids.length) throw new RegistrationError(STALE, 'stale');
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'registration.reject',
      entity: 'registration',
      entityIds: ids,
      details: { note },
    });
    return { rejected: done.length };
  });
}

async function loadRow(tx: Pick<Db, 'select'>, id: number) {
  const [row] = await tx.select().from(r).where(eq(r.id, id));
  if (!row) throw new RegistrationError('That registration no longer exists — refresh the page.', 'not_found');
  const [later] = await tx
    .select({ id: r.id })
    .from(r)
    .where(and(eq(r.drmsEquipmentId, row.drmsEquipmentId), gt(r.id, id)))
    .orderBy(desc(r.id))
    .limit(1);
  return { row, superseded: later !== undefined };
}

/**
 * Puts a rejected row back in *Awaiting approval*. The next scan re-checks it like any other
 * queue row (it may move to *Waiting* if a rule is no longer met).
 */
export async function unrejectRegistration(
  db: Db,
  args: { registrationId: number; userId: number; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  await db.transaction(async (tx) => {
    const { row, superseded } = await loadRow(tx, args.registrationId);
    if (row.status !== 'rejected' || superseded) {
      throw new RegistrationError('Only a rejected machine can be put back in the queue.', 'bad_state');
    }
    const done = await tx
      .update(r)
      .set({ status: 'awaiting_approval', decidedBy: null, decidedAt: null, note: null, checkedAt: now })
      .where(and(eq(r.id, row.id), eq(r.status, 'rejected')))
      .returning({ id: r.id });
    if (done.length === 0) throw new RegistrationError(STALE, 'stale');
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'registration.unreject',
      entity: 'registration',
      entityIds: [row.id],
      details: {},
    });
  });
}

/**
 * Retries a failed registration as a **new attempt**: a fresh `approved` row with the same
 * request and `retry_requested_*` set; the failed row stays as history. The submit job's
 * pre-check then also accepts a device DRMS set to Deleted (what a Backbone deadlock leaves).
 * Refused when the device already has a later attempt.
 */
export async function requestRetry(
  db: Db,
  args: { registrationId: number; userId: number; now?: Date },
): Promise<{ registrationId: number }> {
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const { row, superseded } = await loadRow(tx, args.registrationId);
    if (row.status !== 'failed' || superseded) {
      throw new RegistrationError('Only the latest failed registration of a machine can be retried.', 'bad_state');
    }
    if (row.request == null) throw new RegistrationError('This registration has no request to send again.', 'bad_state');
    const [fresh] = await tx
      .insert(r)
      .values({
        drmsEquipmentId: row.drmsEquipmentId,
        serial: row.serial,
        deviceName: row.deviceName,
        drmsCustomerName: row.drmsCustomerName,
        vantageEquipmentId: row.vantageEquipmentId,
        vantageCustomerId: row.vantageCustomerId,
        vantageCustomerName: row.vantageCustomerName,
        status: 'approved',
        customerMatch: row.customerMatch,
        request: row.request,
        createdAt: now,
        checkedAt: now,
        retryRequestedBy: args.userId,
        retryRequestedAt: now,
      })
      .returning({ id: r.id });
    await tx.insert(auditLog).values({
      at: now,
      userId: args.userId,
      action: 'registration.retry',
      entity: 'registration',
      entityIds: [row.id],
      details: { newRegistrationId: fresh!.id },
    });
    return { registrationId: fresh!.id };
  });
}
