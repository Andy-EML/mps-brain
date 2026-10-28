import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, vantageEquipment } from '../schema';
import { deviceListConditions, deviceListOrder, joinDeviceList, type DeviceListFilters } from './devices';

/**
 * The devices list's bulk selection. "Select all N matching" is resolved here, on the server, from
 * the same search, tab and filters the list was drawn with — never from an id list the browser sends —
 * and `describeSelection` is what the confirmation step shows before anything is written.
 */

/** Longest name list the confirmation step shows; the count still covers every device. */
const NAME_LIMIT = 50;

export interface ResolvedSelection {
  /** In the list's own order (`deviceListOrder`), so it matches paging through `listDevices`. */
  drmsIds: string[];
  /** Distinct Vantage customers; every device without one counts together as one more. */
  customers: number;
  hasMono: boolean;
}

export interface SelectionDescription {
  /** Devices that exist; unknown ids and duplicates are not counted. */
  count: number;
  customers: number;
  hasMono: boolean;
  /** How many of them are mono, for "N mono devices will ignore the colour thresholds". */
  mono: number;
  /** `Customer · serial`, customer first, capped at 50. */
  names: string[];
}

function countCustomers(rows: { vantageCustomerId: number | null }[]): number {
  const ids = new Set(rows.map((r) => r.vantageCustomerId));
  return ids.size;
}

/** Every device the devices list shows for this search, tab and filters, across all its pages. */
export async function resolveDeviceSelection(db: Db, o: DeviceListFilters): Promise<ResolvedSelection> {
  const conds = deviceListConditions(db, o);
  const rows = await joinDeviceList(
    db
      .select({
        drmsId: drmsEquipment.drmsId,
        isColour: drmsEquipment.isColour,
        vantageCustomerId: vantageEquipment.vantageCustomerId,
      })
      .from(drmsEquipment)
      .$dynamic(),
    conds,
  )
    .where(conds.where)
    .orderBy(...deviceListOrder());

  return {
    drmsIds: rows.map((r) => r.drmsId),
    // `null` (unlinked, or Vantage equipment with no customer) lands in the Set once: one group.
    customers: countCustomers(rows),
    hasMono: rows.some((r) => !r.isColour),
  };
}

/** What the confirmation step says about a selection: how many, which customers, which are mono. */
export async function describeSelection(db: Db, drmsIds: string[]): Promise<SelectionDescription> {
  const ids = [...new Set(drmsIds)];
  if (ids.length === 0) return { count: 0, customers: 0, hasMono: false, mono: 0, names: [] };

  const customer = sql<string>`coalesce(${vantageEquipment.customerName}, ${drmsEquipment.customerName}, 'Unknown customer')`;
  const rows = await db
    .select({
      drmsId: drmsEquipment.drmsId,
      serial: drmsEquipment.serial,
      isColour: drmsEquipment.isColour,
      vantageCustomerId: vantageEquipment.vantageCustomerId,
      customer,
    })
    .from(drmsEquipment)
    .leftJoin(
      deviceLinks,
      and(eq(deviceLinks.drmsEquipmentId, drmsEquipment.drmsId), isNull(deviceLinks.unlinkedAt)),
    )
    .leftJoin(vantageEquipment, eq(vantageEquipment.vantageId, deviceLinks.vantageEquipmentId))
    .where(inArray(drmsEquipment.drmsId, ids))
    .orderBy(sql`lower(${customer})`, asc(drmsEquipment.serial), asc(drmsEquipment.drmsId));

  const mono = rows.filter((r) => !r.isColour).length;
  return {
    count: rows.length,
    customers: countCustomers(rows),
    hasMono: mono > 0,
    mono,
    names: rows.slice(0, NAME_LIMIT).map((r) => `${r.customer} · ${r.serial ?? r.drmsId}`),
  };
}
