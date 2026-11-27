/**
 * Wear parts of a copier (drum / imaging unit, developer, transfer belt, transfer roller, fuser):
 * classify a Vantage "part used" description, and parse a DRMS parts-life alarm description.
 * Pure; see docs/superpowers/plans/2026-11-26-parts-status.md for the rules and real examples.
 */

export const PART_KINDS = ['drum', 'developer', 'transfer_belt', 'transfer_roller', 'fuser'] as const;
export type PartKind = (typeof PART_KINDS)[number];

export const PART_COLOURS = ['K', 'C', 'M', 'Y'] as const;
export type PartColour = (typeof PART_COLOURS)[number];

/** Parts that exist once per colour (drum, developer); the others are one per machine. */
export const isColourPart = (p: PartKind): boolean => p === 'drum' || p === 'developer';

export const PART_LABELS: Record<PartKind, string> = {
  drum: 'Drum (imaging unit)',
  developer: 'Developer',
  transfer_belt: 'Transfer belt',
  transfer_roller: 'Transfer roller',
  fuser: 'Fuser',
};

/** Alarm state of a part: end of life > near end > predicted. */
export type PartAlarmLevel = 'end' | 'near_end' | 'predicted';

export interface ClassifiedPart {
  part: PartKind;
  /** Colours covered. Empty for a one-per-machine part, and for a drum/developer whose colour is unknown on a colour machine. */
  colours: PartColour[];
}

/** Things that look like a wear part but are not: rollers other than transfer, chips, cleaning parts. */
const EXCLUDED = /pick\s*-?\s*up|separation|\bsep\b|\bchip\b|cleaning|\bblade\b|\bgear\b|\bspring\b|\bsensor\b/i;

function coloursIn(description: string): PartColour[] {
  if (/\bcmyk\b/i.test(description)) return ['C', 'M', 'Y', 'K'];
  if (/\bcmy\b|\bc\s*[,/]\s*m\s*[,/]\s*y\b|\bcolou?r\b/i.test(description)) return ['C', 'M', 'Y'];
  const out = new Set<PartColour>();
  if (/\bblack\b|\bbk\b/i.test(description)) out.add('K');
  if (/\bcyan\b/i.test(description)) out.add('C');
  if (/\bmagenta\b/i.test(description)) out.add('M');
  if (/\byellow\b/i.test(description)) out.add('Y');
  // Part codes such as "IUP35K" or "DV-318Y" carry the colour as the last letter.
  const code = /\b(?:IUP?|DV|DR|DU)-?\d{2,3}([KCMY])\b/i.exec(description);
  if (code) out.add(code[1]!.toUpperCase() as PartColour);
  return PART_COLOURS.filter((c) => out.has(c));
}

/**
 * Which wear part a fitted-part description is, or null when it is not one (or is an excluded
 * lookalike). On a mono machine a drum/developer is always black; on a colour machine a drum or
 * developer with no colour in its text has `colours: []` (unknown, so recorded for no colour).
 */
export function classifyPart(description: string, isColour: boolean): ClassifiedPart | null {
  if (!description || EXCLUDED.test(description)) return null;
  let part: PartKind | null = null;
  if (/transfer\s+roller/i.test(description)) part = 'transfer_roller';
  else if (/transfer\s+unit/i.test(description) && !isColour) part = 'transfer_roller';
  else if (/transfer\s+(belt|unit)|\bITB\b/i.test(description)) part = 'transfer_belt';
  else if (/\bfus(er|ing)\b/i.test(description)) part = 'fuser';
  else if (/\bdevelop(er|ing)\b|\bDV-?\d/i.test(description)) part = 'developer';
  else if (/\bdrum\b|\bIU\b|imaging\s+unit|\b(?:IUP?|DR)-?\d/i.test(description)) part = 'drum';
  if (part === null) return null;
  if (!isColourPart(part)) return { part, colours: [] };
  if (!isColour) return { part, colours: ['K'] };
  return { part, colours: coloursIn(description) };
}

export interface ParsedPartsAlarm {
  part: PartKind;
  /** The colour for a drum/developer alarm; null for the one-per-machine parts. */
  colour: PartColour | null;
  level: PartAlarmLevel;
}

/**
 * A DRMS parts-life alarm description: `PartsLife(IU_K) 1st Call` (near end), `... 2nd Call` (end of
 * life) and `PartsLifePrediction(DC_M) 1st Call` (predicted soon). A leading code ("TP-01 ") is fine.
 * Null for any other alarm, including `Parts Missing Drum (K)`.
 */
export function parsePartsAlarm(description: string | null | undefined): ParsedPartsAlarm | null {
  if (!description) return null;
  const m = /PartsLife(Prediction)?\s*\(([^)]*)\)\s*(1st|2nd)?/i.exec(description);
  if (!m) return null;
  const level: PartAlarmLevel | null = m[1]
    ? 'predicted'
    : m[3]?.toLowerCase() === '2nd'
      ? 'end'
      : m[3]?.toLowerCase() === '1st'
        ? 'near_end'
        : null;
  if (level === null) return null;
  const name = m[2]!.trim();
  const coded = /^(IU|DC)[_\s-]?([KCMY])$/i.exec(name);
  if (coded) {
    return {
      part: coded[1]!.toUpperCase() === 'IU' ? 'drum' : 'developer',
      colour: coded[2]!.toUpperCase() as PartColour,
      level,
    };
  }
  if (/transfer\s+roller/i.test(name)) return { part: 'transfer_roller', colour: null, level };
  if (/transfer\s+belt|\bITB\b/i.test(name)) return { part: 'transfer_belt', colour: null, level };
  if (/fus/i.test(name)) return { part: 'fuser', colour: null, level };
  return null;
}

/** Keys of the rated-life columns on a cartridge family (drum and developer split mono K vs colour CMY). */
export const PART_LIFE_KEYS = [
  'drumK',
  'drumCmy',
  'developerK',
  'developerCmy',
  'transferBelt',
  'transferRoller',
  'fuser',
] as const;
export type PartLifeKey = (typeof PART_LIFE_KEYS)[number];
export type PartLives = Record<PartLifeKey, number | null>;

export const PART_LIFE_LABELS: Record<PartLifeKey, string> = {
  drumK: 'Drum / IU (black)',
  drumCmy: 'Drum / IU (each colour)',
  developerK: 'Developer (black)',
  developerCmy: 'Developer (each colour)',
  transferBelt: 'Transfer belt',
  transferRoller: 'Transfer roller',
  fuser: 'Fuser',
};

/** The rated-life key that applies to a part and colour (null colour for one-per-machine parts). */
export function partLifeKey(part: PartKind, colour: PartColour | null): PartLifeKey {
  switch (part) {
    case 'drum':
      return colour === 'K' || colour === null ? 'drumK' : 'drumCmy';
    case 'developer':
      return colour === 'K' || colour === null ? 'developerK' : 'developerCmy';
    case 'transfer_belt':
      return 'transferBelt';
    case 'transfer_roller':
      return 'transferRoller';
    case 'fuser':
      return 'fuser';
  }
}
