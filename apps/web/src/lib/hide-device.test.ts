import { describe, expect, it } from 'vitest';
import { hideErrorMessage } from './hide-device';

describe('hideErrorMessage', () => {
  it('says what went wrong for each HideError code and the selection cap', () => {
    expect(hideErrorMessage('no_devices')).toBe('Select at least one device.');
    expect(hideErrorMessage('reason_too_long')).toMatch(/500 characters/);
    expect(hideErrorMessage('too_many')).toMatch(/Select all matching/);
  });

  it('still reads as a failure for an unknown code', () => {
    expect(hideErrorMessage('???')).toBe('The devices could not be hidden. Try again.');
  });
});
