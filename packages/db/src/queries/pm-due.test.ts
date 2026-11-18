import { describe, expect, it } from 'vitest';
import {
  computePm,
  DEFAULT_PM_SETTINGS,
  groupVisits,
  unitMinutes,
  visitVerdict,
  type PmSettings,
  type VisitUnit,
} from './pm-due';

const NOW = new Date('2026-11-18T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const S: PmSettings = { ...DEFAULT_PM_SETTINGS, pmCategoryIds: [99] };

let seq = 0;
function unit(over: Partial<VisitUnit> & { start: Date | null }): VisitUnit {
  seq += 1;
  return {
    workUnitId: seq,
    workId: seq,
    reference: null,
    categoryId: 1,
    categoryName: 'Repair',
    categoryType: 'Field',
    end: null,
    logged: null,
    hours: null,
    scheduled: null,
    completed: null,
    actionDetails: null,
    parts: [],
    ...over,
  };
}
/** A field unit starting `ago` days back lasting `mins` minutes. */
const field = (ago: number, mins: number, over: Partial<VisitUnit> = {}) => {
  const start = daysAgo(ago);
  return unit({ start, end: new Date(start.getTime() + mins * 60_000), ...over });
};
const pt = (ago: number, value: number) => ({ at: daysAgo(ago), value });
const run = (
  units: VisitUnit[],
  meter: { at: Date; value: number }[],
  s = S,
  extra: { installedAt?: Date | null; manualResetAt?: Date | null } = {},
) => computePm({ units, meter, intervalPages: s.intervalPages, s, now: NOW, ...extra });

describe('unitMinutes', () => {
  it('prefers hours, falls back to end-start under 24h, else null', () => {
    expect(unitMinutes(unit({ start: daysAgo(1), hours: 0.5 }))).toBe(30);
    expect(unitMinutes(field(1, 20))).toBe(20);
    expect(unitMinutes(unit({ start: daysAgo(3), end: daysAgo(1) }))).toBeNull();
    expect(unitMinutes(unit({ start: daysAgo(1) }))).toBeNull();
  });
});

describe('parts fitted', () => {
  it('fuser fitted on a 20-min Return to Fit resets the clock (counted_parts)', () => {
    const u = field(10, 20, { categoryType: 'Office', parts: [{ partNumber: 'AA2JR75300', description: 'Konica C250i Fuser Unit', quantity: 1 }] });
    const visits = groupVisits([u], S, NOW);
    expect(visitVerdict(visits[0]!, S)).toBe('counted_parts');
    expect(visits[0]!.matchedParts).toEqual(['Konica C250i Fuser Unit']);
    expect(visits[0]!.matchedKeywords).toEqual(['fuser']);
    const r = run([u], [pt(40, 1000), pt(10, 5000), pt(0, 9000)]);
    expect(r.lastQualifying?.day).toBe(visits[0]!.day);
    expect(r.clockSource).toBe('visit');
    expect(r.frequentVisits).toBe(0);
  });
  it('rollers only (no keyword) do not count', () => {
    const u = field(10, 20, { parts: [{ partNumber: 'X', description: 'Pickup Roller', quantity: 2 }] });
    const v = groupVisits([u], S, NOW)[0]!;
    expect(v.matchedParts).toEqual([]);
    expect(visitVerdict(v, S)).toBe('too_short');
  });
  it('matching is case-insensitive over the keyword list', () => {
    const u = field(10, 20, { parts: [{ partNumber: null, description: 'Black DRUM Unit', quantity: 1 }] });
    expect(visitVerdict(groupVisits([u], S, NOW)[0]!, S)).toBe('counted_parts');
    expect(visitVerdict(groupVisits([u], { ...S, pmPartKeywords: [] }, NOW)[0]!, { ...S, pmPartKeywords: [] })).toBe('too_short');
  });
});

describe('visits', () => {
  it('a PM unit logged in the past but never started or completed is not a visit', () => {
    const pm = unit({ categoryId: 99, categoryType: 'Office', start: null, logged: daysAgo(10), scheduled: daysAgo(5) });
    expect(groupVisits([pm], S, NOW)).toHaveLength(0);
    const r = run([pm], [pt(40, 1000), pt(0, 9000)]);
    expect(r.lastQualifying).toBeNull();
    expect(r.visits).toHaveLength(0);
    expect(r.status).toBe('overdue');
  });

  it('two 30-min units same day make one 60-min counted visit', () => {
    const base = new Date('2026-06-10T09:00:00Z');
    const a = unit({ start: base, hours: 0.5 });
    const b = unit({ start: new Date(base.getTime() + 3600_000), hours: 0.5 });
    const visits = groupVisits([a, b], S, NOW);
    expect(visits).toHaveLength(1);
    expect(visits[0]!.minutes).toBe(60);
    expect(visitVerdict(visits[0]!, S)).toBe('counted');
  });

  it('UK day grouping puts 23:30Z on 31 Mar into 1 Apr', () => {
    const v = groupVisits([unit({ start: new Date('2026-03-31T23:30:00Z'), hours: 1 })], S, NOW);
    expect(v[0]!.day).toBe('2026-04-01');
  });

  it('PM-category visit of 10 min resets the clock (counted_pm)', () => {
    const pm = field(60, 10, { categoryId: 99, categoryName: 'Planned maintenance', categoryType: 'Planned maintenance' });
    const visits = groupVisits([pm], S, NOW);
    expect(visitVerdict(visits[0]!, S)).toBe('counted_pm');
    const r = run([pm], [pt(60, 1000), pt(0, 51_000)]);
    expect(r.lastQualifying?.isPm).toBe(true);
    expect(r.pagesSince).toBe(50_000);
    expect(r.status).toBe('ok');
  });

  it('PM-category visit with non-Field type resets the clock (counted_pm)', () => {
    const pm = field(60, 10, { categoryId: 99, categoryType: 'Planned maintenance' });
    const v = groupVisits([pm], S, NOW)[0]!;
    expect(v.isField).toBe(false);
    expect(visitVerdict(v, S)).toBe('counted_pm');
  });

  it('40-min field visit is too_short and does not reset', () => {
    const short = field(30, 40);
    expect(visitVerdict(groupVisits([short], S, NOW)[0]!, S)).toBe('too_short');
    const good = field(200, 60);
    const r = run([short, good], [pt(200, 0), pt(0, 60_000)]);
    expect(r.lastQualifying?.at.getTime()).toBe(good.start!.getTime());
    expect(r.pagesSince).toBe(60_000);
  });

  it('booking visit is not_field', () => {
    const b = field(5, 60, { categoryType: 'Booking' });
    expect(visitVerdict(groupVisits([b], S, NOW)[0]!, S)).toBe('not_field');
  });

  it('future units are not visits', () => {
    const f = unit({ start: null, scheduled: new Date(NOW.getTime() + 5 * DAY) });
    expect(groupVisits([f], S, NOW)).toHaveLength(0);
  });
});

describe('status', () => {
  const visit = field(150, 60);
  it('100k pages since counted visit -> overdue', () => {
    const r = run([visit], [pt(150, 0), pt(0, 100_000)]);
    expect(r.status).toBe('overdue');
    expect(r.reason).toBe('pages');
    expect(r.pctUsed).toBe(1);
  });
  it('86k -> due_soon', () => {
    const r = run([visit], [pt(150, 0), pt(0, 86_000)]);
    expect(r.status).toBe('due_soon');
    expect(r.pctUsed).toBeCloseTo(0.86);
  });
  it('50k -> ok', () => {
    const r = run([visit], [pt(150, 0), pt(0, 50_000)]);
    expect(r.status).toBe('ok');
  });
  it('meter down after visit -> unknown meter_reset', () => {
    const r = run([visit], [pt(150, 90_000), pt(0, 1_000)]);
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('meter_reset');
    expect(r.pagesSince).toBeNull();
  });
  it('stale meter (>30d) -> unknown no_meter', () => {
    const r = run([visit], [pt(150, 0), pt(40, 50_000)]);
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('no_meter');
  });
  it('no meters, visit 13 months ago -> overdue by time', () => {
    const r = run([field(400, 60)], []);
    expect(r.status).toBe('overdue');
    expect(r.reason).toBe('time_cap');
    expect(r.timeCapDate).not.toBeNull();
  });
  it('no meters, recent visit -> unknown no_meter', () => {
    const r = run([visit], []);
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('no_meter');
  });
  it('no visits in window -> overdue reason no_visit_12m with lower-bound pages', () => {
    const r = run([], [pt(300, 1000), pt(0, 41_000)]);
    expect(r.status).toBe('overdue');
    expect(r.reason).toBe('no_visit_12m');
    expect(r.pagesSince).toBe(40_000);
    expect(r.pagesSinceIsLowerBound).toBe(true);
    expect(r.timeCapDate).toBeNull();
  });
  it('3 short field visits in 20 days, last 5 days ago -> held, holdUntil = last+30d', () => {
    const units = [field(25, 20), field(15, 20), field(5, 20)];
    const r = run(units, [pt(300, 0), pt(0, 95_000)]);
    expect(r.status).toBe('held');
    expect(r.frequentVisits).toBe(3);
    expect(r.holdUntil?.getTime()).toBe(units[2]!.start!.getTime() + 30 * DAY);
  });
  it('future PM-category unit not completed -> booked with date', () => {
    const when = new Date(NOW.getTime() + 6 * DAY);
    const u = unit({ start: null, categoryId: 99, scheduled: when });
    const r = run([u, visit], [pt(150, 0), pt(0, 120_000)]);
    expect(r.status).toBe('booked');
    expect(r.bookedFor?.getTime()).toBe(when.getTime());
  });
  it('est due date from 90-day rate within 30 days -> due_soon', () => {
    const r = run([visit], [pt(150, 0), pt(90, 10_000), pt(0, 80_000)]);
    expect(r.pctUsed).toBeCloseTo(0.8);
    expect(r.pagesPerDay).toBeCloseTo(70_000 / 90, 3);
    expect(r.estDueDate).not.toBeNull();
    expect(r.status).toBe('due_soon');
  });
  it('lists all past visits newest first with verdicts', () => {
    const r = run([field(200, 60), field(10, 30)], [pt(200, 0), pt(0, 1000)]);
    expect(r.visits.map((x) => x.verdict)).toEqual(['too_short', 'counted']);
  });

  it('Booking unit time does not count towards the Field length', () => {
    const start = daysAgo(20);
    const book = unit({ start, hours: 40 / 60, categoryType: 'Booking' });
    const fld = unit({ start: new Date(start.getTime() + 3600_000), hours: 20 / 60 });
    const v = groupVisits([book, fld], S, NOW)[0]!;
    expect(v.minutes).toBe(20);
    expect(visitVerdict(v, S)).toBe('too_short');
  });
  it('unknown Field length with known total under 45 is unknown_length; known >= 45 counts', () => {
    const start = daysAgo(20);
    const known = unit({ start, hours: 0.5 });
    const unk = unit({ start: new Date(start.getTime() + 1000) });
    expect(visitVerdict(groupVisits([known, unk], S, NOW)[0]!, S)).toBe('unknown_length');
    const big = unit({ start, hours: 1 });
    expect(visitVerdict(groupVisits([big, unk], S, NOW)[0]!, S)).toBe('counted');
  });
  it('visit 5 days ago with a single meter point 3 days ago -> unknown no_meter', () => {
    const r = run([field(5, 60)], [pt(3, 50_000)]);
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('no_meter');
    expect(r.pagesSince).toBeNull();
  });
  it('no visit and no usable meter -> overdue no_visit_12m with null pages', () => {
    const r = run([], []);
    expect(r.status).toBe('overdue');
    expect(r.reason).toBe('no_visit_12m');
    expect(r.pagesSince).toBeNull();
  });
  it('rate ignores reference points older than 120 days', () => {
    const r = run([field(350, 60)], [pt(300, 0), pt(0, 60_000)]);
    expect(r.pagesPerDay).toBeNull();
    const r2 = run([field(350, 60)], [pt(300, 0), pt(100, 30_000), pt(0, 60_000)]);
    expect(r2.pagesPerDay).toBeCloseTo(300, 3);
  });
  it('booked is ignored when completed or scheduled in the past', () => {
    const future = new Date(NOW.getTime() + 6 * DAY);
    const done = unit({ start: null, categoryId: 99, scheduled: future, completed: daysAgo(1) });
    const past = unit({ start: null, categoryId: 99, scheduled: daysAgo(3) });
    const r = run([done, past, field(150, 60)], [pt(150, 0), pt(0, 50_000)]);
    expect(r.status).toBe('ok');
    expect(r.bookedFor).toBeNull();
  });
  it('held outranks overdue; falls through once now >= holdUntil', () => {
    const held = [field(25, 20), field(15, 20), field(5, 20)];
    const meter = [pt(300, 0), pt(0, 150_000)];
    expect(run([...held, field(100, 60)], meter).status).toBe('held');
    const old = [field(65, 20), field(55, 20), field(45, 20), field(100, 60)];
    expect(run(old, meter).status).toBe('overdue');
  });
});

describe('install date and manual reset', () => {
  it('installed 3 months ago, no visits, no readings -> unknown no_meter', () => {
    const r = run([], [], S, { installedAt: daysAgo(90) });
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('no_meter');
    expect(r.clockSource).toBe('install');
  });
  it('installed 13 months ago, no visits -> overdue time_cap', () => {
    const r = run([], [], S, { installedAt: daysAgo(400) });
    expect(r.status).toBe('overdue');
    expect(r.reason).toBe('time_cap');
  });
  it('install later than last visit starts the clock (clockSource install)', () => {
    const r = run([field(300, 60)], [pt(100, 1000), pt(1, 21_000)], S, { installedAt: daysAgo(120) });
    expect(r.clockSource).toBe('install');
    expect(r.clockStart?.getTime()).toBe(daysAgo(120).getTime());
    expect(r.pagesSince).toBe(20_000);
  });
  it('first reading 20 days after install is used as base, not a lower bound', () => {
    const r = run([], [pt(180, 1000), pt(1, 21_000)], S, { installedAt: daysAgo(200) });
    expect(r.pagesSince).toBe(20_000);
    expect(r.pagesSinceIsLowerBound).toBe(false);
  });
  it('first reading 45 days after install makes pages a lower bound', () => {
    const r = run([], [pt(155, 1000), pt(1, 21_000)], S, { installedAt: daysAgo(200) });
    expect(r.pagesSince).toBe(20_000);
    expect(r.pagesSinceIsLowerBound).toBe(true);
  });
  it('manualResetAt after last visit resets pages and time cap (clockSource manual)', () => {
    const r = run([field(400, 60)], [pt(300, 0), pt(100, 1000), pt(1, 11_000)], S, { manualResetAt: daysAgo(100) });
    expect(r.clockSource).toBe('manual');
    expect(r.pagesSince).toBe(10_000);
    expect(r.timeCapDate!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(r.status).toBe('ok');
  });
  it('manual reset date with no reading near it and only one later reading -> unknown no_meter', () => {
    const r = run([], [pt(2, 5000)], S, { manualResetAt: daysAgo(100) });
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('no_meter');
  });
  it('future installedAt -> unknown no_meter, not overdue', () => {
    const r = run([], [], S, { installedAt: new Date(NOW.getTime() + 10 * DAY) });
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('no_meter');
  });
  it('install older than last visit -> clockSource visit', () => {
    expect(run([field(30, 60)], [], S, { installedAt: daysAgo(200) }).clockSource).toBe('visit');
  });
  it('manualResetAt older than last visit -> clockSource visit', () => {
    expect(run([field(30, 60)], [], S, { manualResetAt: daysAgo(100) }).clockSource).toBe('visit');
  });
});

describe('3 years of visit history', () => {
  it('clock older than the first meter point -> pages since = latest - earliest, a lower bound', () => {
    // Last counted visit ~20 months ago, meters only cover the last 12 months.
    const r = run([field(600, 60)], [pt(365, 1000), pt(200, 30_000), pt(0, 61_000)]);
    expect(r.status).toBe('overdue');
    expect(r.reason).toBe('time_cap');
    expect(r.pagesSince).toBe(60_000);
    expect(r.pagesSinceIsLowerBound).toBe(true);
  });
  it('still no_meter when the latest reading is the only point after the clock starts', () => {
    const r = run([field(600, 60)], [pt(0, 61_000)]);
    expect(r.pagesSince).toBeNull();
  });
});

describe('meter per visit', () => {
  it('gives each visit its combined meter and pages since the next older visit', () => {
    const r = run([field(100, 60), field(50, 60), field(10, 60)], [pt(120, 1000), pt(100, 2000), pt(50, 5000), pt(10, 9000), pt(0, 9500)]);
    expect(r.visits.map((x) => x.meter)).toEqual([9000, 5000, 2000]);
    expect(r.visits.map((x) => x.pagesSincePrev)).toEqual([4000, 3000, null]);
  });
  it('is null when a meter is missing or the meter went down', () => {
    const r = run([field(300, 60), field(50, 60), field(10, 60)], [pt(50, 8000), pt(10, 3000), pt(0, 3500)]);
    expect(r.visits.map((x) => x.meter)).toEqual([3000, 8000, null]);
    expect(r.visits.map((x) => x.pagesSincePrev)).toEqual([null, null, null]);
  });
});

describe('visit display length', () => {
  it('sums every unit, not only Field, while the rules still use Field minutes', () => {
    const start = daysAgo(20);
    const rtf = unit({ start, hours: 1, categoryType: 'Office', categoryName: 'Return to Fit' });
    const v = groupVisits([rtf], S, NOW)[0]!;
    expect(v.displayMinutes).toBe(60);
    expect(v.minutes).toBeNull();
    expect(visitVerdict(v, S)).toBe('not_field');
  });
  it('adds Field and other units, and is null when no unit has a length', () => {
    const start = daysAgo(20);
    const a = unit({ start, hours: 0.5 });
    const b = unit({ start: new Date(start.getTime() + 1000), hours: 0.25, categoryType: 'Booking' });
    expect(groupVisits([a, b], S, NOW)[0]!.displayMinutes).toBe(45);
    expect(groupVisits([unit({ start })], S, NOW)[0]!.displayMinutes).toBeNull();
  });
});
