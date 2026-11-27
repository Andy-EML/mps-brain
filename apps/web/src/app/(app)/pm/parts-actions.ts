'use server';

import { getDeviceParts, type DeviceParts } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseMapIds } from '@/lib/planner-map';

export type DevicePartsResult = { ok: true; data: DeviceParts } | { ok: false; error: string };

/**
 * Parts and toner for one machine, by Vantage equipment id, for the panels opened on demand (the
 * `/pm` row detail, the PM map's Device details, PMs in area). Read only. `requireUser()` first
 * (a server action is a public POST).
 */
export async function loadDevicePartsAction(vantageEquipmentId: number): Promise<DevicePartsResult> {
  await requireUser();
  let id: number;
  try {
    [id] = parseMapIds([vantageEquipmentId]) as [number];
  } catch {
    return { ok: false, error: 'Unknown machine' };
  }
  try {
    return { ok: true, data: await getDeviceParts(getDb(), { vantageEquipmentId: id }, new Date()) };
  } catch (err) {
    console.error('[parts] load failed', err);
    return { ok: false, error: "Couldn't load parts — try again" };
  }
}
