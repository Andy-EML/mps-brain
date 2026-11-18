import { describe, expect, it } from 'vitest';
import { DEFAULT_SNOOZE_DAYS, SNOOZE_DAYS, type PmAction, type PmResult, type Visit } from '@mps/db/queries';
import { DEFAULT_SNOOZE_OPTION, SNOOZE_OPTIONS, actionText, clockSourceText, dismissReasonLabel, frequentText, lastVisitText, overdueKind, pagesText, pctText, reasonText, statusLabel, statusTone, verdictText, visitActionText, visitCategories, visitLengthText, visitMeterText } from './pm-status';

const visit = (over: Partial<Visit> = {}): Visit => ({
  day: '2026-10-02',
  at: new Date('2026-10-02T09:30:00Z'),
  minutes: 75,
  displayMinutes: 75,
  isField: true,
  isPm: false,
  matchedParts: [],
  matchedKeywords: [],
  units: [
    {
      workUnitId: 1,
      workId: 10,
      reference: 'W123456',
      categoryId: 4,
      categoryName: 'Service',
      categoryType: 'Field',
      start: new Date('2026-10-02T09:30:00Z'),
      end: null,
      logged: null,
      hours: 1.25,
      scheduled: null,
      completed: null,
      actionDetails: 'Replaced fuser unit',
      parts: [],
    },
  ],
  ...over,
});

const result = (over: Partial<PmResult> = {}): PmResult => ({
  status: 'ok',
  reason: null,
  lastQualifying: null,
  pagesSince: null,
  pagesSinceIsLowerBound: false,
  pctUsed: null,
  pagesPerDay: null,
  estDueDate: null,
  timeCapDate: null,
  clockStart: null,
  clockSource: null,
  bookedFor: null,
  frequentVisits: 0,
  holdUntil: null,
  visits: [],
  ...over,
});

describe('statusLabel', () => {
  it('names every status', () => {
    expect(statusLabel('overdue')).toBe('Overdue');
    expect(statusLabel('due_soon')).toBe('Due soon');
    expect(statusLabel('ok')).toBe('OK');
    expect(statusLabel('held')).toBe('Held off — frequent calls');
    expect(statusLabel('booked')).toBe('PM booked');
    expect(statusLabel('unknown')).toBe('Unknown');
  });

  it('gives overdue the critical tone and due soon the warning tone', () => {
    expect(statusTone('overdue')).toBe('critical');
    expect(statusTone('due_soon')).toBe('warn');
    expect(statusTone('ok')).toBe('ok');
    expect(statusTone('unknown')).toBe('muted');
  });
});

describe('pagesText', () => {
  it('formats a known count', () => {
    expect(pagesText(12345, false)).toBe('12,345');
  });

  it('says "at least" for a lower bound', () => {
    expect(pagesText(12345, true)).toBe('at least 12,345');
  });

  it('says why when there is no count', () => {
    expect(pagesText(null, false)).toBe('Not enough meter history');
  });
});

describe('pctText', () => {
  it('shows a fraction as a whole percent, and a dash when unknown', () => {
    expect(pctText(0.864)).toBe('86%');
    expect(pctText(1.5)).toBe('150%');
    expect(pctText(null)).toBe('—');
  });
});

describe('reasonText', () => {
  it('explains overdue by pages and by time', () => {
    expect(reasonText('pages')).toBe('Over interval');
    expect(reasonText('time_cap')).toBe('12 months since last visit');
    expect(reasonText('time_cap', 18)).toBe('18 months since last visit');
    expect(reasonText('time_cap', 12, 'install')).toBe('12 months since install');
    expect(reasonText('time_cap', 12, 'manual')).toBe('12 months since serviced outside Vantage');
    expect(reasonText('no_visit_12m')).toBe('No visit on record');
  });

  it('explains unknown meter history', () => {
    expect(reasonText('meter_reset')).toBe('Meter reset since last visit');
    expect(reasonText('no_meter')).toBe('Not enough meter history');
  });

  it('has nothing to say without a reason', () => {
    expect(reasonText(null)).toBeNull();
    expect(reasonText('something_new')).toBeNull();
  });
});

describe('overdueKind', () => {
  it('splits overdue reasons into pages and time', () => {
    expect(overdueKind('pages')).toBe('pages');
    expect(overdueKind('time_cap')).toBe('time');
    expect(overdueKind('no_visit_12m')).toBe('time');
    expect(overdueKind('no_meter')).toBeNull();
    expect(overdueKind(null)).toBeNull();
  });
});

describe('lastVisitText', () => {
  it('gives date, minutes and reference', () => {
    expect(lastVisitText(visit())).toEqual({ date: '2 Oct 2026', detail: '75 min · W123456' });
  });

  it('leaves out an unknown length and reference', () => {
    expect(lastVisitText(visit({ minutes: null, units: [] }))).toEqual({ date: '2 Oct 2026', detail: null });
  });

  it('lists every distinct reference on the day', () => {
    const v = visit();
    const second = { ...v.units[0]!, workUnitId: 2, reference: 'W999' };
    const dup = { ...v.units[0]!, workUnitId: 3 };
    expect(lastVisitText(visit({ units: [v.units[0]!, second, dup] })).detail).toBe('75 min · W123456, W999');
  });

  it('says when there is no qualifying visit', () => {
    expect(lastVisitText(null)).toEqual({ date: 'None on record', detail: null });
  });
});

describe('frequentText', () => {
  it('gives the visit count and when the hold lifts', () => {
    expect(frequentText(result({ status: 'held', frequentVisits: 4, holdUntil: new Date('2026-12-12T10:00:00Z') }))).toBe(
      'Frequent calls · 4 visits · hold lifts 12 Dec 2026',
    );
  });

  it('is null when the machine is not held', () => {
    expect(frequentText(result({ frequentVisits: 1 }))).toBeNull();
    // A hold that has already lifted (status no longer held) is not shown.
    expect(frequentText(result({ status: 'overdue', frequentVisits: 3, holdUntil: new Date('2026-10-01T00:00:00Z') }))).toBeNull();
  });
});

describe('verdictText', () => {
  it('says how each visit was judged', () => {
    expect(verdictText('counted')).toBe('Counted');
    expect(verdictText('counted_pm')).toBe('Counted (PM visit)');
    expect(verdictText('not_field')).toBe('Not a field visit');
    expect(verdictText('unknown_length')).toBe('Length unknown');
  });

  it('says which parts reset the clock, shortened to the keyword', () => {
    expect(verdictText('counted_parts', 45, ['fuser', 'transfer belt', 'transfer roller'])).toBe('Counted (parts: Fuser, Transfer belt, Transfer roller)');
    expect(verdictText('counted_parts')).toBe('Counted (parts)');
  });

  it('names the qualifying length from settings', () => {
    expect(verdictText('too_short')).toBe('Too short (<45 min)');
    expect(verdictText('too_short', 60)).toBe('Too short (<60 min)');
  });
});

describe('visitLengthText', () => {
  it('gives minutes, "PM visit" for a PM-only day, else a dash', () => {
    expect(visitLengthText(visit({ displayMinutes: 74.6 }))).toBe('75 min');
    expect(visitLengthText(visit({ displayMinutes: null, isPm: true }))).toBe('PM visit');
    expect(visitLengthText(visit({ displayMinutes: null }))).toBe('—');
  });

  it('shows the length of a non-Field visit too (Field minutes stay null)', () => {
    expect(visitLengthText(visit({ minutes: null, displayMinutes: 60, isField: false }))).toBe('60 min');
  });
});

describe('visitMeterText', () => {
  it('gives the total with separators and the pages since the previous visit', () => {
    expect(visitMeterText({ meter: 123456, pagesSincePrev: 4000 })).toEqual({ total: '123,456', since: '+4,000 since previous' });
    expect(visitMeterText({ meter: 123456, pagesSincePrev: null })).toEqual({ total: '123,456', since: null });
  });
  it('is an em dash with no meter', () => {
    expect(visitMeterText({ meter: null, pagesSincePrev: null })).toEqual({ total: '—', since: null });
  });
});

describe('visitCategories', () => {
  it('lists distinct category names in order', () => {
    const v = visit();
    const pm = { ...v.units[0]!, workUnitId: 2, categoryName: 'PM' };
    const none = { ...v.units[0]!, workUnitId: 3, categoryName: null };
    expect(visitCategories(visit({ units: [v.units[0]!, pm, v.units[0]!, none] }))).toEqual(['Service', 'PM']);
  });
});

describe('visitActionText', () => {
  it("joins the units' distinct action text, trimmed, skipping blanks", () => {
    const v = visit();
    const second = { ...v.units[0]!, workUnitId: 2, actionDetails: '  Cleaned rollers\n' };
    const blank = { ...v.units[0]!, workUnitId: 3, actionDetails: '   ' };
    const dup = { ...v.units[0]!, workUnitId: 4 };
    expect(visitActionText(visit({ units: [v.units[0]!, second, blank, dup] }))).toBe('Replaced fuser unit · Cleaned rollers');
  });

  it('is null when no unit has action text', () => {
    const v = visit();
    expect(visitActionText(visit({ units: [{ ...v.units[0]!, actionDetails: null }] }))).toBeNull();
  });
});

const action = (over: Partial<PmAction> = {}): PmAction => ({
  id: 1,
  vantageEquipmentId: 42,
  kind: 'booked',
  bookedFor: null,
  reference: null,
  reason: null,
  note: null,
  snoozeUntil: null,
  servicedOn: null,
  createdBy: 3,
  createdByName: 'Andy',
  createdAt: new Date('2026-11-18T10:00:00Z'),
  ...over,
});

describe('actionText', () => {
  it('describes a booking with its date, who and the reference', () => {
    expect(actionText(action({ bookedFor: new Date('2026-12-03T00:00:00Z'), reference: 'W123' }))).toBe(
      'Booked for 3 Dec 2026 by Andy (ref W123)',
    );
    expect(actionText(action())).toBe('Booked by Andy');
    expect(actionText(action({ createdByName: null }))).toBe('Booked');
  });

  it('describes a snooze with its end date and reason', () => {
    expect(
      actionText(action({ kind: 'dismissed', reason: 'declined', snoozeUntil: new Date('2027-02-16T00:00:00Z') })),
    ).toBe('Snoozed until 16 Feb 2027 — Customer declined');
    expect(
      actionText(action({ kind: 'dismissed', reason: 'other', note: 'Lease ending', snoozeUntil: new Date('2027-02-16T00:00:00Z') })),
    ).toBe('Snoozed until 16 Feb 2027 — Other: Lease ending');
  });

  it('describes a service outside Vantage by its date', () => {
    expect(
      actionText(action({ kind: 'dismissed', reason: 'serviced_outside', servicedOn: new Date('2026-11-18T00:00:00Z') })),
    ).toBe('Serviced outside Vantage on 18 Nov 2026');
  });
});

describe('dismissReasonLabel', () => {
  it('names every reason', () => {
    expect(dismissReasonLabel('not_now')).toBe('Not now');
    expect(dismissReasonLabel('declined')).toBe('Customer declined');
    expect(dismissReasonLabel('serviced_outside')).toBe('Serviced outside Vantage');
    expect(dismissReasonLabel('other')).toBe('Other');
  });
});

describe('clockSourceText', () => {
  it('says where the PM clock started', () => {
    expect(clockSourceText('install')).toBe('since install');
    expect(clockSourceText('visit')).toBe('since last visit');
    expect(clockSourceText('manual')).toBe('since serviced outside Vantage');
    expect(clockSourceText(null)).toBeNull();
  });
});

describe('SNOOZE_OPTIONS', () => {
  it('matches the snooze lengths @mps/db accepts', () => {
    expect([...SNOOZE_OPTIONS]).toEqual([...SNOOZE_DAYS]);
    expect(DEFAULT_SNOOZE_OPTION).toBe(DEFAULT_SNOOZE_DAYS);
  });
});
