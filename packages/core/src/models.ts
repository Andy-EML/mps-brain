/**
 * Mono vs colour detection from a device model name.
 *
 * Konica Minolta and Develop name their colour models with a marker that mono
 * models never carry:
 *   - `C` in front of the model number: `bizhub C3350i`, `C458`, `C308`
 *   - `+` after the range name (Develop): `ineo+308`, `ineo+3350i`
 *   - `MF` as a suffix on some ranges
 * Everything else is mono: `bizhub 301i`, `bizhub 4050i`, `bizhub 4701i`, `287`.
 *
 * Verified against the fleet: every model that has ever reported a
 * Cyan/Magenta/Yellow toner level matches one of these markers, and no model
 * without one ever has.
 */

/** Colour marker: `+`, `MF`, or a capital `C` that starts the model number. */
const COLOUR_MARKER = /\+|MF|(?:^|[^A-Za-z])C\s*\d/;

/**
 * True when the model name says the device prints in colour.
 *
 * Returns `false` for an empty or unknown model name: mono is the safe default,
 * because treating a colour device as mono only hides CMY, while the reverse
 * would raise low-toner alerts for cartridges the device does not have.
 */
export function isColourModel(modelName: string | null | undefined): boolean {
  if (!modelName) return false;
  return COLOUR_MARKER.test(modelName);
}

/** True when the model name says the device is black-only. */
export function isMonoModel(modelName: string | null | undefined): boolean {
  return !isColourModel(modelName);
}
