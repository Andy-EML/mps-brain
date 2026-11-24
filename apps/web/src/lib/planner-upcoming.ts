import { SettingsError, type BoardColumn, type PmStatus, type PmSuggestion, type UpcomingEngineer } from '@mps/db/queries';
import { customerHref } from '../components/customers';
import { formatDayMonth } from './format';

/**
 * The `/pm/planner` upcoming-jobs panel: display text, the Ask-engineer / Add-to-plan forms and the
 * view model the (client) panel renders. Pure. Built on the server so the panel never imports
 * database values. Asking an engineer is recorded in this app only — the office rings the engineer;
 * nothing is sent to anyone or written to Vantage.
 */

const TIME_ZONE = 'Europe/London';
/** The diary job runs every 30 minutes in working hours; older than this and an empty panel is suspect. */
const DIARY_STALE_MS = 2 * 3_600_000;
const SCHEDULE_JOB = 'vantage-schedule';

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** A call's start as `09:30`, Europe/London. */
export function callTimeText(start: Date): string {
  return timeFormat.format(start);
}

/** How near a suggestion is: `Same site`, `6.4 mi`, `Same district` (the caller adds the district), else `''`. */
export function suggestionDistanceText(s: Pick<PmSuggestion, 'sameSite' | 'sameDistrict' | 'distanceMiles'>): string {
  if (s.sameSite) return 'Same site';
  if (s.distanceMiles !== null) return `${s.distanceMiles.toFixed(1)} mi`;
  if (s.sameDistrict) return 'Same district';
  return '';
}

export { askNote } from '@mps/db/queries';

function bad(): never {
  throw new SettingsError('That PM action is not valid — check the form and try again.', 'invalid_pm_action');
}

function text(fd: FormData, name: string): string | null {
  const value = fd.get(name);
  return typeof value === 'string' ? value.trim() : null;
}

function machineId(fd: FormData): number {
  return positiveId(text(fd, 'vantageEquipmentId'));
}

function positiveId(raw: string | null): number {
  if (raw === null || !/^\d{1,10}$/.test(raw) || Number(raw) < 1) bad();
  return Number(raw);
}

/**
 * Asked engineer: `vantageEquipmentId` and `call` (the work unit id). The engineer and the call's
 * day are looked up from the call on the server (`getScheduledCall`), never taken from the form.
 */
export function parseAskForm(fd: FormData): { vantageEquipmentId: number; workUnitId: number } {
  return { vantageEquipmentId: machineId(fd), workUnitId: positiveId(text(fd, 'call')) };
}

/** Add to plan from a suggestion: just the machine. */
export function parseSuggestionForm(fd: FormData): { vantageEquipmentId: number } {
  return { vantageEquipmentId: machineId(fd) };
}

/** The posted work unit id as the call's anchor (`call-123`), so the panel comes back to that call. */
export function upcomingAnchor(raw: FormDataEntryValue | string | null): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return /^\d{1,10}$/.test(v) ? `call-${v}` : null;
}

/** A redirect with its hash replaced by `anchor` (unchanged when there is none). */
export function withAnchor(href: string, anchor: string | null): string {
  if (anchor === null) return href;
  return `${href.split('#', 1)[0]}#${anchor}`;
}

export interface RunLike {
  job: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
}

/** True when `vantage-schedule` has not finished a good run (success or partial) in the last 2 hours. */
export function diaryNeedsRefresh(runs: RunLike[], now: Date): boolean {
  const good = runs
    .filter((r) => r.job === SCHEDULE_JOB && (r.status === 'success' || r.status === 'partial'))
    .map((r) => (r.finishedAt ?? r.startedAt).getTime());
  if (good.length === 0) return true;
  return now.getTime() - Math.max(...good) > DIARY_STALE_MS;
}

const COLUMN_LABEL: Record<BoardColumn, string> = { to_plan: 'To plan', asked: 'Asked engineer', booked: 'Booked', done: 'Done' };

export interface UpcomingSuggestionView {
  id: number;
  customer: string;
  machine: string;
  status: PmStatus;
  /** `overdue 18m` (red), or null under a month. */
  overdueText: string | null;
  priority: boolean;
  whenInArea: boolean;
  distanceText: string;
  /** `On board: To plan`, or null when the machine is not on the board. */
  onBoardText: string | null;
  canAsk: boolean;
  /** Not on the board yet (or only in Done, which Add to plan starts again). */
  canAdd: boolean;
  /** A refused action on this machine. */
  error: string | null;
}

export interface UpcomingCallView {
  workUnitId: number;
  anchor: string;
  time: string;
  customer: string;
  customerLink: string | null;
  reference: string | null;
  category: string | null;
  equipment: string | null;
  started: boolean;
  /** Muted note when the call could not be placed on the map. */
  locationNote: string | null;
  suggestions: UpcomingSuggestionView[];
}

export interface UpcomingDayView {
  which: 'today' | 'tomorrow';
  heading: string;
  emptyText: string;
  calls: UpcomingCallView[];
}

export interface UpcomingEngineerView {
  key: string;
  name: string;
  /** False for unassigned calls: there is nobody to ring. */
  canAsk: boolean;
  days: UpcomingDayView[];
}

export interface UpcomingPanelView {
  /** Shown instead of the engineers when there are no calls. */
  empty: string | null;
  engineers: UpcomingEngineerView[];
  /** The refused action's machine is under one of the calls (so the page need not repeat the error). */
  showsError: boolean;
}

function dayHeading(which: 'today' | 'tomorrow', date: string): string {
  return `${which === 'today' ? 'Today' : 'Tomorrow'} ${formatDayMonth(new Date(`${date}T12:00:00Z`))}`;
}

function locationNote(located: 'customer' | 'district' | null, district: string | null): string | null {
  if (located !== null) return null;
  return district ? `No map location — matching on ${district} only` : 'No location for this call';
}

/** The panel's view model from `loadUpcoming`, the recent `sync_runs` and a refused action (if any). */
export function upcomingView(
  data: { engineers: UpcomingEngineer[] },
  runs: RunLike[],
  now: Date,
  error: { card: number; message: string } | null,
): UpcomingPanelView {
  if (data.engineers.length === 0) {
    return { empty: diaryNeedsRefresh(runs, now) ? "Engineers' diary hasn't refreshed yet" : 'No booked calls today or tomorrow', engineers: [], showsError: false };
  }
  let showsError = false;
  const engineers = data.engineers.map((e): UpcomingEngineerView => {
    const canAsk = e.engineerId !== null;
    return {
      key: e.engineerId === null ? 'unassigned' : String(e.engineerId),
      name: e.name,
      canAsk,
      days: e.days.map((d) => ({
        which: d.which,
        heading: dayHeading(d.which, d.date),
        emptyText: `No booked calls ${d.which}`,
        calls: d.calls.map((c) => ({
          workUnitId: c.workUnitId,
          anchor: `call-${c.workUnitId}`,
          time: callTimeText(c.start),
          customer: c.customerName ?? 'Unknown customer',
          customerLink: c.customerId !== null ? customerHref(c.customerId) : null,
          reference: c.reference,
          category: c.categoryName,
          equipment: c.equipment,
          started: c.started,
          locationNote: locationNote(c.located, c.district),
          suggestions: c.suggestions.map((s) => {
            const booked = s.boardColumn === 'booked';
            const distance = suggestionDistanceText(s);
            const err = error?.card === s.vantageEquipmentId ? error.message : null;
            if (err !== null) showsError = true;
            return {
              id: s.vantageEquipmentId,
              customer: s.customerName ?? 'Unknown customer',
              machine: [s.model, s.serial].filter(Boolean).join(' · ') || 'Unknown machine',
              status: s.status,
              overdueText: s.overdueMonths !== null && s.overdueMonths >= 1 ? `overdue ${s.overdueMonths}m` : null,
              priority: s.priority,
              whenInArea: s.whenInArea,
              distanceText: distance === 'Same district' && c.district ? `Same district (${c.district})` : distance,
              onBoardText: s.boardColumn === null ? null : `On board: ${COLUMN_LABEL[s.boardColumn]}`,
              canAsk: canAsk && !booked,
              canAdd: s.boardColumn === null || s.boardColumn === 'done',
              error: err,
            };
          }),
        })),
      })),
    };
  });
  return { empty: null, engineers, showsError };
}
