/**
 * One-off clean-up for the Toner Delivery change (docs/superpowers/plans/2026-11-27-toner-delivery.md).
 * A Toner Delivery alarm means a cartridge was fitted, so it no longer raises a proposal. Proposals it
 * raised before that change are still pending in the Review queue; this rejects them.
 *
 * Matches `pending` proposals with trigger `alarm` whose `alarm_description` is a Toner Delivery(X) or
 * Waste Toner Bottle Delivery alarm (`deliveryColour`, @mps/core). Rejects them the way the Reject action
 * does (`rejectProposals`, @mps/db `queries/replenishment-actions.ts`): status `rejected`, `decided_at`,
 * the reason in `note`, and one `proposal.reject` audit_log row (no user). Approved/ordered proposals,
 * site-stock top-ups and other triggers are never touched. Idempotent: rejected rows drop out of scope.
 *
 * Usage (repo root):
 *   npx tsx --env-file=.env apps/worker/scripts/reject-delivery-proposals.ts            # dry run (default)
 *   npx tsx --env-file=.env apps/worker/scripts/reject-delivery-proposals.ts --apply    # writes
 */
import { deliveryColour } from '@mps/core';
import { auditLog, createDb, replenishmentProposals, type Db } from '@mps/db';
import { and, eq, ilike, inArray } from 'drizzle-orm';

export const REJECT_REASON = 'raised by Toner Delivery alarm (cartridge already fitted)';

export interface RejectDeliveryResult {
  /** Pending alarm proposals raised by a Delivery alarm. */
  matched: number;
  /** Rows actually rejected (0 on a dry run). */
  rejected: number;
  byColour: Map<string, number>;
}

export async function rejectDeliveryProposals(db: Db, opts: { apply: boolean; now?: Date }): Promise<RejectDeliveryResult> {
  const p = replenishmentProposals;
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: p.id, colour: p.colour, description: p.alarmDescription })
      .from(p)
      .where(and(eq(p.status, 'pending'), eq(p.trigger, 'alarm'), ilike(p.alarmDescription, '%delivery%')))
      .orderBy(p.id);
    const hits = rows.filter((r) => deliveryColour(r.description) !== null);
    const byColour = new Map<string, number>();
    for (const r of hits) byColour.set(r.colour, (byColour.get(r.colour) ?? 0) + 1);

    let rejected = 0;
    if (opts.apply && hits.length > 0) {
      const ids = hits.map((r) => r.id);
      // Same fields as the app's Reject, guarded on `pending` in case a person decided one meanwhile.
      const done = await tx
        .update(p)
        .set({ status: 'rejected', decidedBy: null, decidedAt: now, note: REJECT_REASON })
        .where(and(inArray(p.id, ids), eq(p.status, 'pending')))
        .returning({ id: p.id });
      rejected = done.length;
      if (done.length > 0) {
        await tx.insert(auditLog).values({
          at: now,
          userId: null,
          action: 'proposal.reject',
          entity: 'proposal',
          entityIds: done.map((d) => d.id).sort((a, b) => a - b),
          details: { note: REJECT_REASON },
        });
      }
    }
    return { matched: hits.length, rejected, byColour };
  });
}

/** The CLI's first output line. */
export function summaryLine(r: RejectDeliveryResult, apply: boolean): string {
  return apply
    ? `matched ${r.matched} pending Delivery proposal(s), ${r.rejected} rejected`
    : `matched ${r.matched} pending Delivery proposal(s), ${r.matched} would be rejected (dry run - pass --apply to write)`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const result = await rejectDeliveryProposals(db, { apply });
    console.log(summaryLine(result, apply));
    for (const [colour, count] of result.byColour) console.log(`  ${colour}: ${count}`);
  } finally {
    await pool.end();
  }
}

// Only run as a CLI, not when imported by the test.
if (process.argv[1]?.endsWith('reject-delivery-proposals.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
