import { describe, expect, it } from 'vitest';
import {
  ALERT_NOTE_KEYWORDS,
  formatPhone,
  mapAlertNote,
  mapNoteSearchResult,
  noteSearchWord,
  odataString,
} from './alert-notes';

// Field names as returned by `GET /user/GetNotesViaKeyword(search='call')` (checked live 2026-11-27).
const note = (extra: object = {}) => ({
  Id: 101,
  Rank: 3,
  ParentId: 55,
  ParentType: 'Customer',
  ParentReference: 'APLA44',
  Text: '2020 - Call ahead of service calls',
  IsAlert: true,
  IsInternal: false,
  IsEmail: false,
  LoggedDate: '2020-03-04T09:15:00Z',
  LoggedBy: 'J Bloggs',
  ModifiedDate: '2021-01-02T10:00:00Z',
  ...extra,
});

describe('ALERT_NOTE_KEYWORDS', () => {
  it('holds the plan list: lower case, unique, every one a valid search word', () => {
    expect(ALERT_NOTE_KEYWORDS).toContain('call');
    expect(ALERT_NOTE_KEYWORDS).toContain('ahead');
    expect(ALERT_NOTE_KEYWORDS).toContain('never');
    expect(ALERT_NOTE_KEYWORDS).toHaveLength(63);
    expect(new Set(ALERT_NOTE_KEYWORDS).size).toBe(ALERT_NOTE_KEYWORDS.length);
    for (const w of ALERT_NOTE_KEYWORDS) {
      expect(w).toBe(w.toLowerCase());
      expect(noteSearchWord(w)).toBe(w);
    }
  });
});

describe('odataString', () => {
  it('quotes a word and doubles single quotes', () => {
    expect(odataString('call')).toBe("'call'");
    expect(odataString("o'neil")).toBe("'o''neil'");
    expect(odataString("''")).toBe("''''''");
  });
});

describe('noteSearchWord', () => {
  it('trims and accepts 2 to 50 characters', () => {
    expect(noteSearchWord('  call ')).toBe('call');
    expect(noteSearchWord('ab')).toBe('ab');
    expect(noteSearchWord('x'.repeat(50))).toBe('x'.repeat(50));
  });
  it('rejects empty, too short, too long and non-strings', () => {
    expect(noteSearchWord('')).toBeNull();
    expect(noteSearchWord('   ')).toBeNull();
    expect(noteSearchWord('a')).toBeNull();
    expect(noteSearchWord('x'.repeat(51))).toBeNull();
    expect(noteSearchWord(null)).toBeNull();
    expect(noteSearchWord(42)).toBeNull();
  });
  it('rejects control characters', () => {
    expect(noteSearchWord('ca\nll')).toBeNull();
  });
});

describe('mapNoteSearchResult', () => {
  it('maps every field the search returns', () => {
    expect(mapNoteSearchResult(note())).toEqual({
      noteId: 101,
      parentType: 'Customer',
      parentId: 55,
      parentReference: 'APLA44',
      text: '2020 - Call ahead of service calls',
      isAlert: true,
      loggedDate: new Date('2020-03-04T09:15:00Z'),
      loggedBy: 'J Bloggs',
      modifiedDate: new Date('2021-01-02T10:00:00Z'),
    });
  });
  it('reads field names case-insensitively and a LoggedBy object by its name', () => {
    const r = mapNoteSearchResult({ id: 7, parentid: 3, parenttype: 'Equipment', isalert: 'true', LoggedBy: { Name: 'A User' } });
    expect(r).toMatchObject({ noteId: 7, parentId: 3, parentType: 'Equipment', isAlert: true, loggedBy: 'A User', text: null });
  });
  it('is null without an id', () => {
    expect(mapNoteSearchResult(note({ Id: null }))).toBeNull();
    expect(mapNoteSearchResult('x')).toBeNull();
  });
});

describe('mapAlertNote', () => {
  it('keeps alert notes on a customer or a machine', () => {
    expect(mapAlertNote(note())).toMatchObject({ noteId: 101, parentType: 'Customer', parentId: 55 });
    expect(mapAlertNote(note({ ParentType: 'Equipment', ParentId: 9 }))).toMatchObject({ parentType: 'Equipment', parentId: 9 });
  });
  it('normalises the parent type casing', () => {
    expect(mapAlertNote(note({ ParentType: 'customer' }))?.parentType).toBe('Customer');
    expect(mapAlertNote(note({ ParentType: ' EQUIPMENT ' }))?.parentType).toBe('Equipment');
  });
  it('drops non-alerts, other parents and notes without a parent id', () => {
    expect(mapAlertNote(note({ IsAlert: false }))).toBeNull();
    expect(mapAlertNote(note({ IsAlert: null }))).toBeNull();
    expect(mapAlertNote(note({ ParentType: 'Work' }))).toBeNull();
    expect(mapAlertNote(note({ ParentType: null }))).toBeNull();
    expect(mapAlertNote(note({ ParentId: null }))).toBeNull();
    expect(mapAlertNote(note({ Id: undefined }))).toBeNull();
  });
});

describe('formatPhone', () => {
  it('trims and builds a tel: href from the digits and a leading plus', () => {
    expect(formatPhone(' 01234 567890 ')).toEqual({ display: '01234 567890', href: 'tel:01234567890' });
    expect(formatPhone('+44 (0)1234-567890')).toEqual({ display: '+44 (0)1234-567890', href: 'tel:+441234567890' });
  });
  it('keeps the first number when several are typed in one field', () => {
    expect(formatPhone('01234 567890 / 07700 900123')).toEqual({ display: '01234 567890 / 07700 900123', href: 'tel:01234567890' });
  });
  it('is null when empty', () => {
    expect(formatPhone(null)).toBeNull();
    expect(formatPhone(undefined)).toBeNull();
    expect(formatPhone('')).toBeNull();
    expect(formatPhone('   ')).toBeNull();
  });
  it('shows text with too few digits but gives it no link', () => {
    expect(formatPhone('ask reception')).toEqual({ display: 'ask reception', href: null });
    expect(formatPhone('ext 12')).toEqual({ display: 'ext 12', href: null });
  });
});
