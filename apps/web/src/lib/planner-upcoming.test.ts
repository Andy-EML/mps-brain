import { describe, expect, it } from 'vitest';
import { SettingsError, type PmSuggestion, type UpcomingCall, type UpcomingEngineer } from '@mps/db/queries';
import {
  askNote,
  callTimeText,
  diaryNeedsRefresh,
  parseAskForm,
  parseSuggestionForm,
  suggestionDistanceText,
  upcomingAnchor,
  upcomingView,
  withAnchor,
} from './planner-upcoming';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SettingsError);
    expect((err as SettingsError).code).toBe('invalid_pm_action');
    return;
  }
  throw new Error('expected a SettingsError');
};

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

describe('parseAskForm', () => {
  it('reads the machine and the call (work unit) id; the engineer and day come from the call on the server', () => {
    expect(parseAskForm(form({ vantageEquipmentId: ' 42 ', call: ' 10 ', engineerName: 'Mallory', callStart: 'x' }))).toEqual({
      vantageEquipmentId: 42,
      workUnitId: 10,
    });
  });

  it('refuses a missing or bad call id', () => {
    refused(() => parseAskForm(form({ vantageEquipmentId: '42' })));
    for (const call of ['', '0', '-1', '1.5', 'x', '12345678901']) refused(() => parseAskForm(form({ vantageEquipmentId: '42', call })));
  });

  it('refuses a bad machine id', () => {
    refused(() => parseAskForm(form({ vantageEquipmentId: '', call: '10' })));
    refused(() => parseAskForm(form({ vantageEquipmentId: '0', call: '10' })));
    refused(() => parseAskForm(form({ vantageEquipmentId: 'x1', call: '10' })));
  });
});

describe('parseSuggestionForm', () => {
  it('reads the machine id and refuses a bad one', () => {
    expect(parseSuggestionForm(form({ vantageEquipmentId: '7' }))).toEqual({ vantageEquipmentId: 7 });
    refused(() => parseSuggestionForm(form({})));
    refused(() => parseSuggestionForm(form({ vantageEquipmentId: '-1' })));
  });
});

describe('upcomingAnchor / withAnchor', () => {
  it('turns a posted work unit id into the call anchor, anything else into null', () => {
    expect(upcomingAnchor('123')).toBe('call-123');
    expect(upcomingAnchor(' 9 ')).toBe('call-9');
    for (const raw of ['', 'x', '1#x', '12345678901', null]) expect(upcomingAnchor(raw)).toBeNull();
    expect(upcomingAnchor(new File([], 'x'))).toBeNull();
  });

  it('replaces the hash of a redirect', () => {
    expect(withAnchor('/pm/planner#card-4', 'call-9')).toBe('/pm/planner#call-9');
    expect(withAnchor('/pm/planner?card=4&plannerError=x#card-4', 'call-9')).toBe('/pm/planner?card=4&plannerError=x#call-9');
    expect(withAnchor('/pm/planner', 'call-9')).toBe('/pm/planner#call-9');
    expect(withAnchor('/pm/planner#card-4', null)).toBe('/pm/planner#card-4');
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

describe('upcomingView', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const fresh = [{ job: 'vantage-schedule', status: 'success', startedAt: now, finishedAt: now }];

  it('says the diary has not refreshed when there are no calls and no recent run', () => {
    const v = upcomingView({ engineers: [] }, [], now, null);
    expect(v.empty).toBe("Engineers' diary hasn't refreshed yet");
    expect(v.engineers).toEqual([]);
  });

  it('says no booked calls when the diary is fresh but empty', () => {
    expect(upcomingView({ engineers: [] }, fresh, now, null).empty).toBe('No booked calls today or tomorrow');
  });

  it('builds days, calls and suggestions with display text', () => {
    const v = upcomingView(
      {
        engineers: [
          engineer([
            call({
              started: true,
              suggestions: [
                suggestion({ vantageEquipmentId: 1, boardColumn: 'to_plan', priority: true }),
                suggestion({ vantageEquipmentId: 2, distanceMiles: null, sameDistrict: true, whenInArea: true, overdueMonths: 18, boardColumn: 'done' }),
                suggestion({ vantageEquipmentId: 3, sameSite: true, status: 'due_soon', overdueMonths: null, boardColumn: 'asked' }),
              ],
            }),
            call({ workUnitId: 11, customerId: null, customerName: null, district: null, located: null, equipment: null, categoryName: 'Site visit' }),
            call({ workUnitId: 12, located: null, district: 'GU14' }),
          ]),
        ],
      },
      fresh,
      now,
      { card: 2, message: 'Nope' },
    );
    expect(v.empty).toBeNull();
    const [eng] = v.engineers;
    expect(eng!.name).toBe('Dave');
    expect(eng!.canAsk).toBe(true);
    expect(eng!.days.map((d) => d.heading)).toEqual(['Today 24 Nov', 'Tomorrow 25 Nov']);
    expect(eng!.days[1]!.emptyText).toBe('No booked calls tomorrow');
    const [c1, c2, c3] = eng!.days[0]!.calls;
    expect(c1).toMatchObject({ anchor: 'call-10', time: '09:30', customer: 'Bravo Ltd', started: true, locationNote: null });
    expect(c1!.suggestions.map((s) => [s.id, s.distanceText, s.onBoardText, s.canAdd, s.canAsk, s.overdueText, s.error])).toEqual([
      [1, '1.2 mi', 'On board: To plan', false, true, 'overdue 3m', null],
      [2, 'Same district (GU14)', 'On board: Done', true, true, 'overdue 18m', 'Nope'],
      [3, 'Same site', 'On board: Asked engineer', false, true, null, null],
    ]);
    expect(c1!.suggestions[0]!.machine).toBe('C300i · A1');
    expect(c2).toMatchObject({ customer: 'Unknown customer', customerLink: null, locationNote: 'No location for this call', category: 'Site visit', equipment: null });
    expect(c3!.locationNote).toBe('No map location — matching on GU14 only');
  });

  it('cannot ask an unassigned engineer, and a booked suggestion has no actions', () => {
    const v = upcomingView(
      { engineers: [engineer([call({ suggestions: [suggestion({ boardColumn: 'booked' })] })], { engineerId: null, name: 'Unassigned' })] },
      fresh,
      now,
      null,
    );
    expect(v.engineers[0]!.canAsk).toBe(false);
    expect(v.engineers[0]!.days[0]!.calls[0]!.suggestions[0]).toMatchObject({ canAsk: false, canAdd: false, onBoardText: 'On board: Booked' });
  });

  it('reports whether a refused card is shown under a suggestion', () => {
    const data = { engineers: [engineer([call({ suggestions: [suggestion({ vantageEquipmentId: 9 })] })])] };
    expect(upcomingView(data, fresh, now, { card: 9, message: 'x' }).showsError).toBe(true);
    expect(upcomingView(data, fresh, now, { card: 8, message: 'x' }).showsError).toBe(false);
  });
});
