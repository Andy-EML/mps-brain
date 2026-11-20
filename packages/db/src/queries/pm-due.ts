import { meterAt, type YieldMeterPoint } from './toner-yield';

/**
 * Pure rules for the read-only, meter-driven "PM due" list. No DB access: callers pass work units and
 * meter points in, and get a status plus the evidence behind it.
 */

const DAY_MS = 86_400_000;
const STALE_METER_DAYS = 30;
const RATE_WINDOW_DAYS = 90;
const MIN_RATE_SPAN_DAYS = 14;
const MAX_RATE_REF_DAYS = 120;

export interface PmSettings {
  intervalPages: number;
  timeCapMonths: number;
  qualifyingMinutes: number;
  frequentCount: number;
  frequentWindowDays: number;
  holdDays: number;
  dueSoonPct: number;
  dueSoonDays: number;
  pmCategoryIds: number[];
  /** A used part whose description contains one of these (case-insensitive) resets the PM clock. */
  pmPartKeywords: string[];
}

export const DEFAULT_PM_SETTINGS: PmSettings = {
  intervalPages: 100000,
  timeCapMonths: 12,
  qualifyingMinutes: 45,
  frequentCount: 3,
  frequentWindowDays: 30,
  holdDays: 30,
  dueSoonPct: 0.85,
  dueSoonDays: 30,
  pmCategoryIds: [],
  pmPartKeywords: ['drum', 'fuser', 'transfer belt', 'transfer roller'],
};

export interface VisitUnit {
  workUnitId: number;
  workId: number;
  reference: string | null;
  categoryId: number | null;
  categoryName: string | null;
  categoryType: string | null;
  start: Date | null;
  end: Date | null;
  logged: Date | null;
  hours: number | null;
  scheduled: Date | null;
  completed: Date | null;
  /** The engineer's action text for the unit (Vantage work unit action details). */
  actionDetails: string | null;
  /** Parts fitted on the unit (WorkItems with Status Used). */
  parts: { partNumber: string | null; description: string; quantity: number }[];
}

export interface Visit {
  /** yyyy-mm-dd, Europe/London calendar day. */
  day: string;
  /** Earliest unit time (start ?? logged) of the day. */
  at: Date;
  /** Field minutes only: what the qualifying rules use. */
  minutes: number | null;
  /** Sum of every unit's length (Field or not), for display; null when no unit has a length. */
  displayMinutes: number | null;
  isField: boolean;
  isPm: boolean;
  /** Descriptions of used parts that matched a PM part keyword. */
  matchedParts: string[];
  /** The keywords those parts matched, in settings order. */
  matchedKeywords: string[];
  units: VisitUnit[];
}

export type VisitVerdict = 'counted' | 'counted_pm' | 'counted_parts' | 'too_short' | 'not_field' | 'unknown_length';
export type PmStatus = 'booked' | 'held' | 'unknown' | 'overdue' | 'due_soon' | 'ok';

/**
 * reason values: `meter_reset`, `no_meter` (unknown); `no_visit_12m`, `time_cap`, `pages` (overdue).
 * null for every other status.
 */
export interface PmResult {
  status: PmStatus;
  reason: string | null;
  lastQualifying: Visit | null;
  pagesSince: number | null;
  pagesSinceIsLowerBound: boolean;
  /** pagesSince / intervalPages as a fraction (0.86 = 86%). */
  pctUsed: number | null;
  pagesPerDay: number | null;
  estDueDate: Date | null;
  timeCapDate: Date | null;
  /** When the PM clock started: the latest of the last qualifying visit, install date and manual reset. */
  clockStart: Date | null;
  clockSource: 'visit' | 'install' | 'manual' | null;
  bookedFor: Date | null;
  frequentVisits: number;
  holdUntil: Date | null;
  visits: PmVisit[];
}

export interface PmVisit {
  visit: Visit;
  verdict: VisitVerdict;
  /** Combined (black + colour) meter at the visit, or null when there is no reading near it. */
  meter: number | null;
  /** This visit's meter minus the next-older visit's; null when either is missing or it is negative. */
  pagesSincePrev: number | null;
}

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const londonDay = (d: Date): string => dayFmt.format(d);

/** hours*60 if hours > 0; else end - start when both set and under 24h; else null. */
export function unitMinutes(u: VisitUnit): number | null {
  if (u.hours !== null && u.hours > 0) return u.hours * 60;
  if (u.start && u.end) {
    const ms = u.end.getTime() - u.start.getTime();
    if (ms > 0 && ms < DAY_MS) return ms / 60_000;
  }
  return null;
}

const unitTime = (u: VisitUnit): Date | null => u.start ?? u.logged;
const isPmUnit = (u: VisitUnit, s: PmSettings): boolean => u.categoryId !== null && s.pmCategoryIds.includes(u.categoryId);

/**
 * Visits = attended past units (start ?? logged <= now) grouped by Europe/London day, newest first.
 * A unit with no start and no completion was booked or logged but never attended, so it is not a
 * visit. `now` defaults to the current time; pass it for determinism.
 */
export function groupVisits(units: VisitUnit[], s: PmSettings, now: Date = new Date()): Visit[] {
  const byDay = new Map<string, { at: Date; units: VisitUnit[] }>();
  for (const u of units) {
    if (u.start === null && u.completed === null) continue;
    const t = unitTime(u);
    if (!t || t.getTime() > now.getTime()) continue;
    const day = londonDay(t);
    const g = byDay.get(day);
    if (!g) byDay.set(day, { at: t, units: [u] });
    else {
      g.units.push(u);
      if (t.getTime() < g.at.getTime()) g.at = t;
    }
  }
  const visits: Visit[] = [];
  for (const [day, g] of byDay) {
    // Only Field units count towards the length rules; an unknown Field length with a known total
    // under the threshold leaves the length unknown (not too_short).
    const fieldUnits = g.units.filter((u) => u.categoryType === 'Field');
    const mins = fieldUnits.map(unitMinutes);
    const known = mins.filter((m): m is number => m !== null);
    const knownTotal = known.reduce((a, b) => a + b, 0);
    const hasUnknown = known.length < mins.length;
    const minutes = known.length === 0 || (hasUnknown && knownTotal < s.qualifyingMinutes) ? null : knownTotal;
    const allMins = g.units.map(unitMinutes).filter((m): m is number => m !== null);
    const kws = s.pmPartKeywords.map((k) => k.toLowerCase()).filter((k) => k !== '');
    const matchedParts: string[] = [];
    const matchedKeywords = new Set<string>();
    for (const u of g.units) {
      for (const part of u.parts) {
        const desc = part.description.toLowerCase();
        const hit = kws.filter((k) => desc.includes(k));
        if (hit.length === 0) continue;
        if (!matchedParts.includes(part.description)) matchedParts.push(part.description);
        for (const k of hit) matchedKeywords.add(k);
      }
    }
    visits.push({
      day,
      at: g.at,
      minutes,
      displayMinutes: allMins.length === 0 ? null : allMins.reduce((a, b) => a + b, 0),
      isField: g.units.some((u) => u.categoryType === 'Field'),
      isPm: g.units.some((u) => isPmUnit(u, s)),
      matchedParts,
      matchedKeywords: kws.filter((k) => matchedKeywords.has(k)),
      units: g.units,
    });
  }
  return visits.sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** PM category first (its category type is not Field), then field-only, then length. */
export function visitVerdict(v: Visit, s: PmSettings): VisitVerdict {
  if (v.isPm) return 'counted_pm';
  if (v.matchedParts.length > 0) return 'counted_parts';
  if (!v.isField) return 'not_field';
  if (v.minutes === null) return 'unknown_length';
  return v.minutes < s.qualifyingMinutes ? 'too_short' : 'counted';
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}

export function computePm(args: {
  units: VisitUnit[];
  meter: YieldMeterPoint[];
  intervalPages: number;
  s: PmSettings;
  now: Date;
  installedAt?: Date | null;
  manualResetAt?: Date | null;
}): PmResult {
  const { units, meter, intervalPages, s, now } = args;
  const installedAt = args.installedAt ?? null;
  const manualResetAt = args.manualResetAt ?? null;
  const nowMs = now.getTime();

  const allVisits = groupVisits(units, s, now);
  const meters = allVisits.map((visit) => meterAt(meter, visit.at)?.value ?? null);
  const visits: PmVisit[] = allVisits.map((visit, i) => {
    const m = meters[i] ?? null;
    const older = meters[i + 1] ?? null;
    const diff = m !== null && older !== null ? m - older : null;
    return { visit, verdict: visitVerdict(visit, s), meter: m, pagesSincePrev: diff !== null && diff >= 0 ? diff : null };
  });
  const lastQualifying =
    visits.find((x) => x.verdict === 'counted' || x.verdict === 'counted_pm' || x.verdict === 'counted_parts')?.visit ?? null;

  // Booked: an uncompleted PM-category unit scheduled for today or later.
  const today = londonDay(now);
  let bookedFor: Date | null = null;
  for (const u of units) {
    if (!isPmUnit(u, s) || u.completed !== null || !u.scheduled) continue;
    if (londonDay(u.scheduled) < today) continue;
    if (!bookedFor || u.scheduled.getTime() < bookedFor.getTime()) bookedFor = u.scheduled;
  }

  // Held: frequent Field visits (any duration). Only a span ending inside the last window can hold.
  const fieldTimes = allVisits.filter((v) => v.isField).map((v) => v.at.getTime());
  const windowMs = s.frequentWindowDays * DAY_MS;
  let frequentVisits = 0;
  for (const t of fieldTimes) {
    if (nowMs - t > windowMs) continue;
    frequentVisits = Math.max(frequentVisits, fieldTimes.filter((o) => o <= t && t - o <= windowMs).length);
  }
  const lastField = fieldTimes.length ? Math.max(...fieldTimes) : null;
  const holdUntil =
    frequentVisits >= s.frequentCount && lastField !== null ? new Date(lastField + s.holdDays * DAY_MS) : null;

  // The clock starts at the latest of the last qualifying visit, the install date and a manual reset.
  let clockStart: Date | null = lastQualifying?.at ?? null;
  let clockSource: 'visit' | 'install' | 'manual' | null = clockStart ? 'visit' : null;
  if (installedAt && (!clockStart || installedAt.getTime() > clockStart.getTime())) {
    clockStart = installedAt;
    clockSource = 'install';
  }
  if (manualResetAt && (!clockStart || manualResetAt.getTime() > clockStart.getTime())) {
    clockStart = manualResetAt;
    clockSource = 'manual';
  }
  const timeCapDate = clockStart ? addMonths(clockStart, s.timeCapMonths) : null;

  // Pages since the last qualifying visit.
  const latest = meter[meter.length - 1] ?? null;
  const stale = latest !== null && nowMs - latest.at.getTime() > STALE_METER_DAYS * DAY_MS;
  let pagesSince: number | null = null;
  let pagesSinceIsLowerBound = false;
  let unusableReason: 'meter_reset' | 'no_meter' | null = null;
  if (!latest || stale) unusableReason = 'no_meter';
  else if (clockStart) {
    const at = meterAt(meter, clockStart);
    // `basePoint` is the reading the base rests on (null when interpolated), to spot "base is the latest reading".
    let baseValue: number | null = at?.value ?? null;
    let basePoint: YieldMeterPoint | null = at && !at.estimated ? (at.before ?? at.after) : null;
    let lowerBound = false;
    if (!at) {
      // The clock started before the meter history (installs, and visits older than the 24 months of
      // readings held): use the first reading after it; pages before it are unseen when the gap exceeds 30 days.
      basePoint = meter.find((p) => p.at.getTime() > clockStart!.getTime()) ?? null;
      baseValue = basePoint?.value ?? null;
      lowerBound = basePoint !== null && basePoint.at.getTime() - clockStart.getTime() > STALE_METER_DAYS * DAY_MS;
    }
    if (baseValue === null || basePoint === latest || latest.at.getTime() <= clockStart.getTime()) unusableReason = 'no_meter';
    else if (latest.value < baseValue) unusableReason = 'meter_reset';
    else {
      pagesSince = latest.value - baseValue;
      pagesSinceIsLowerBound = lowerBound;
    }
  } else {
    const windowStart = addMonths(now, -s.timeCapMonths).getTime();
    const first = meter.find((p) => p.at.getTime() >= windowStart);
    if (first && first !== latest && latest.value >= first.value) {
      pagesSince = latest.value - first.value;
      pagesSinceIsLowerBound = true;
    } else unusableReason = 'no_meter';
  }
  const pctUsed = pagesSince === null || intervalPages <= 0 ? null : pagesSince / intervalPages;

  // Rate over the last 90 days (or the whole history when it spans at least 14 days).
  let pagesPerDay: number | null = null;
  if (latest) {
    const latestMs = latest.at.getTime();
    const cutoff = latestMs - RATE_WINDOW_DAYS * DAY_MS;
    const oldest = latestMs - MAX_RATE_REF_DAYS * DAY_MS;
    let ref: YieldMeterPoint | null = null;
    for (const p of meter) if (p.at.getTime() <= cutoff && p.at.getTime() >= oldest) ref = p;
    if (!ref) {
      const first = meter.find((p) => p.at.getTime() >= oldest) ?? null;
      if (first && latestMs - first.at.getTime() >= MIN_RATE_SPAN_DAYS * DAY_MS) ref = first;
    }
    if (ref && ref !== latest) {
      const days = (latestMs - ref.at.getTime()) / DAY_MS;
      const rate = (latest.value - ref.value) / days;
      if (days > 0 && rate >= 0) pagesPerDay = rate;
    }
  }
  let estDueDate: Date | null = null;
  if (latest && pagesSince !== null && pagesPerDay !== null && pagesPerDay > 0) {
    const remaining = Math.max(0, intervalPages - pagesSince);
    estDueDate = new Date(latest.at.getTime() + (remaining / pagesPerDay) * DAY_MS);
  }

  const result = (status: PmStatus, reason: string | null): PmResult => ({
    status,
    reason,
    lastQualifying,
    pagesSince,
    pagesSinceIsLowerBound,
    pctUsed,
    pagesPerDay,
    estDueDate,
    timeCapDate,
    clockStart,
    clockSource,
    bookedFor,
    frequentVisits,
    holdUntil,
    visits,
  });

  if (bookedFor) return result('booked', null);
  if (holdUntil && nowMs < holdUntil.getTime()) return result('held', null);
  if (!clockStart) return result('overdue', 'no_visit_12m');
  if (pagesSince !== null && pagesSince >= intervalPages) return result('overdue', 'pages');
  if (timeCapDate && nowMs >= timeCapDate.getTime()) return result('overdue', 'time_cap');
  if (pagesSince === null) return result('unknown', unusableReason ?? 'no_meter');
  const soonMs = s.dueSoonDays * DAY_MS;
  if (
    (pctUsed !== null && pctUsed >= s.dueSoonPct) ||
    (estDueDate && estDueDate.getTime() - nowMs <= soonMs) ||
    (timeCapDate && timeCapDate.getTime() - nowMs <= soonMs)
  )
    return result('due_soon', null);
  return result('ok', null);
}
