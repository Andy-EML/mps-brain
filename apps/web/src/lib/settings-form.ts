import { SettingsError, type SettingsPatch } from '@mps/db/queries';

/**
 * Turns a replenishment-settings form into a `SettingsPatch`. Shared by the device page's Edit
 * dialog, the devices-list bulk bar and `/settings/replenishment`, which all post the same field
 * names (`SettingsDialog` renders them):
 *
 * - thresholds: `threshold-<colour>-mode` = `keep` | `inherit` | `set`, and the number in
 *   `threshold-<colour>` when the mode is `set`;
 * - flags: `autoReplenish` / `alertsEnabled` = `keep` | `inherit` | `on` | `off`.
 *
 * `keep` (or a field the form does not carry, or a mode it does not recognise) leaves the key out,
 * so nothing is written for it; `inherit` gives `null`. Pure, and it throws the same
 * `SettingsError` codes as the queries, so an action handles both the same way. The queries
 * validate again — this only turns strings into values.
 */

export type ThresholdColour = 'black' | 'cyan' | 'magenta' | 'yellow';

export interface ParseSettingsOptions {
  /** False for the default row, which has nothing above it to inherit from. */
  allowInherit: boolean;
  /** False for a mono device: its cyan/magenta/yellow fields are ignored whatever they say. */
  isColour: boolean;
}

const THRESHOLDS: { colour: ThresholdColour; key: 'thresholdBlack' | 'thresholdCyan' | 'thresholdMagenta' | 'thresholdYellow' }[] = [
  { colour: 'black', key: 'thresholdBlack' },
  { colour: 'cyan', key: 'thresholdCyan' },
  { colour: 'magenta', key: 'thresholdMagenta' },
  { colour: 'yellow', key: 'thresholdYellow' },
];

const FLAGS = ['autoReplenish', 'alertsEnabled'] as const;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function inherit(options: ParseSettingsOptions): null {
  if (!options.allowInherit) {
    throw new SettingsError('The default settings cannot inherit from anything.', 'default_null');
  }
  return null;
}

/** A whole percentage 0–100 written as plain digits; anything else (`12.5`, `1e1`, `''`) is refused. */
function threshold(raw: string): number {
  if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) {
    throw new SettingsError('A threshold is a whole percentage from 0 to 100.', 'invalid_threshold');
  }
  return Number(raw);
}

export function parseSettingsForm(formData: FormData, options: ParseSettingsOptions): SettingsPatch {
  const patch: SettingsPatch = {};

  for (const { colour, key } of THRESHOLDS) {
    if (colour !== 'black' && !options.isColour) continue;
    const mode = text(formData, `threshold-${colour}-mode`);
    if (mode === 'inherit') patch[key] = inherit(options);
    else if (mode === 'set') patch[key] = threshold(text(formData, `threshold-${colour}`));
  }

  for (const key of FLAGS) {
    const mode = text(formData, key);
    if (mode === 'inherit') patch[key] = inherit(options);
    else if (mode === 'on') patch[key] = true;
    else if (mode === 'off') patch[key] = false;
  }

  return patch;
}
