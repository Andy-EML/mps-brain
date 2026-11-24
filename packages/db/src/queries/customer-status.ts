import { and, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, replenishmentProposals, vantageCustomers, vantageEquipment } from '../schema';
import { headOfficeIdSql } from './customer-flags';
import { listCustomerDevices, loadCustomerRows, type CustomerRow } from './customers';
import type { DeviceRow } from './devices';
import type { PmStatus } from './pm-due';
import { listPmForEquipment, type PmRow, type PmView } from './pm-queries';
import { notHiddenDevice } from './shared';

/** A machine with no meter reading for this many days (or never) is flagged. */
export const NO_READING_DAYS = 7;

/** Machine counts per warning; `pending` counts proposals (the customer list's Pending figure). */
export interface CustomerWarnings {
  noReading: number;
  pmOverdue: number;
  pending: number;
}

export function hasWarning(w: CustomerWarnings): boolean {
  return w.noReading > 0 || w.pmOverdue > 0 || w.pending > 0;
}

const NO_READING_MS = NO_READING_DAYS * 24 * 60 * 60 * 1000;

function isNoReading(lastCounterAt: Date | null, now: Date): boolean {
  return lastCounterAt === null || now.getTime() - lastCounterAt.getTime() >= NO_READING_MS;
}

/**
 * Overdue on the PM page's Due view: overdue status, or a booking that passed unseen; dismissed or
 * booked rows do not warn. Nor does a machine at an other-dealer site — they service it, so it is
 * not on our PM due list (other dealer is PM only: its toner / no-reading / pending warnings stay).
 */
function isPmOverdue(pm: PmRow | undefined): boolean {
  return (
    pm !== undefined &&
    pm.otherDealer.dealer === null &&
    pm.view === 'due' &&
    (pm.result.status === 'overdue' || pm.bookedOverdue)
  );
}

/**
 * Warnings per customer in `customerIds` (one entry each; a head office's counts include its
 * sites'). Same machine set as the list's Machines count: active-linked, not hidden devices.
 * Set-wise — a fixed number of queries however many customers are passed.
 */
export async function listCustomerWarnings(db: Db, customerIds: number[], now: Date = new Date()): Promise<Map<number, CustomerWarnings>> {
  const out = new Map<number, CustomerWarnings>();
  if (customerIds.length === 0) return out;

  const headOffice = headOfficeIdSql();
  const siteLinks = await db
    .select({ id: vantageCustomers.vantageId, headOfficeId: headOffice })
    .from(vantageCustomers)
    .where(and(isNull(vantageCustomers.deletedDate), isNotNull(headOffice), inArray(headOffice, customerIds)));
  const scopeOf = new Map<number, number[]>(customerIds.map((id) => [id, [id]]));
  for (const l of siteLinks) scopeOf.get(l.headOfficeId!)?.push(l.id);
  const memberIds = [...new Set([...scopeOf.values()].flat())];

  const activeLink = and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt));
  const [machineRows, pendingRows] = await Promise.all([
    db
      .select({
        drmsId: drmsEquipment.drmsId,
        vantageEquipmentId: vantageEquipment.vantageId,
        customerId: vantageEquipment.vantageCustomerId,
        lastCounterAt: drmsEquipment.lastCounterReceivedTime,
      })
      .from(drmsEquipment)
      .innerJoin(deviceLinks, activeLink)
      .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
      .where(and(inArray(vantageEquipment.vantageCustomerId, memberIds), notHiddenDevice(drmsEquipment.drmsId))),
    db
      .select({ customerId: vantageEquipment.vantageCustomerId, n: count() })
      .from(replenishmentProposals)
      .innerJoin(
        deviceLinks,
        and(eq(deviceLinks.drmsEquipmentId, replenishmentProposals.drmsEquipmentId), isNull(deviceLinks.unlinkedAt)),
      )
      .innerJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
      .where(
        and(
          inArray(vantageEquipment.vantageCustomerId, memberIds),
          eq(replenishmentProposals.status, 'pending'),
          notHiddenDevice(replenishmentProposals.drmsEquipmentId),
        ),
      )
      .groupBy(vantageEquipment.vantageCustomerId),
  ]);

  // A device is one machine however many rows its joins produced.
  const machines = [...new Map(machineRows.map((m) => [m.drmsId, m])).values()];
  const pm = await listPmForEquipment(db, [...new Set(machines.map((m) => m.vantageEquipmentId))], now);
  const pendingBy = new Map(pendingRows.map((r) => [r.customerId as number, Number(r.n)]));

  for (const [id, scope] of scopeOf) {
    const inScope = new Set(scope);
    const own = machines.filter((m) => inScope.has(m.customerId as number));
    out.set(id, {
      noReading: own.filter((m) => isNoReading(m.lastCounterAt, now)).length,
      pmOverdue: own.filter((m) => isPmOverdue(pm.get(m.vantageEquipmentId))).length,
      pending: scope.reduce((a, c) => a + (pendingBy.get(c) ?? 0), 0),
    });
  }
  return out;
}

export interface MachineStatusRow {
  /** Feeds the toner bars and names. */
  device: DeviceRow;
  /** `vantage_equipment.location`. */
  location: string | null;
  /**
   * Null when the machine has no PM row (no active contract). `otherDealer` names the dealer that
   * services the site (null = us); such a machine never raises a PM warning here.
   */
  pm: { status: PmStatus; overdueReason: string | null; bookedOverdue: boolean; view: PmView; otherDealer: string | null } | null;
  /** Pending proposals on this device. */
  pending: number;
  /** = `device.lastCounterAt`. */
  lastReadingAt: Date | null;
  warnings: { noReading: boolean; pmOverdue: boolean; pending: boolean };
}

/** One row per machine in the customer's Machines count (own devices only, not its sites'), in the device-list order. */
export async function listCustomerMachineStatus(db: Db, customerId: number, now: Date = new Date()): Promise<MachineStatusRow[]> {
  const { visible } = await listCustomerDevices(db, [customerId]);
  if (visible.length === 0) return [];
  const equipmentIds = visible.map((d) => d.vantageEquipmentId).filter((x): x is number => x !== null);
  const drmsIds = visible.map((d) => d.drmsId);
  const [pm, locations, pendingRows] = await Promise.all([
    listPmForEquipment(db, equipmentIds, now),
    equipmentIds.length
      ? db
          .select({ id: vantageEquipment.vantageId, location: vantageEquipment.location })
          .from(vantageEquipment)
          .where(inArray(vantageEquipment.vantageId, equipmentIds))
      : Promise.resolve([]),
    db
      .select({ drmsId: replenishmentProposals.drmsEquipmentId, n: count() })
      .from(replenishmentProposals)
      .where(and(eq(replenishmentProposals.status, 'pending'), inArray(replenishmentProposals.drmsEquipmentId, drmsIds)))
      .groupBy(replenishmentProposals.drmsEquipmentId),
  ]);
  const locationOf = new Map(locations.map((l) => [l.id, l.location]));
  const pendingOf = new Map(pendingRows.map((r) => [r.drmsId, Number(r.n)]));
  return visible.map((device) => {
    const row = device.vantageEquipmentId === null ? undefined : pm.get(device.vantageEquipmentId);
    const pending = pendingOf.get(device.drmsId) ?? 0;
    return {
      device,
      location: device.vantageEquipmentId === null ? null : (locationOf.get(device.vantageEquipmentId) ?? null),
      pm: row
        ? {
            status: row.result.status,
            overdueReason: row.result.reason,
            bookedOverdue: row.bookedOverdue,
            view: row.view,
            otherDealer: row.otherDealer.dealer,
          }
        : null,
      pending,
      lastReadingAt: device.lastCounterAt,
      warnings: { noReading: isNoReading(device.lastCounterAt, now), pmOverdue: isPmOverdue(row), pending: pending > 0 },
    };
  });
}

export interface SiteStatusRow {
  customer: CustomerRow;
  warnings: CustomerWarnings;
}

/** A head office's sites (name A-Z), each with its own figures and warnings. */
export async function listCustomerSiteStatus(db: Db, headOfficeId: number, now: Date = new Date()): Promise<SiteStatusRow[]> {
  const sites = await loadCustomerRows(db, { headOfficeId });
  const warnings = await listCustomerWarnings(db, sites.map((s) => s.vantageId), now);
  return sites.map((customer) => ({ customer, warnings: warnings.get(customer.vantageId)! }));
}
