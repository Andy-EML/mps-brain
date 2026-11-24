import { describe, expect, it } from 'vitest';
import { SettingsError } from '@mps/db/queries';
import { formatPatches, parsePatches, parsePlannerSettingsForm, plannerSettingsToValues } from './planner-settings-form';
import { plannerFormValues } from './planner-settings-state';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SettingsError ? err.code : 'not a SettingsError';
  }
  return undefined;
}

const VALID = {
  irelandDealer: ' MJ Flood ',
  scotlandDealer: 'CMYK',
  channelIslandsDealer: ' Sigma ',
  nearMiles: '10',
  doneRetentionDays: '14',
  askedStaleDays: '7',
  patches: 'Farnborough patch: GU14, GU11',
};

describe('parsePatches', () => {
  it('reads one patch per line, districts trimmed and uppercased, blank lines ignored', () => {
    expect(parsePatches('Farnborough patch: GU14, gu11 ,GU51\n\nNorth: RG1')).toEqual([
      { name: 'Farnborough patch', districts: ['GU14', 'GU11', 'GU51'] },
      { name: 'North', districts: ['RG1'] },
    ]);
  });

  it('handles CRLF line ends, surrounding spaces and an empty text', () => {
    expect(parsePatches('  A : W1A , sw1a \r\n  \r\nB:EC1V')).toEqual([
      { name: 'A', districts: ['W1A', 'SW1A'] },
      { name: 'B', districts: ['EC1V'] },
    ]);
    expect(parsePatches('')).toEqual([]);
    expect(parsePatches('\n  \n')).toEqual([]);
  });

  it('throws SettingsError for a line without a colon', () => {
    expect(codeOf(() => parsePatches('Farnborough GU14'))).toBe('invalid_planner_setting');
  });

  it('throws SettingsError for an invalid district, a missing name or no districts', () => {
    expect(codeOf(() => parsePatches('North: GU14 7PR'))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePatches('North: 14GU'))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePatches(': GU14'))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePatches('North:'))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePatches('North: , ,'))).toBe('invalid_planner_setting');
  });

  it('skips empty items, such as a trailing or doubled comma', () => {
    expect(parsePatches('North: GU14,,GU11,\nSouth: RG1, ')).toEqual([
      { name: 'North', districts: ['GU14', 'GU11'] },
      { name: 'South', districts: ['RG1'] },
    ]);
  });

  it('round-trips through formatPatches', () => {
    const text = 'Farnborough patch: GU14, gu11 ,GU51\n\nNorth: RG1';
    const parsed = parsePatches(text);
    expect(formatPatches(parsed)).toBe('Farnborough patch: GU14, GU11, GU51\nNorth: RG1');
    expect(parsePatches(formatPatches(parsed))).toEqual(parsed);
    expect(formatPatches([])).toBe('');
  });
});

describe('parsePlannerSettingsForm', () => {
  it('reads a valid form', () => {
    expect(parsePlannerSettingsForm(form(VALID))).toEqual({
      regionDealers: { ireland: 'MJ Flood', scotland: 'CMYK', channel_islands: 'Sigma' },
      nearMiles: 10,
      doneRetentionDays: 14,
      askedStaleDays: 7,
      patches: [{ name: 'Farnborough patch', districts: ['GU14', 'GU11'] }],
    });
  });

  it('maps blank dealer names to null', () => {
    const s = parsePlannerSettingsForm(form({ ...VALID, irelandDealer: '   ', scotlandDealer: '', channelIslandsDealer: ' ' }));
    expect(s.regionDealers).toEqual({ ireland: null, scotland: null, channel_islands: null });
    expect(parsePlannerSettingsForm(form({ nearMiles: '5', doneRetentionDays: '1', askedStaleDays: '1' })).regionDealers).toEqual({ ireland: null, scotland: null, channel_islands: null });
  });

  it('rejects non-numeric miles and days', () => {
    expect(codeOf(() => parsePlannerSettingsForm(form({ ...VALID, nearMiles: 'ten' })))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePlannerSettingsForm(form({ ...VALID, nearMiles: '' })))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePlannerSettingsForm(form({ ...VALID, nearMiles: '2.5' })))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePlannerSettingsForm(form({ ...VALID, doneRetentionDays: '1e1' })))).toBe('invalid_planner_setting');
    expect(codeOf(() => parsePlannerSettingsForm(form({ ...VALID, askedStaleDays: '-3' })))).toBe('invalid_planner_setting');
  });

  it('passes bad patches up as SettingsError', () => {
    expect(codeOf(() => parsePlannerSettingsForm(form({ ...VALID, patches: 'nope' })))).toBe('invalid_planner_setting');
  });
});

describe('planner form values', () => {
  it('plannerFormValues keeps the fields exactly as typed, missing ones blank', () => {
    expect(plannerFormValues(form({ irelandDealer: ' MJ Flood ', nearMiles: 'ten', patches: 'North: GU14,\nbad line' }))).toEqual({
      irelandDealer: ' MJ Flood ',
      scotlandDealer: '',
      channelIslandsDealer: '',
      nearMiles: 'ten',
      doneRetentionDays: '',
      askedStaleDays: '',
      patches: 'North: GU14,\nbad line',
    });
  });

  it('plannerSettingsToValues shows stored settings as the form does, and parses back to them', () => {
    const settings = {
      regionDealers: { ireland: 'MJ Flood', scotland: null, channel_islands: 'Sigma' },
      nearMiles: 12,
      doneRetentionDays: 14,
      askedStaleDays: 7,
      patches: [{ name: 'North', districts: ['GU14', 'GU11'] }],
    };
    const values = plannerSettingsToValues(settings);
    expect(values).toEqual({
      irelandDealer: 'MJ Flood',
      scotlandDealer: '',
      channelIslandsDealer: 'Sigma',
      nearMiles: '12',
      doneRetentionDays: '14',
      askedStaleDays: '7',
      patches: 'North: GU14, GU11',
    });
    expect(parsePlannerSettingsForm(form({ ...values }))).toEqual(settings);
  });
});
