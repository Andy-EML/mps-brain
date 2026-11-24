import type { Db } from '../client';
import { moveCard, addToPlan } from './pm-plan';
import { getScheduledCall, loadMapPins } from './pm-planner';
import { SettingsError } from './settings';

const dayMonthParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });

/** The board note an Ask leaves: `Asked Dave for 24 Nov` (the call's London day). */
export function askNote(engineerName: string, callStart: Date): string {
  const p = dayMonthParts.formatToParts(callStart);
  const part = (type: string) => p.find((x) => x.type === type)?.value ?? '';
  return `Asked ${engineerName} for ${part('day')} ${part('month')}`;
}

export type MapSkipReason = 'not_on_map' | 'booked';

export interface MapPlanResult {
  done: number[];
  skipped: { vantageEquipmentId: number; reason: MapSkipReason }[];
  call?: { engineerName: string; start: Date };
}

/**
 * Batch Add-to-plan / Ask-engineer for machines box-selected on the PM map. The map set is re-read
 * here, so a machine that was booked, dismissed or otherwise left the map since the page loaded is
 * skipped rather than planned. Asking needs the call to still be in the diary; if not, nothing is
 * written.
 */
export async function planFromMap(
  db: Db,
  a: { vantageEquipmentIds: number[]; mode: 'add' | 'ask'; workUnitId?: number; userId: number; now?: Date },
): Promise<MapPlanResult> {
  const now = a.now ?? new Date();
  const ids = [...new Set(a.vantageEquipmentIds)];

  let call: { engineerName: string; start: Date } | undefined;
  if (a.mode === 'ask') {
    const c = a.workUnitId === undefined ? null : await getScheduledCall(db, a.workUnitId);
    if (!c) throw new SettingsError('That call is no longer in the diary — refresh the map', 'call_gone');
    call = { engineerName: c.engineerName, start: c.start };
  }

  const { pins } = await loadMapPins(db, now);
  const byId = new Map(pins.map((p) => [p.vantageEquipmentId, p]));
  const done: number[] = [];
  const skipped: MapPlanResult['skipped'] = [];
  const todo: number[] = [];
  for (const id of ids) {
    const pin = byId.get(id);
    if (!pin) skipped.push({ vantageEquipmentId: id, reason: 'not_on_map' });
    else if (pin.boardColumn === 'booked') skipped.push({ vantageEquipmentId: id, reason: 'booked' });
    else todo.push(id);
  }

  if (a.mode === 'add') {
    // Not on the board, or a Done card (hidden): addToPlan puts both on To plan and leaves To plan / Asked alone.
    const toAdd = todo.filter((id) => {
      const column = byId.get(id)!.boardColumn;
      return column === null || column === 'done';
    });
    await addToPlan(db, { vantageEquipmentIds: toAdd, userId: a.userId, now });
    done.push(...todo);
    return { done, skipped };
  }

  const note = askNote(call!.engineerName, call!.start);
  for (const id of todo) {
    await moveCard(db, { vantageEquipmentId: id, to: 'asked', appendNote: note, userId: a.userId, now });
    done.push(id);
  }
  return { done, skipped, call };
}
