import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, linkIssues } from '../schema';

/**
 * Write actions behind the link-issues queue. They live here rather than in the web app so they
 * can be tested against a real Postgres (PGlite) without React, and so the worker could reuse them.
 *
 * Every one of these takes `userId` from the caller; the web layer must read it from the session,
 * never from the request body.
 */

/**
 * Issue types a manual link genuinely fixes: they all say "this device/record has no correct link".
 * `link_broken` and `customer_mismatch` are deliberately absent — a broken link is about DRMS state
 * or a deleted Vantage row, and a customer mismatch survives relinking, so neither is answered by
 * pointing the device at a Vantage record.
 */
const RESOLVED_BY_LINKING = [
  'no_match_drms',
  'no_match_vantage',
  'serial_ambiguous',
  'duplicate_target',
  'erp_serial_disagree',
] as const;

/** Reason stamped on links closed to make room for a manual one. */
const RELINK_REASON = 'manual_relink';
/** Reason stamped by `unlinkDevice` when the caller doesn't give one. */
const UNLINK_REASON = 'manual_unlink';

export interface ManualLinkArgs {
  drmsId: string;
  vantageId: number;
  /** The signed-in operator, from the session. Recorded as `linked_by`. */
  userId: number;
  now?: Date;
}

/**
 * Points a DRMS device at a Vantage equipment record by hand.
 *
 * `device_links` carries two partial unique indexes — one active link per DRMS device and one per
 * Vantage record — so both sides have to be closed inside the same transaction before the new row
 * goes in. Taking over a Vantage record another device holds is a normal operator move (that is
 * exactly what a `duplicate_target` issue looks like), so it closes that link too rather than
 * failing.
 *
 * The link is written with `method: 'manual'`, which `computeLinks` preserves, so a later
 * `link-run` will not undo it.
 */
export async function manualLink(db: Db, args: ManualLinkArgs): Promise<void> {
  const { drmsId, vantageId, userId } = args;
  const now = args.now ?? new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(deviceLinks)
      .set({ unlinkedAt: now, unlinkedReason: RELINK_REASON })
      .where(
        and(
          isNull(deviceLinks.unlinkedAt),
          or(eq(deviceLinks.drmsEquipmentId, drmsId), eq(deviceLinks.vantageEquipmentId, vantageId)),
        ),
      );

    await tx.insert(deviceLinks).values({
      drmsEquipmentId: drmsId,
      vantageEquipmentId: vantageId,
      method: 'manual',
      linkedBy: userId,
      linkedAt: now,
    });

    // Close the queue entries this link answers, on either side of it. Only `open` issues are
    // touched: an operator who chose to ignore one keeps that decision.
    await tx
      .update(linkIssues)
      .set({ status: 'resolved', resolvedBy: userId, resolvedAt: now })
      .where(
        and(
          eq(linkIssues.status, 'open'),
          inArray(linkIssues.type, [...RESOLVED_BY_LINKING]),
          or(eq(linkIssues.drmsEquipmentId, drmsId), eq(linkIssues.vantageEquipmentId, vantageId)),
        ),
      );
  });
}

export interface UnlinkDeviceArgs {
  drmsId: string;
  /** The signed-in operator. Recorded as `unlinked_by`. */
  userId: number;
  /** Stored in `unlinked_reason`; defaults to `manual_unlink`. */
  reason?: string;
  now?: Date;
}

/**
 * Closes a device's active link. Issues are left exactly as they are — unlinking is how an
 * operator says "this link is wrong", which is a reason to keep the queue entry, not to clear it.
 * The next `link-run` decides whether the device links again or raises a fresh issue.
 *
 * `unlinked_by` records who did it. The linker's own automatic closes (a missing device, a deleted
 * Vantage record, a relink) go straight through `deviceLinks` rather than this function, so they
 * leave it null — there is no operator to name.
 */
export async function unlinkDevice(db: Db, args: UnlinkDeviceArgs): Promise<void> {
  const now = args.now ?? new Date();
  await db
    .update(deviceLinks)
    .set({ unlinkedAt: now, unlinkedReason: args.reason ?? UNLINK_REASON, unlinkedBy: args.userId })
    .where(and(eq(deviceLinks.drmsEquipmentId, args.drmsId), isNull(deviceLinks.unlinkedAt)));
}

export interface SetIssueStatusArgs {
  issueId: number;
  status: 'open' | 'ignored' | 'resolved';
  /** The signed-in operator, from the session. Recorded as `resolved_by` when resolving. */
  userId: number;
  now?: Date;
}

/**
 * Sets one issue's status. `resolved_by` / `resolved_at` are stamped when resolving and cleared
 * otherwise, so an ignored or reopened issue never carries a stale resolver — the same thing
 * `link-run` does when it reopens an issue it sees again.
 */
export async function setIssueStatus(db: Db, args: SetIssueStatusArgs): Promise<void> {
  const resolving = args.status === 'resolved';
  const now = args.now ?? new Date();
  await db
    .update(linkIssues)
    .set({
      status: args.status,
      resolvedBy: resolving ? args.userId : null,
      resolvedAt: resolving ? now : null,
    })
    .where(eq(linkIssues.id, args.issueId));
}
