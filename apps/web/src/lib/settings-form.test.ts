import { describe, expect, it } from 'vitest';
import { SettingsError } from '@mps/db/queries';
import {
  describeSettingsPatch,
  parseSettingsForm,
  patchTouchesColour,
  settingsErrorMessage,
} from './settings-form';

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

describe('describeSettingsPatch', () => {
  it('groups thresholds set to the same value into one phrase', () => {
    expect(
      describeSettingsPatch({ thresholdCyan: 15, thresholdMagenta: 15, thresholdYellow: 15 }),
    ).toBe('Set cyan, magenta and yellow threshold to 15%');
  });

  it('lists different values, resets and flags in the dialog order', () => {
    expect(
      describeSettingsPatch({
        thresholdBlack: 20,
        thresholdCyan: null,
        thresholdMagenta: 12,
        thresholdYellow: null,
        autoReplenish: false,
        alertsEnabled: null,
      }),
    ).toBe(
      'Set black threshold to 20%, set magenta threshold to 12%, reset cyan and yellow threshold to inherited, turn auto-replenish off and reset no-meter-reading alerts to inherited',
    );
  });

  it('turns flags on and off', () => {
    expect(describeSettingsPatch({ autoReplenish: true, alertsEnabled: false })).toBe(
      'Turn auto-replenish on and turn no-meter-reading alerts off',
    );
  });

  it('says so when there is nothing to change', () => {
    expect(describeSettingsPatch({})).toBe('Change nothing');
  });
});

describe('patchTouchesColour', () => {
  it('is true only when cyan, magenta or yellow is in the patch (a reset counts)', () => {
    expect(patchTouchesColour({ thresholdBlack: 20, autoReplenish: true })).toBe(false);
    expect(patchTouchesColour({ thresholdYellow: null })).toBe(true);
    expect(patchTouchesColour({ thresholdCyan: 10 })).toBe(true);
  });
});

describe('settingsErrorMessage', () => {
  it('has a sentence for every SettingsError code', () => {
    for (const code of ['invalid_threshold', 'empty_patch', 'default_null', 'no_devices']) {
      const text = settingsErrorMessage(code);
      expect(text).not.toBe(settingsErrorMessage('something else'));
      expect(text.length).toBeGreaterThan(10);
    }
  });

  it('falls back to a generic sentence for an unknown code', () => {
    expect(settingsErrorMessage('drop table')).toMatch(/not saved/);
  });
});
