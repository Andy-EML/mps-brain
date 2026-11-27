// Types only from @mps/db: this module is used by client components.
import type { DeviceParts, PartState, PartStatusRow } from '@mps/db/queries';
import type { Tone } from './toner';
import { formatDate, formatNumber } from '../lib/format';

/**
 * Display helpers for the Parts panel (device page, `/pm` row, PM map, PMs in area). Pure, no JSX.
 * See docs/superpowers/plans/2026-11-26-parts-status.md.
 */

/** How far back the visit history goes, for "not seen in 36 months". */
export const PART_HISTORY_MONTHS = 36;

const SHORT_LABEL: Record<PartStatusRow['part'], string> = {
  drum: 'Drum',
  developer: 'Developer',
  transfer_belt: 'Transfer belt',
  transfer_roller: 'Transfer roller',
  fuser: 'Fuser',
};

/** The table's Part cell: `Drum K`, `Developer C`, `Transfer belt`, `Fuser`. */
export function partRowLabel(row: Pick<PartStatusRow, 'part' | 'colour'>): string {
  return row.colour ? `${SHORT_LABEL[row.part]} ${row.colour}` : SHORT_LABEL[row.part];
}

const STATE_LABEL: Record<PartState, string> = {
  end: 'End',
  near_end: 'Near end',
  predicted: 'Predicted',
  cleared: 'Cleared',
  ok: 'OK',
};

const STATE_TONE: Record<PartState, Tone> = {
  end: 'critical',
  near_end: 'warn',
  predicted: 'warn',
  cleared: 'muted',
  ok: 'ok',
};

const STATE_TITLE: Record<PartState, string> = {
  end: 'End of life — DRMS 2nd call',
  near_end: 'Near end of life — DRMS 1st call',
  predicted: 'Predicted to reach end soon — DRMS prediction',
  cleared: 'Had an alarm, fitted since',
  ok: 'No parts alarm',
};

export const partStateLabel = (s: PartState): string => STATE_LABEL[s];
export const partStateTone = (s: PartState): Tone => STATE_TONE[s];

/** The badge's tooltip: what the state means, and when the alarm came in. */
export function partStateTitle(row: Pick<PartStatusRow, 'state' | 'alarm'>): string {
  const base = STATE_TITLE[row.state];
  return row.alarm ? `${base} (alarm ${formatDate(row.alarm.receivedAt)})` : base;
}

/** Est. life left: `~12%`, or `''` when there is no rated life or no page count since the fit. */
export function pctLeftText(pctLeft: number | null): string {
  if (pctLeft === null || !Number.isFinite(pctLeft)) return '';
  return `~${Math.round(Math.max(0, pctLeft) * 100)}%`;
}

/** Tone for the life-left figure: red at 0-10%, amber under 25%, else plain. */
export function pctLeftTone(pctLeft: number | null): Tone | null {
  if (pctLeft === null || !Number.isFinite(pctLeft)) return null;
  if (pctLeft <= 0.1) return 'critical';
  if (pctLeft < 0.25) return 'warn';
  return null;
}

/** Last fitted: the visit date, or `not seen in 36 months` when no visit used one. */
export function lastFittedText(lastFitted: PartStatusRow['lastFitted']): string {
  return lastFitted ? formatDate(lastFitted.at) : `not seen in ${PART_HISTORY_MONTHS} months`;
}

/** Pages since the fit: `12,345`, `~12,345` when the meter at the fit was interpolated, `''` when unknown. */
export function partPagesText(pagesSince: number | null, estimated: boolean): string {
  if (pagesSince === null || !Number.isFinite(pagesSince)) return '';
  const n = formatNumber(Math.round(pagesSince));
  return estimated ? `~${n}` : n;
}

/** The panel's top line: `Last visit 3 Nov 2026 · 12,345 pages since`, or why not. */
export function lastVisitLine(lastVisit: DeviceParts['lastVisit']): string {
  if (!lastVisit) return 'No field visit on record';
  const since = lastVisit.pagesSince === null ? '' : ` · ${formatNumber(Math.round(lastVisit.pagesSince))} pages since`;
  return `Last visit ${formatDate(lastVisit.at)}${since}`;
}

/** True when some part row has a rated life, i.e. the family has lives set. */
export const hasRatedLives = (parts: Pick<PartStatusRow, 'ratedLife'>[]): boolean => parts.some((p) => p.ratedLife !== null);

/** The note under the table when % left can't be worked out, or null. */
export function ratedLifeNote(d: Pick<DeviceParts, 'familyName' | 'parts'>): string | null {
  if (d.familyName === null) return 'Model is not in a cartridge family, so there are no rated lives for % left.';
  if (!hasRatedLives(d.parts)) return `No rated part lives set for ${d.familyName} yet (Settings › Cartridge families).`;
  return null;
}

/** The alarm date shown beside the state badge (`2 Nov 2026`), or `''` when the part has no alarm. */
export function partAlarmDateText(row: Pick<PartStatusRow, 'alarm'>): string {
  return row.alarm ? formatDate(row.alarm.receivedAt) : '';
}
