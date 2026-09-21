import { describe, expect, it } from 'vitest';
import { SettingsError } from '@mps/db/queries';
import { parseSettingsForm } from './settings-form';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const colour = { allowInherit: true, isColour: true };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SettingsError ? err.code : `not a SettingsError: ${String(err)}`;
  }
  return undefined;
}

describe('parseSettingsForm', () => {
  it('omits a field left on keep', () => {
    const patch = parseSettingsForm(
      form({ 'threshold-black-mode': 'keep', 'threshold-black': '40', autoReplenish: 'keep', alertsEnabled: 'keep' }),
      colour,
    );
    expect(patch).toEqual({});
  });

  it('omits a field the form does not carry at all', () => {
    expect(parseSettingsForm(form({}), colour)).toEqual({});
  });

  it('turns inherit into null', () => {
    const patch = parseSettingsForm(
      form({ 'threshold-cyan-mode': 'inherit', autoReplenish: 'inherit', alertsEnabled: 'inherit' }),
      colour,
    );
    expect(patch).toEqual({ thresholdCyan: null, autoReplenish: null, alertsEnabled: null });
  });

  it('refuses inherit where there is nothing to inherit from', () => {
    const noInherit = { allowInherit: false, isColour: true };
    expect(codeOf(() => parseSettingsForm(form({ 'threshold-black-mode': 'inherit' }), noInherit))).toBe('default_null');
    expect(codeOf(() => parseSettingsForm(form({ autoReplenish: 'inherit' }), noInherit))).toBe('default_null');
  });

  it('reads a set threshold as a whole number', () => {
    const patch = parseSettingsForm(
      form({
        'threshold-black-mode': 'set',
        'threshold-black': '15',
        'threshold-magenta-mode': 'set',
        'threshold-magenta': ' 0 ',
        'threshold-yellow-mode': 'set',
        'threshold-yellow': '100',
      }),
      colour,
    );
    expect(patch).toEqual({ thresholdBlack: 15, thresholdMagenta: 0, thresholdYellow: 100 });
  });

  it('rejects a threshold that is not a whole percentage', () => {
    for (const bad of ['abc', '101', '-1', '12.5', '', '1e1']) {
      expect(
        codeOf(() => parseSettingsForm(form({ 'threshold-black-mode': 'set', 'threshold-black': bad }), colour)),
        `'${bad}'`,
      ).toBe('invalid_threshold');
    }
  });

  it('turns on/off into booleans', () => {
    expect(parseSettingsForm(form({ autoReplenish: 'on', alertsEnabled: 'off' }), colour)).toEqual({
      autoReplenish: true,
      alertsEnabled: false,
    });
    expect(parseSettingsForm(form({ autoReplenish: 'off', alertsEnabled: 'on' }), colour)).toEqual({
      autoReplenish: false,
      alertsEnabled: true,
    });
  });

  it('ignores cyan, magenta and yellow on a mono device, even when they are invalid', () => {
    const patch = parseSettingsForm(
      form({
        'threshold-black-mode': 'set',
        'threshold-black': '20',
        'threshold-cyan-mode': 'set',
        'threshold-cyan': 'abc',
        'threshold-magenta-mode': 'inherit',
        'threshold-yellow-mode': 'set',
        'threshold-yellow': '30',
      }),
      { allowInherit: true, isColour: false },
    );
    expect(patch).toEqual({ thresholdBlack: 20 });
  });

  it('treats an unknown mode as keep rather than writing anything', () => {
    expect(parseSettingsForm(form({ 'threshold-black-mode': 'drop table', autoReplenish: 'yes' }), colour)).toEqual({});
  });
});
