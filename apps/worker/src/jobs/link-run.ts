import {
  chunk,
  computeLinks,
  deriveCustomerLinks,
  diffLinks,
  issueKey,
  reconcileIssues,
  type DrmsDeviceInput,
  type LinkConfig,
  type LinkMethod,
  type VantageDeviceInput,
} from '@mps/core';
import { customerLinks, deviceLinks, drmsEquipment, linkIssues, vantageEquipment, type Db } from '@mps/db';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { JobResult } from '../sync-runs';

const CHUNK = 500;

export interface LinkRunDeps {
  db: Db;
  config: LinkConfig;
  now?: () => Date;
}

export async function runLinkRun(deps: LinkRunDeps): Promise<JobResult> {
  const { db, config } = deps;
  const now = (deps.now ?? (() => new Date()))();

  return db.transaction(async (tx) => {
    const drmsRows = await tx
      .select({
        drmsId: drmsEquipment.drmsId,
        erpId: drmsEquipment.erpId,
        serialNorm: drmsEquipment.serialNorm,
        status: drmsEquipment.status,
        customerErpId: drmsEquipment.customerErpId,
        missingSince: drmsEquipment.missingSince,
      })
      .from(drmsEquipment);
    const drms: DrmsDeviceInput[] = drmsRows.map(({ missingSince, ...r }) => ({ ...r, missing: missingSince !== null }));

    const vantageRows = await tx
      .select({
        vantageId: vantageEquipment.vantageId,
        assetNumber: vantageEquipment.assetNumber,
        serialNorm: vantageEquipment.serialNorm,
        customerId: vantageEquipment.vantageCustomerId,
        customerReference: vantageEquipment.customerReference,
        deletedDate: vantageEquipment.deletedDate,
      })
      .from(vantageEquipment);
    const vantage: VantageDeviceInput[] = vantageRows.map(({ deletedDate, ...r }) => ({ ...r, deleted: deletedDate !== null }));

    const existing = (
      await tx
        .select({
          id: deviceLinks.id,
          drmsId: deviceLinks.drmsEquipmentId,
          vantageId: deviceLinks.vantageEquipmentId,
          method: deviceLinks.method,
        })
        .from(deviceLinks)
        .where(isNull(deviceLinks.unlinkedAt))
    ).map((l) => ({ ...l, method: l.method as LinkMethod }));

    const plan = computeLinks(drms, vantage, existing, config);
    const { toCreate, toClose } = diffLinks(existing, plan.links);

    // A close caused by a planned link_broken issue records its reason; any other close is a relink.
    const brokenReason = new Map<string, string>();
    for (const i of plan.issues) {
      if (i.type === 'link_broken' && i.drmsId !== null) brokenReason.set(i.drmsId, String(i.details.reason));
    }
    const closeIdsByReason = new Map<string, number[]>();
    for (const l of toClose) {
      const reason = brokenReason.get(l.drmsId) ?? 'relinked';
      const ids = closeIdsByReason.get(reason);
      if (ids) ids.push(l.id);
      else closeIdsByReason.set(reason, [l.id]);
    }
    for (const [reason, closeIds] of closeIdsByReason) {
      for (const ids of chunk(closeIds, CHUNK)) {
        await tx.update(deviceLinks).set({ unlinkedAt: now, unlinkedReason: reason }).where(inArray(deviceLinks.id, ids));
      }
    }
    for (const rows of chunk(toCreate, CHUNK)) {
      await tx.insert(deviceLinks).values(
        rows.map((l) => ({ drmsEquipmentId: l.drmsId, vantageEquipmentId: l.vantageId, method: l.method, linkedAt: now })),
      );
    }

    const derived = deriveCustomerLinks(plan.links, drms, vantage);
    for (const rows of chunk(derived, CHUNK)) {
      await tx
        .insert(customerLinks)
        .values(rows.map((c) => ({ ...c, method: 'derived' as const, updatedAt: now })))
        .onConflictDoUpdate({
          target: customerLinks.customerErpId,
          set: {
            vantageCustomerId: sql.raw('excluded."vantage_customer_id"'),
            deviceCount: sql.raw('excluded."device_count"'),
            updatedAt: now,
          },
          setWhere: eq(customerLinks.method, 'derived'),
        });
    }
    const derivedIds = derived.map((c) => c.customerErpId);
    await tx
      .delete(customerLinks)
      .where(
        derivedIds.length > 0
          ? and(eq(customerLinks.method, 'derived'), notInArray(customerLinks.customerErpId, derivedIds))
          : eq(customerLinks.method, 'derived'),
      );

    const stored = (
      await tx.select({ id: linkIssues.id, key: linkIssues.issueKey, status: linkIssues.status }).from(linkIssues)
    ).map((s) => ({ ...s, status: s.status as 'open' | 'resolved' | 'ignored' }));
    const changes = reconcileIssues(stored, plan.issues);

    for (const rows of chunk(changes.toInsert, CHUNK)) {
      await tx.insert(linkIssues).values(
        rows.map((i) => ({
          issueKey: issueKey(i),
          type: i.type,
          drmsEquipmentId: i.drmsId,
          vantageEquipmentId: i.vantageId,
          details: i.details,
          status: 'open' as const,
          firstSeen: now,
          lastSeen: now,
        })),
      );
    }
    for (const ids of chunk(changes.toTouch, CHUNK)) {
      await tx.update(linkIssues).set({ lastSeen: now }).where(inArray(linkIssues.id, ids));
    }
    for (const { id, issue } of changes.toReopen) {
      await tx
        .update(linkIssues)
        .set({ status: 'open', details: issue.details, lastSeen: now, resolvedAt: null, resolvedBy: null })
        .where(eq(linkIssues.id, id));
    }
    for (const ids of chunk(changes.toResolve, CHUNK)) {
      await tx.update(linkIssues).set({ status: 'resolved', resolvedAt: now }).where(inArray(linkIssues.id, ids));
    }

    return {
      status: 'success',
      stats: {
        linksCreated: toCreate.length,
        linksClosed: toClose.length,
        activeLinks: plan.links.length,
        issuesOpened: changes.toInsert.length + changes.toReopen.length,
        issuesResolved: changes.toResolve.length,
        customerLinks: derived.length,
      },
    } satisfies JobResult;
  });
}
