import { describe, expect, it } from 'vitest';
import type { PmSuggestion, UpcomingCall, UpcomingEngineer } from '@mps/db/queries';
import {
  askNote,
  callTimeText,
  diaryNeedsRefresh,
  groupCallSuggestions,
  suggestionDistanceText,
  upcomingView,
} from './planner-upcoming';

describe('callTimeText', () => {
  it('shows the London time: BST in summer, GMT in winter', () => {
    expect(callTimeText(new Date('2026-03-31T22:30:00Z'))).toBe('23:30');
    expect(callTimeText(new Date('2026-12-01T09:00:00Z'))).toBe('09:00');
    expect(callTimeText(new Date('2026-07-01T07:05:00Z'))).toBe('08:05');
  });
});

describe('suggestionDistanceText', () => {
  it('prefers same site, then the distance, then same district', () => {
    expect(suggestionDistanceText({ sameSite: true, sameDistrict: true, distanceMiles: 0 })).toBe('Same site');
    expect(suggestionDistanceText({ sameSite: false, sameDistrict: false, distanceMiles: 6.43 })).toBe('6.4 mi');
    expect(suggestionDistanceText({ sameSite: false, sameDistrict: true, distanceMiles: 2 })).toBe('2.0 mi');
    expect(suggestionDistanceText({ sameSite: false, sameDistrict: true, distanceMiles: null })).toBe('Same district');
    expect(suggestionDistanceText({ sameSite: false, sameDistrict: false, distanceMiles: null })).toBe('');
  });
});

describe('askNote', () => {
  it('names the engineer and the London day of the call', () => {
    expect(askNote('Dave', new Date('2026-11-24T08:00:00Z'))).toBe('Asked Dave for 24 Nov');
    // 23:30Z on 31 Mar is 1 Apr in London.
    expect(askNote('Sam Jones', new Date('2026-03-31T23:30:00Z'))).toBe('Asked Sam Jones for 1 Apr');
  });
});

describe('diaryNeedsRefresh', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const run = (job: string, status: string, finishedAt: string | null, startedAt = finishedAt ?? '2026-11-24T09:59:00Z') => ({
    job,
    status,
    startedAt: new Date(startedAt),
    finishedAt: finishedAt === null ? null : new Date(finishedAt),
  });

  it('is true when vantage-schedule never ran or last refreshed over 2 hours ago', () => {
    expect(diaryNeedsRefresh([], now)).toBe(true);
    expect(diaryNeedsRefresh([run('vantage-work', 'success', '2026-11-24T09:50:00Z')], now)).toBe(true);
    expect(diaryNeedsRefresh([run('vantage-schedule', 'success', '2026-11-24T07:59:00Z')], now)).toBe(true);
  });

  it('is false when the last good run finished within 2 hours', () => {
    expect(diaryNeedsRefresh([run('vantage-schedule', 'success', '2026-11-24T08:01:00Z')], now)).toBe(false);
    expect(diaryNeedsRefresh([run('vantage-schedule', 'partial', '2026-11-24T09:30:00Z')], now)).toBe(false);
  });

  it('ignores failed and still-running runs', () => {
    expect(
      diaryNeedsRefresh(
        [run('vantage-schedule', 'failed', '2026-11-24T09:30:00Z'), run('vantage-schedule', 'running', null), run('vantage-schedule', 'success', '2026-11-24T06:00:00Z')],
        now,
      ),
    ).toBe(true);
  });
});

const suggestion = (over: Partial<PmSuggestion> = {}): PmSuggestion => ({
  vantageEquipmentId: 1,
  customerName: 'Acme',
  serial: 'A1',
  model: 'C300i',
  status: 'overdue',
  overdueMonths: 3,
  priority: false,
  whenInArea: false,
  distanceMiles: 1.2,
  sameDistrict: true,
  sameSite: false,
  boardColumn: null,
  ...over,
});

const call = (over: Partial<UpcomingCall> = {}): UpcomingCall => ({
  workUnitId: 10,
  reference: 'W100',
  start: new Date('2026-11-24T09:30:00Z'),
  customerId: 5,
  customerName: 'Bravo Ltd',
  district: 'GU14',
  categoryName: 'Breakdown',
  equipment: 'C250i (SN1)',
  started: false,
  located: 'customer',
  at: { lat: 51.29, lng: -0.75 },
  suggestions: [],
  ...over,
});

const engineer = (calls: UpcomingCall[], over: Partial<UpcomingEngineer> = {}): UpcomingEngineer => ({
  engineerId: 3,
  name: 'Dave',
  days: [
    { which: 'today', date: '2026-11-24', calls },
    { which: 'tomorrow', date: '2026-11-25', calls: [] },
  ],
  ...over,
});

describe('groupCallSuggestions', () => {
  it("splits the call's own site from the machines nearby, keeping order", () => {
    const g = groupCallSuggestions(
      call({
        suggestions: [
          suggestion({ vantageEquipmentId: 1 }),
          suggestion({ vantageEquipmentId: 2, sameSite: true }),
          suggestion({ vantageEquipmentId: 3 }),
          suggestion({ vantageEquipmentId: 4, sameSite: true }),
        ],
      }),
    );
    expect(g.site.map((s) => s.vantageEquipmentId)).toEqual([2, 4]);
    expect(g.others.map((s) => s.vantageEquipmentId)).toEqual([1, 3]);
  });

  it('puts everything in the site group when all are at the same site', () => {
    const g = groupCallSuggestions(call({ suggestions: [suggestion({ sameSite: true }), suggestion({ vantageEquipmentId: 2, sameSite: true })] }));
    expect(g.site).toHaveLength(2);
    expect(g.others).toEqual([]);
  });

  it('returns two empty groups when there are no suggestions', () => {
    expect(groupCallSuggestions(call())).toEqual({ site: [], others: [] });
  });
});

describe('upcomingView', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const fresh = [{ job: 'vantage-schedule', status: 'success', startedAt: now, finishedAt: now }];

  it('says the diary has not refreshed when there are no calls and no recent run', () => {
    const v = upcomingView({ engineers: [] }, [], now);
    expect(v.empty).toBe("Engineers' diary hasn't refreshed yet");
    expect(v.engineers).toEqual([]);
  });

  it('says no booked calls when the diary is fresh but empty', () => {
    expect(upcomingView({ engineers: [] }, fresh, now).empty).toBe('No booked calls today or tomorrow');
  });

  it('builds days, calls and compact suggestion lines', () => {
    const v = upcomingView(
      {
        engineers: [
          engineer([
            call({
              started: true,
              suggestions: [
                suggestion({ vantageEquipmentId: 1, boardColumn: 'to_plan', priority: true, model: 'Konica Minolta C300i Digital Colour Photocopier' }),
                suggestion({ vantageEquipmentId: 2, distanceMiles: null, sameDistrict: true, whenInArea: true, overdueMonths: 18, boardColumn: 'done' }),
                suggestion({ vantageEquipmentId: 3, sameSite: true, status: 'due_soon', overdueMonths: null, boardColumn: 'asked', customerName: 'Bravo Ltd' }),
                suggestion({ vantageEquipmentId: 4, sameSite: true, distanceMiles: 0, customerName: 'Bravo Ltd' }),
              ],
            }),
            call({ workUnitId: 11, customerId: null, customerName: null, district: null, located: null, equipment: null, categoryName: 'Site visit' }),
            call({ workUnitId: 12, located: null, district: 'GU14' }),
          ]),
        ],
        today: '2026-11-24',
        tomorrow: '2026-11-25',
      },
      fresh,
      now,
    );
    expect(v.empty).toBeNull();
    expect(v.dayLabels).toEqual({ today: 'Today 24 Nov', tomorrow: 'Tomorrow 25 Nov' });
    const [eng] = v.engineers;
    expect(eng!.name).toBe('Dave');
    expect(eng!.canAsk).toBe(true);
    expect(eng!.days.map((d) => d.heading)).toEqual(['Today 24 Nov', 'Tomorrow 25 Nov']);
    expect(eng!.days[1]!.emptyText).toBe('No booked calls tomorrow');
    const [c1, c2, c3] = eng!.days[0]!.calls;
    expect(c1).toMatchObject({ anchor: 'call-10', time: '09:30', customer: 'Bravo Ltd', started: true, locationNote: null, nearby: 4 });
    expect(c1!.summary).toBe('09:30 Bravo Ltd · 4 nearby');
    expect(c1!.siteText).toBe('Bravo Ltd — 2 machines here');
    expect(c1!.site.map((s) => s.id)).toEqual([3, 4]);
    expect(c1!.others.map((s) => [s.id, s.line, s.onBoard, s.canAdd, s.canAsk])).toEqual([
      [1, 'Acme · C300i · overdue 3m · 1.2 mi', 'Planned', false, true],
      [2, 'Acme · C300i · overdue 18m · same district', null, true, true],
    ]);
    expect(c1!.site.map((s) => [s.id, s.line, s.onBoard, s.canAdd])).toEqual([
      [3, 'Bravo Ltd · C300i · due soon · same site', 'Planned', false],
      [4, 'Bravo Ltd · C300i · overdue 3m · same site', null, true],
    ]);
    expect(c1!.others[0]!.machine).toBe('Konica Minolta C300i Digital Colour Photocopier · A1');
    expect(c1!.others[0]!.priority).toBe(true);
    expect(c1!.others[0]!.serial).toBe('A1');
    expect(c2).toMatchObject({ customer: 'Unknown customer', customerLink: null, locationNote: 'No location for this call', category: 'Site visit', equipment: null });
    expect(c2!.summary).toBe('09:30 Unknown customer · none nearby');
    expect(c2!.siteText).toBeNull();
    expect(c3!.locationNote).toBe('No map location — matching on GU14 only');
  });

  it('says one machine here, singular', () => {
    const v = upcomingView({ engineers: [engineer([call({ suggestions: [suggestion({ sameSite: true })] })])] }, fresh, now);
    expect(v.engineers[0]!.days[0]!.calls[0]!.siteText).toBe('Bravo Ltd — 1 machine here');
  });

  it('cannot ask an unassigned engineer, and a booked suggestion shows its column instead of actions', () => {
    const v = upcomingView(
      {
        engineers: [
          engineer([call({ suggestions: [suggestion({ boardColumn: 'booked' }), suggestion({ vantageEquipmentId: 2 })] })], {
            engineerId: null,
            name: 'Unassigned',
          }),
        ],
      },
      fresh,
      now,
    );
    expect(v.engineers[0]!.canAsk).toBe(false);
    const [booked, free] = v.engineers[0]!.days[0]!.calls[0]!.others;
    expect(booked).toMatchObject({ canAsk: false, canAdd: false, onBoard: 'Booked' });
    expect(free).toMatchObject({ canAsk: false, canAdd: true, onBoard: null });
  });

  it('keeps Ask for a Planned (or Asked) machine, which cannot be added again; Booked cannot be asked', () => {
    const v = upcomingView(
      {
        engineers: [
          engineer([
            call({
              suggestions: [
                suggestion({ vantageEquipmentId: 1, boardColumn: 'to_plan' }),
                suggestion({ vantageEquipmentId: 2, boardColumn: 'asked' }),
                suggestion({ vantageEquipmentId: 3, boardColumn: 'booked' }),
              ],
            }),
          ]),
        ],
      },
      fresh,
      now,
    );
    const [planned, asked, booked] = v.engineers[0]!.days[0]!.calls[0]!.others;
    expect(planned).toMatchObject({ onBoard: 'Planned', canAdd: false, canAsk: true });
    expect(asked).toMatchObject({ onBoard: 'Planned', canAdd: false, canAsk: true });
    expect(booked).toMatchObject({ onBoard: 'Booked', canAdd: false, canAsk: false });
  });
});
