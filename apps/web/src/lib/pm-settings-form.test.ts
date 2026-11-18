import { describe, expect, it } from 'vitest';
import { SettingsError } from '@mps/db/queries';
import { parsePmSettingsForm, suggestPmCategoryIds } from './pm-settings-form';

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const VALID: [string, string][] = [
  ['intervalPages', '100,000'],
  ['timeCapMonths', '12'],
  ['qualifyingMinutes', '45'],
  ['frequentCount', '3'],
  ['frequentWindowDays', '30'],
  ['holdDays', '30'],
  ['dueSoonPct', '85'],
  ['dueSoonDays', '30'],
];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SettingsError ? err.code : `not a SettingsError: ${String(err)}`;
  }
  return undefined;
}

function withField(name: string, value: string): [string, string][] {
  return VALID.map(([k, v]) => [k, k === name ? value : v]);
}

describe('parsePmSettingsForm', () => {
  it('parses all numeric fields and pct as percent (85 → 0.85)', () => {
    expect(parsePmSettingsForm(form(VALID))).toEqual({
      intervalPages: 100000,
      timeCapMonths: 12,
      qualifyingMinutes: 45,
      frequentCount: 3,
      frequentWindowDays: 30,
      holdDays: 30,
      dueSoonPct: 0.85,
      dueSoonDays: 30,
      pmCategoryIds: [],
      pmPartKeywords: [],
    });
  });

  it('rejects 0, negatives, decimals for counts', () => {
    for (const name of ['intervalPages', 'timeCapMonths', 'qualifyingMinutes', 'frequentCount', 'frequentWindowDays', 'holdDays', 'dueSoonDays']) {
      for (const raw of ['0', '-3', '2.5', '', 'lots', '1e3']) {
        expect(codeOf(() => parsePmSettingsForm(form(withField(name, raw))))).toBe('invalid_pm_setting');
      }
    }
  });

  it('accepts a due-soon percentage from 50 to 100 only', () => {
    expect(parsePmSettingsForm(form(withField('dueSoonPct', '50'))).dueSoonPct).toBe(0.5);
    expect(parsePmSettingsForm(form(withField('dueSoonPct', '100'))).dueSoonPct).toBe(1);
    for (const raw of ['49', '101', '85.5', '0', '']) {
      expect(codeOf(() => parsePmSettingsForm(form(withField('dueSoonPct', raw))))).toBe('invalid_pm_setting');
    }
  });

  it('reads checked PM categories', () => {
    const s = parsePmSettingsForm(form([...VALID, ['pmCategory', '4'], ['pmCategory', '9'], ['pmCategory', '4']]));
    expect(s.pmCategoryIds).toEqual([4, 9]);
  });

  it('refuses a crafted category id', () => {
    expect(codeOf(() => parsePmSettingsForm(form([...VALID, ['pmCategory', 'x']])))).toBe('invalid_pm_setting');
  });
});

describe('pmPartKeywords', () => {
  it('parses a comma-separated list: trimmed, lower-cased, empties and duplicates dropped', () => {
    const s = parsePmSettingsForm(form([...VALID, ['pmPartKeywords', ' Drum, Fuser ,, transfer belt,fuser ']]));
    expect(s.pmPartKeywords).toEqual(['drum', 'fuser', 'transfer belt']);
  });
  it('allows none', () => {
    expect(parsePmSettingsForm(form([...VALID, ['pmPartKeywords', ' , ']])).pmPartKeywords).toEqual([]);
    expect(parsePmSettingsForm(form(VALID)).pmPartKeywords).toEqual([]);
  });
});

describe('suggestPmCategoryIds', () => {
  it('picks categories named like PM, service or maintenance, not words that merely contain "pm"', () => {
    const cats = [
      { id: 1, name: 'Callout' },
      { id: 2, name: 'Planned maintenance' },
      { id: 3, name: 'PM visit' },
      { id: 4, name: 'Annual Service' },
      { id: 5, name: 'Equipment move' },
    ];
    expect(suggestPmCategoryIds(cats)).toEqual([2, 3, 4]);
  });
});
