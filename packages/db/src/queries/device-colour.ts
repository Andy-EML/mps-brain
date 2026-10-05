import { isColourModel } from '@mps/core';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { deviceLinks, drmsEquipment, vantageEquipment } from '../schema';

/**
 * Whether each Vantage equipment id is a colour device, for classifying a sales-order line whose
 * text has no colour word (`classifyOrderLine`'s mono-device fallback, @mps/core).
 *
 * Prefers the linked DRMS device's `is_colour` (kept current by `isColourModel` on every DRMS pull,
 * and correct even where KM's fixed catalogue rule fails); falls back to `isColourModel` on the
 * Vantage equipment's own `description` when there is no active link. An id with neither a link nor
 * a Vantage row is left out of the map, so callers must treat a missing entry as unknown (not mono).
 */
export async function getDeviceIsColourByVantageEquipmentIds(
  db: Db,
  vantageEquipmentIds: number[],
): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  const ids = [...new Set(vantageEquipmentIds)];
  if (ids.length === 0) return out;

  const rows = await db
    .select({
      vantageId: vantageEquipment.vantageId,
      description: vantageEquipment.description,
      linkedIsColour: drmsEquipment.isColour,
      linkedAt: deviceLinks.linkedAt,
    })
    .from(vantageEquipment)
    .leftJoin(
      deviceLinks,
      and(eq(deviceLinks.vantageEquipmentId, vantageEquipment.vantageId), isNull(deviceLinks.unlinkedAt)),
    )
    .leftJoin(drmsEquipment, eq(drmsEquipment.drmsId, deviceLinks.drmsEquipmentId))
    .where(inArray(vantageEquipment.vantageId, ids));

  for (const r of rows) {
    out.set(r.vantageId, r.linkedAt !== null ? (r.linkedIsColour ?? false) : isColourModel(r.description));
  }
  return out;
}
