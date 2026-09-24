/**
 * What to call a machine on screen. Pure, so the query layer can attach a `displayName` to its rows
 * and every page shows the same thing, rather than each component working it out again.
 */

/**
 * Split on anything that isn't a letter or a digit, lower-case, and drop a trailing firmware
 * version from each token (`_Ver42` → its own token and then empty; `458Ver2` → `458`). DRMS
 * product names and model names differ mostly in punctuation and that suffix, so this turns
 * "ineo+458_Ver42" and "ineo+458" into the same token list.
 */
function modelTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/ver\d+$/, ''))
    .filter((t) => t !== '');
}

/**
 * Whether a DRMS name is worth showing next to the model.
 *
 * Many devices are named after their own model — "ineo+458_Ver42" beside a Model column reading
 * "ineo+458" — which prints the same thing twice in one row. Others carry the site, which is the
 * most useful thing on the row: "Little Heath School (Maths) C3351i", "A-Plan (Southampton)
 * MF3303".
 *
 * The test is therefore "does anything survive once the model's own words are taken out", not
 * plain substring containment. Containment would also hide "A-Plan (Southampton) MF3303" whenever
 * the model is literally `MF3303`, and that name is exactly the kind we want to keep. A name that
 * is only a shortened model ("C3351i" under "bizhub C3351i") still leaves nothing behind, so it is
 * dropped as intended.
 */
export function deviceNameAddsInfo(name: string | null | undefined, model: string | null | undefined): boolean {
  const nameTokens = name ? modelTokens(name) : [];
  if (nameTokens.length === 0) return false;

  const fromModel = new Set(model ? modelTokens(model) : []);
  if (fromModel.size === 0) return true;

  return nameTokens.some((t) => !fromModel.has(t));
}

export interface DeviceNameParts {
  /** DRMS's equipment `Name` (`drms_equipment.raw->>'Name'`), e.g. "Hazell & Jefferies Downstairs C450i". */
  equipmentName: string | null;
  customerName: string | null;
  model: string | null;
  serial: string | null;
  drmsId: string;
}

/**
 * The equipment `Name` from DRMS when it says more than the model — it usually carries the site —
 * else the customer and the model ("Hazell & Jefferies bizhub C450i"), else the serial, else the
 * DRMS id. Never the DRMS *product* name ("bizhub C300i_Ver22"), which only restates the model.
 */
export function deviceDisplayName(d: DeviceNameParts): string {
  if (d.equipmentName && deviceNameAddsInfo(d.equipmentName, d.model)) return d.equipmentName.trim();
  const fallback = [d.customerName, d.model]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(' ');
  return fallback || d.serial || d.drmsId;
}
