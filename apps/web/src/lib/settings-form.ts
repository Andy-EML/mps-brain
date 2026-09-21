import { SettingsError, type SettingsErrorCode, type SettingsPatch } from '@mps/db/queries';

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

/**
 * `?settingsError=<code>` as a sentence. Every settings form's action sends a `SettingsError` back
 * as its code; the device page and the devices list both turn it into text here. `too_many` is the
 * bulk action's own: more ids posted than one explicit selection may carry.
 */
const SETTINGS_ERRORS: Record<SettingsErrorCode | 'too_many', string> = {
  invalid_threshold: 'A threshold is a whole percentage from 0 to 100.',
  empty_patch: 'Nothing was changed — pick Inherit or a new value for at least one setting.',
  default_null: 'The default settings cannot inherit from anything — give each one a value.',
  no_devices: 'No devices were selected, so nothing was changed.',
  too_many: 'That is too many devices to pick one by one — use “Select all matching” instead.',
};

export function settingsErrorMessage(code: string): string {
  return (
    (SETTINGS_ERRORS as Record<string, string>)[code] ??
    'The settings were not saved. Refresh the page and try again.'
  );
}

const FLAG_LABELS: Record<(typeof FLAGS)[number], string> = {
  autoReplenish: 'auto-replenish',
  alertsEnabled: 'no-meter-reading alerts',
};

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * A patch as one sentence for the bulk confirmation step: "Set cyan, magenta and yellow threshold
 * to 15%". Colours set to the same value share a phrase, then resets, then the flags, in the
 * dialog's order. No trailing full stop, so the caller can add "on 42 devices".
 */
export function describeSettingsPatch(patch: SettingsPatch): string {
  const phrases: string[] = [];

  const setTo = new Map<number, ThresholdColour[]>();
  const reset: ThresholdColour[] = [];
  for (const { colour, key } of THRESHOLDS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) reset.push(colour);
    else setTo.set(value, [...(setTo.get(value) ?? []), colour]);
  }
  for (const [value, colours] of setTo)
    phrases.push(`set ${listOf(colours)} threshold to ${value}%`);
  if (reset.length > 0) phrases.push(`reset ${listOf(reset)} threshold to inherited`);

  for (const key of FLAGS) {
    const value = patch[key];
    if (value === undefined) continue;
    phrases.push(
      value === null
        ? `reset ${FLAG_LABELS[key]} to inherited`
        : `turn ${FLAG_LABELS[key]} ${value ? 'on' : 'off'}`,
    );
  }

  const sentence = phrases.length > 0 ? listOf(phrases) : 'change nothing';
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Whether the patch writes (or resets) a cyan, magenta or yellow threshold — what mono devices ignore. */
export function patchTouchesColour(patch: SettingsPatch): boolean {
  return (
    patch.thresholdCyan !== undefined ||
    patch.thresholdMagenta !== undefined ||
    patch.thresholdYellow !== undefined
  );
}
