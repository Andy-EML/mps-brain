import { describe, expect, it } from 'vitest';
import { SettingsError } from '@mps/db/queries';
import { parseBookedForm, parseDismissForm, parseUndoForm, pmErrorKey, pmErrorMessage, pmReturnHref } from './pm-action-form';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SettingsError ? err.code : `not a SettingsError: ${String(err)}`;
  }
  return undefined;
}

// 18 Nov 2026 23:30 UTC is still 18 Nov in London (GMT).
const NOW = new Date('2026-11-18T23:30:00Z');

describe('parseBookedForm', () => {
  it('booked with blank date/reference ok', () => {
    expect(parseBookedForm(form({ vantageEquipmentId: '42', bookedFor: '', reference: '  ' }))).toEqual({
      vantageEquipmentId: 42,
      bookedFor: null,
      reference: null,
    });
  });

  it('reads a date and a trimmed reference', () => {
    expect(parseBookedForm(form({ vantageEquipmentId: '42', bookedFor: '2026-12-03', reference: ' W123 ' }))).toEqual({
      vantageEquipmentId: 42,
      bookedFor: new Date('2026-12-03T00:00:00Z'),
      reference: 'W123',
    });
  });

  it('refuses a bad date or machine id', () => {
    expect(codeOf(() => parseBookedForm(form({ vantageEquipmentId: '42', bookedFor: '3/12/2026' })))).toBe('invalid_pm_action');
    expect(codeOf(() => parseBookedForm(form({ vantageEquipmentId: '42', bookedFor: '2026-02-30' })))).toBe('invalid_pm_action');
    expect(codeOf(() => parseBookedForm(form({ vantageEquipmentId: 'x' })))).toBe('invalid_pm_action');
    expect(codeOf(() => parseBookedForm(form({})))).toBe('invalid_pm_action');
  });
});

describe('parseDismissForm', () => {
  it('defaults the snooze to 90 days and keeps an optional note', () => {
    expect(parseDismissForm(form({ vantageEquipmentId: '7', reason: 'not_now', note: '' }), NOW)).toEqual({
      vantageEquipmentId: 7,
      reason: 'not_now',
      note: null,
      snoozeDays: 90,
      servicedOn: null,
    });
    expect(parseDismissForm(form({ vantageEquipmentId: '7', reason: 'declined', snoozeDays: '180', note: ' Moving site ' }), NOW)).toMatchObject({
      reason: 'declined',
      snoozeDays: 180,
      note: 'Moving site',
    });
  });

  it('dismiss other needs note', () => {
    expect(codeOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'other', note: '   ' }), NOW))).toBe('invalid_pm_action');
    expect(parseDismissForm(form({ vantageEquipmentId: '7', reason: 'other', note: 'Lease ending' }), NOW).note).toBe('Lease ending');
  });

  it('snooze must be 30/90/180', () => {
    expect(codeOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'not_now', snoozeDays: '60' }), NOW))).toBe('invalid_pm_action');
    expect(codeOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'not_now', snoozeDays: 'abc' }), NOW))).toBe('invalid_pm_action');
    for (const days of [30, 90, 180]) {
      expect(parseDismissForm(form({ vantageEquipmentId: '7', reason: 'not_now', snoozeDays: String(days) }), NOW).snoozeDays).toBe(days);
    }
  });

  it('serviced_outside defaults date to today', () => {
    expect(parseDismissForm(form({ vantageEquipmentId: '7', reason: 'serviced_outside', servicedOn: '', snoozeDays: '30' }), NOW)).toEqual({
      vantageEquipmentId: 7,
      reason: 'serviced_outside',
      note: null,
      snoozeDays: undefined,
      servicedOn: new Date('2026-11-18T00:00:00Z'),
    });
    expect(parseDismissForm(form({ vantageEquipmentId: '7', reason: 'serviced_outside', servicedOn: '2026-11-02' }), NOW).servicedOn).toEqual(
      new Date('2026-11-02T00:00:00Z'),
    );
  });

  it('refuses an unknown reason and a future service date', () => {
    expect(codeOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'bored' }), NOW))).toBe('invalid_pm_action');
    expect(codeOf(() => parseDismissForm(form({ vantageEquipmentId: '7' }), NOW))).toBe('invalid_pm_action');
    expect(
      codeOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'serviced_outside', servicedOn: '2026-11-19' }), NOW)),
    ).toBe('invalid_pm_action');
  });
});

describe('parseUndoForm', () => {
  it('reads the action and machine ids', () => {
    expect(parseUndoForm(form({ actionId: '5', vantageEquipmentId: '42' }))).toEqual({ actionId: 5, vantageEquipmentId: 42 });
    expect(codeOf(() => parseUndoForm(form({ actionId: '', vantageEquipmentId: '42' })))).toBe('invalid_pm_action');
  });
});

describe('pmReturnHref', () => {
  it('keeps the list params and opens the row', () => {
    expect(pmReturnHref('/pm?view=booked&page=2&open=9', 42)).toBe('/pm?view=booked&page=2&open=42');
  });

  it('adds an error code and drops an old one', () => {
    expect(pmReturnHref('/pm?pmError=old', 42, 'invalid_pm_action')).toBe('/pm?open=42&pmError=invalid_pm_action');
    expect(pmReturnHref('/pm?pmError=old', 42)).toBe('/pm?open=42');
  });

  it('never leaves /pm', () => {
    expect(pmReturnHref('https://evil.example/pm?view=all', 42)).toBe('/pm?open=42');
    expect(pmReturnHref('//evil.example/pm', 42)).toBe('/pm?open=42');
    expect(pmReturnHref('/devices?x=1', 42)).toBe('/pm?open=42');
    expect(pmReturnHref(null, 42)).toBe('/pm?open=42');
  });
});

describe('pmErrorKey / pmErrorMessage', () => {
  const keyOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return pmErrorKey(err);
    }
    return undefined;
  };

  it('gives each refusal its own sentence', () => {
    const future = keyOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'serviced_outside', servicedOn: '2026-11-19' }), NOW));
    expect(future).toBe('future_date');
    expect(pmErrorMessage(future!)).toBe('The service date cannot be in the future.');
    expect(keyOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'other' }), NOW))).toBe('note_required');
    expect(keyOf(() => parseDismissForm(form({ vantageEquipmentId: '7', reason: 'not_now', snoozeDays: '60' }), NOW))).toBe('snooze');
    expect(keyOf(() => parseBookedForm(form({ vantageEquipmentId: '7', bookedFor: 'soon' })))).toBe('bad_date');
    expect(keyOf(() => parseBookedForm(form({ vantageEquipmentId: '7', bookedFor: '2026-11-03' }), NOW))).toBe('past_booked');
    expect(() => parseBookedForm(form({ vantageEquipmentId: '7', bookedFor: '2026-11-04' }), NOW)).not.toThrow();
  });

  it('falls back to the generic sentence, and a failed save is its own', () => {
    expect(pmErrorKey(new SettingsError('Something new.', 'invalid_pm_action'))).toBe('invalid_pm_action');
    expect(pmErrorKey(new Error('connection refused'))).toBe('save_failed');
    expect(pmErrorMessage('save_failed')).toBe('Couldn’t save — try again.');
    expect(pmErrorMessage('<script>')).toBe(pmErrorMessage('invalid_pm_action'));
  });
});
