'use server';

import { revalidatePath } from 'next/cache';
import { SettingsError, planFromMap, setPriority } from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { mapResultText, parseMapIds, parsePriorityInput, parseWorkUnitId } from '@/lib/planner-map';

/**
 * The PM map's bulk actions: add the selected machines to the plan, or ask an engineer about them
 * for a call. Called from the client map, so they return a result for the toast instead of
 * redirecting. Recorded in this app only. `requireUser()` first (a server action is a public POST).
 */
export type MapActionResult = { ok: true; text: string } | { ok: false; error: string };

async function run(ids: unknown, mode: 'add' | 'ask', rawWorkUnitId?: unknown): Promise<MapActionResult> {
  const user = await requireUser();
  let workUnitId: number | undefined;
  if (mode === 'ask') {
    try {
      workUnitId = parseWorkUnitId(rawWorkUnitId);
    } catch {
      return { ok: false, error: 'That call is no longer in the diary — refresh the map' };
    }
  }
  try {
    const vantageEquipmentIds = parseMapIds(ids);
    const r = await planFromMap(getDb(), { vantageEquipmentIds, mode, workUnitId, userId: user.userId });
    revalidatePath('/pm/planner');
    revalidatePath('/pm');
    return { ok: true, text: mapResultText(r, mode) };
  } catch (err) {
    if (err instanceof SettingsError) return { ok: false, error: err.message };
    console.error('[pm-map] action failed', err);
    return { ok: false, error: "Couldn't save — try again" };
  }
}

export async function mapAddToPlanAction(ids: number[]): Promise<MapActionResult> {
  return run(ids, 'add');
}

export async function mapAskEngineerAction(ids: number[], workUnitId: number): Promise<MapActionResult> {
  return run(ids, 'ask', workUnitId);
}

/** The map popup's Priority star for one machine. */
export async function mapSetPriorityAction(id: number, on: boolean): Promise<MapActionResult> {
  const user = await requireUser();
  try {
    const p = parsePriorityInput(id, on);
    await setPriority(getDb(), { vantageEquipmentId: p.vantageEquipmentId, on: p.on, userId: user.userId });
    revalidatePath('/pm/planner');
    revalidatePath('/pm');
    return { ok: true, text: p.on ? 'Priority set' : 'Priority cleared' };
  } catch (err) {
    if (err instanceof SettingsError) return { ok: false, error: err.message };
    console.error('[pm-map] priority failed', err);
    return { ok: false, error: "Couldn't save — try again" };
  }
}
