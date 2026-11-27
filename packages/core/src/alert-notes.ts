import { getBool, getField, getNumber, getString, parseApiDate } from './fields';

/**
 * Words the nightly `vantage-alert-notes` job searches Vantage notes for. Vantage has no note
 * entity set and no per-customer notes route, so `GET /user/GetNotesViaKeyword(search='<word>')`
 * is the only way in: the alert popups ("call ahead", "no mobile phones on site") are whatever
 * these words reach. A word that matches nothing (or a stopword such as "the") costs one call.
 */
export const ALERT_NOTE_KEYWORDS: readonly string[] = [
  'call', 'ring', 'phone', 'ahead', 'access', 'key', 'keys', 'park', 'parking', 'reception',
  'contact', 'before', 'arrive', 'arrival', 'visit', 'engineer', 'site', 'sign', 'security', 'badge',
  'pass', 'gate', 'code', 'alarm', 'collect', 'delivery', 'toner', 'waste', 'do', 'not',
  'only', 'must', 'please', 'ask', 'email', 'booking', 'appointment', 'hours', 'closed', 'open',
  'lunch', 'school', 'term', 'holiday', 'covid', 'mask', 'ppe', 'induction', 'escort', 'lift',
  'stairs', 'floor', 'office', 'manager', 'invoice', 'account', 'stop', 'credit', 'warning', 'important',
  'note', 'always', 'never',
];

export const NOTE_SEARCH_MIN = 2;
export const NOTE_SEARCH_MAX = 50;

/** An OData string literal: single-quoted, with any single quote inside doubled. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A search word typed by a person (or from the keyword list), trimmed; null when it is not a
 * string, is under 2 or over 50 characters, or holds a control character. Vantage answers an empty
 * search with a 400, so nothing empty is ever sent.
 */
export function noteSearchWord(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const word = value.trim();
  if (word.length < NOTE_SEARCH_MIN || word.length > NOTE_SEARCH_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(word)) return null;
  return word;
}

/** One `NoteSearchResultComponent` row, mapped. */
export interface NoteSearchResult {
  noteId: number;
  /** As Vantage sends it: "Customer", "Equipment", or another parent kind. */
  parentType: string | null;
  parentId: number | null;
  /** Account reference for a customer, serial for a machine. */
  parentReference: string | null;
  text: string | null;
  isAlert: boolean;
  loggedDate: Date | null;
  loggedBy: string | null;
  modifiedDate: Date | null;
}

function loggedByName(raw: unknown): string | null {
  const v = getField(raw, 'LoggedBy');
  if (v != null && typeof v === 'object') return getString(v, 'Name') ?? getString(v, 'UserName');
  return getString(raw, 'LoggedBy');
}

/** Any search row with an id; null otherwise. Field names are read case-insensitively. */
export function mapNoteSearchResult(raw: unknown): NoteSearchResult | null {
  if (raw == null || typeof raw !== 'object') return null;
  const noteId = getNumber(raw, 'Id');
  if (noteId === null) return null;
  return {
    noteId,
    parentType: getString(raw, 'ParentType'),
    parentId: getNumber(raw, 'ParentId'),
    parentReference: getString(raw, 'ParentReference'),
    text: getString(raw, 'Text'),
    isAlert: getBool(raw, 'IsAlert') === true,
    loggedDate: parseApiDate(getField(raw, 'LoggedDate')),
    loggedBy: loggedByName(raw),
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
  };
}

export type AlertParentType = 'Customer' | 'Equipment';

export interface AlertNote extends NoteSearchResult {
  parentType: AlertParentType;
  parentId: number;
  isAlert: true;
}

function alertParentType(value: string | null): AlertParentType | null {
  const v = value?.trim().toLowerCase();
  if (v === 'customer') return 'Customer';
  if (v === 'equipment') return 'Equipment';
  return null;
}

/**
 * The rows the job keeps: alert notes (`IsAlert` true — Vantage's popups) on a customer or a
 * machine, with a parent id to attach them by. Everything else is null.
 */
export function mapAlertNote(raw: unknown): AlertNote | null {
  const r = mapNoteSearchResult(raw);
  if (!r || !r.isAlert || r.parentId === null) return null;
  const parentType = alertParentType(r.parentType);
  if (!parentType) return null;
  return { ...r, parentType, parentId: r.parentId, isAlert: true };
}

export interface PhoneLink {
  /** As typed in Vantage, trimmed. */
  display: string;
  /** `tel:` link for the first number in the field; null when it has too few digits to dial. */
  href: string | null;
}

/** A phone number needs at least this many digits to be worth a `tel:` link. */
const MIN_DIAL_DIGITS = 6;

/**
 * Vantage's free-text `PhoneNumber`, for display with a `tel:` link. Null when empty. When several
 * numbers are typed in one field ("01234 567890 / 07700 900123") the link dials the first.
 */
export function formatPhone(value: string | null | undefined): PhoneLink | null {
  const display = value?.trim() ?? '';
  if (display === '') return null;
  const first = display.split(/\s*(?:\/|,|;|\bor\b)\s*/i)[0] ?? display;
  // "+44 (0)1234 ..." — the (0) is not dialled after a country code.
  const cleaned = first.replace(/\(0\)/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < MIN_DIAL_DIGITS) return { display, href: null };
  const plus = cleaned.trim().startsWith('+') ? '+' : '';
  return { display, href: `tel:${plus}${digits}` };
}
