// Types only from planner-upcoming (it imports database values): this module is used by the client
// PMs-in-area panel and the Planned drop zone.
import type { UpcomingCallView, UpcomingPanelView } from './planner-upcoming';
import { MAP_IDS_MAX } from './planner-map';

/** The drag payload's MIME type: machines dragged from PMs in area onto Planned. */
export const PM_IDS_MIME = 'application/x-pm-ids';

/** The drag payload for some machines: `ids:1,2,3`. */
export function dragPayload(ids: number[]): string {
  return `ids:${ids.join(',')}`;
}

const PAYLOAD = /^ids:(\d{1,10}(?:,\d{1,10})*)$/;

/**
 * The machine ids in a drop's `ids:1,2,3` payload, de-duplicated. Anything else — junk, an id under 1,
 * more ids than an action takes — gives `[]`, so the drop does nothing.
 */
export function dragIds(value: string): number[] {
  const m = PAYLOAD.exec(value.trim());
  if (!m) return [];
  const ids = m[1]!.split(',').map(Number);
  if (ids.some((n) => !Number.isSafeInteger(n) || n < 1)) return [];
  const unique = [...new Set(ids)];
  return unique.length > MAP_IDS_MAX ? [] : unique;
}

export interface DayEngineer {
  key: string;
  name: string;
  canAsk: boolean;
  calls: UpcomingCallView[];
}

/**
 * One day of the panel: the engineers with calls that day, or the text to show instead — the panel's
 * own (no calls at all, or the diary has not refreshed) or `No booked calls tomorrow`.
 */
export function dayPanel(view: UpcomingPanelView, which: 'today' | 'tomorrow'): { empty: string | null; engineers: DayEngineer[] } {
  if (view.empty !== null) return { empty: view.empty, engineers: [] };
  const engineers = view.engineers.flatMap((e) => {
    const calls = e.days.find((d) => d.which === which)?.calls ?? [];
    return calls.length > 0 ? [{ key: e.key, name: e.name, canAsk: e.canAsk, calls }] : [];
  });
  return { empty: engineers.length === 0 ? `No booked calls ${which}` : null, engineers };
}
