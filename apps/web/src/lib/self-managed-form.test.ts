import { describe, expect, it } from 'vitest';
import { SELF_MANAGED_NOTE_MAX, parseSelfManagedForm } from './self-managed-form';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('parseSelfManagedForm', () => {
  it('reads id, on and a trimmed note', () => {
    expect(parseSelfManagedForm(form({ vantageCustomerId: '42', on: 'true', note: '  buys its own  ' }))).toEqual({
      ok: true,
      vantageCustomerId: 42,
      on: true,
      note: 'buys its own',
    });
  });

  it('treats a blank note as none, and reads off', () => {
    expect(parseSelfManagedForm(form({ vantageCustomerId: '7', on: 'false', note: '   ' }))).toEqual({
      ok: true,
      vantageCustomerId: 7,
      on: false,
      note: null,
    });
    expect(parseSelfManagedForm(form({ vantageCustomerId: '7', on: 'false' }))).toMatchObject({ ok: true, note: null });
  });

  it('refuses a bad id or on value', () => {
    expect(parseSelfManagedForm(form({ vantageCustomerId: 'x', on: 'true' })).ok).toBe(false);
    expect(parseSelfManagedForm(form({ vantageCustomerId: '-1', on: 'true' })).ok).toBe(false);
    expect(parseSelfManagedForm(form({ vantageCustomerId: '1234567890', on: 'true' })).ok).toBe(false);
    expect(parseSelfManagedForm(form({ on: 'true' })).ok).toBe(false);
    expect(parseSelfManagedForm(form({ vantageCustomerId: '1', on: 'yes' })).ok).toBe(false);
    expect(parseSelfManagedForm(form({ vantageCustomerId: '1' })).ok).toBe(false);
  });

  it('refuses an over-long note', () => {
    const note = 'x'.repeat(SELF_MANAGED_NOTE_MAX + 1);
    expect(parseSelfManagedForm(form({ vantageCustomerId: '1', on: 'true', note }))).toEqual({
      ok: false,
      error: `Keep the note to ${SELF_MANAGED_NOTE_MAX} characters.`,
    });
    expect(parseSelfManagedForm(form({ vantageCustomerId: '1', on: 'true', note: note.slice(1) })).ok).toBe(true);
  });
});
