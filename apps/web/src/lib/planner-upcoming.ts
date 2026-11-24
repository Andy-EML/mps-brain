import type { PmStatus, PmSuggestion, UpcomingCall, UpcomingEngineer } from '@mps/db/queries';
import { customerHref } from '../components/customers';
import { formatDayMonth, shortModel } from './format';
import { visibleColumnOf } from './planner-columns';

/**
 * The `/pm/planner` PMs-in-area panel (was Upcoming jobs): display text and the view model the (client) panel renders. Pure. Built on the server so the panel never imports
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

/**
 * A call's suggestions split into the machines at the call's own site (folded into one line in the
 * panel) and the rest nearby. Loader order is kept in both.
 */
export function groupCallSuggestions(call: Pick<UpcomingCall, 'suggestions'>): { site: PmSuggestion[]; others: PmSuggestion[] } {
  const site: PmSuggestion[] = [];
  const others: PmSuggestion[] = [];
  for (const s of call.suggestions) (s.sameSite ? site : others).push(s);
  return { site, others };
}

/** The compact call line: `09:30 St Catherine's School · 8 nearby` (`none nearby` when there are none). */
export function callSummaryText(time: string, customer: string, nearby: number): string {
  return `${time} ${customer} · ${nearby === 0 ? 'none' : nearby} nearby`;
}

/** The folded site line: `St Catherine's School — 6 machines here`. */
export function siteGroupText(customer: string, n: number): string {
  return `${customer} — ${n} ${n === 1 ? 'machine' : 'machines'} here`;
}

/** One machine's compact line: `Acme · C300i · overdue 8m · 0.4 mi` (empty parts left out). */
export function suggestionLine(s: PmSuggestion): string {
  const due = s.overdueMonths !== null && s.overdueMonths >= 1 ? `overdue ${s.overdueMonths}m` : s.status === 'due_soon' ? 'due soon' : null;
  const distance = suggestionDistanceText(s).replace(/^Same /, 'same ');
  return [s.customerName ?? 'Unknown customer', shortModel(s.model), due, distance].filter(Boolean).join(' · ');
}

const ON_BOARD_LABEL = { planned: 'Planned', booked: 'Booked' } as const;

export interface UpcomingSuggestionView {
  id: number;
  customer: string;
  /** Full model and serial, for accessible names and the row's tooltip. */
  machine: string;
  /** `customer · short model · overdue 8m · 0.4 mi`. */
  line: string;
  status: PmStatus;
  priority: boolean;
  whenInArea: boolean;
  /** The board column the machine already shows in (Planned also keeps Ask); null when it is free. */
  onBoard: 'Planned' | 'Booked' | null;
  /** Not on the board (a Done card counts as not on it), so it can be added or asked about. */
  canAdd: boolean;
  /** The call has an engineer to ring and the machine is not Booked (a Planned machine can still be asked about). */
  canAsk: boolean;
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
  /** How many due machines are suggested for the call (site + others). */
  nearby: number;
  /** `09:30 Bravo Ltd · 4 nearby`. */
  summary: string;
  /** `Bravo Ltd — 2 machines here`, or null when no machine is at the call's site. */
  siteText: string | null;
  /** Machines at the call's own site. */
  site: UpcomingSuggestionView[];
  /** The other machines nearby. */
  others: UpcomingSuggestionView[];
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
  /** Shown instead of the engineers when there are no calls (says so when the diary has not refreshed). */
  empty: string | null;
  /** The day switch's labels: `Today 24 Nov` / `Tomorrow 25 Nov` (`Today` / `Tomorrow` without dates). */
  dayLabels: { today: string; tomorrow: string };
  engineers: UpcomingEngineerView[];
}

function dayHeading(which: 'today' | 'tomorrow', date: string | undefined): string {
  const label = which === 'today' ? 'Today' : 'Tomorrow';
  return date ? `${label} ${formatDayMonth(new Date(`${date}T12:00:00Z`))}` : label;
}

function locationNote(located: 'customer' | 'district' | null, district: string | null): string | null {
  if (located !== null) return null;
  return district ? `No map location — matching on ${district} only` : 'No location for this call';
}

/**
 * The panel's view model from `loadUpcoming` (its engineers and, when given, the London dates of the
 * two days), the recent `sync_runs`. Both days are built; the panel's
 * Today / Tomorrow switch picks one.
 */
export function upcomingView(
  data: { engineers: UpcomingEngineer[]; today?: string; tomorrow?: string },
  runs: RunLike[],
  now: Date,
): UpcomingPanelView {
  const dayLabels = { today: dayHeading('today', data.today), tomorrow: dayHeading('tomorrow', data.tomorrow) };
  if (data.engineers.length === 0) {
    return {
      empty: diaryNeedsRefresh(runs, now) ? "Engineers' diary hasn't refreshed yet" : 'No booked calls today or tomorrow',
      dayLabels,
      engineers: [],
    };
  }
  const engineers = data.engineers.map((e): UpcomingEngineerView => {
    const canAsk = e.engineerId !== null;
    const suggestionView = (s: PmSuggestion): UpcomingSuggestionView => {
      const column = s.boardColumn === null ? null : visibleColumnOf(s.boardColumn);
      const free = column === null;
      return {
        id: s.vantageEquipmentId,
        customer: s.customerName ?? 'Unknown customer',
        machine: [s.model, s.serial].filter(Boolean).join(' · ') || 'Unknown machine',
        line: suggestionLine(s),
        status: s.status,
        priority: s.priority,
        whenInArea: s.whenInArea,
        onBoard: column === null ? null : ON_BOARD_LABEL[column],
        canAdd: free,
        canAsk: canAsk && column !== 'booked',
      };
    };
    return {
      key: e.engineerId === null ? 'unassigned' : String(e.engineerId),
      name: e.name,
      canAsk,
      days: e.days.map((d) => ({
        which: d.which,
        heading: dayHeading(d.which, d.date),
        emptyText: `No booked calls ${d.which}`,
        calls: d.calls.map((c): UpcomingCallView => {
          const customer = c.customerName ?? 'Unknown customer';
          const time = callTimeText(c.start);
          const { site, others } = groupCallSuggestions(c);
          return {
            workUnitId: c.workUnitId,
            anchor: `call-${c.workUnitId}`,
            time,
            customer,
            customerLink: c.customerId !== null ? customerHref(c.customerId) : null,
            reference: c.reference,
            category: c.categoryName,
            equipment: c.equipment,
            started: c.started,
            locationNote: locationNote(c.located, c.district),
            nearby: c.suggestions.length,
            summary: callSummaryText(time, customer, c.suggestions.length),
            siteText: site.length > 0 ? siteGroupText(customer, site.length) : null,
            site: site.map(suggestionView),
            others: others.map(suggestionView),
          };
        }),
      })),
    };
  });
  return { empty: null, dayLabels, engineers };
}
