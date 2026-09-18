import { describe, expect, it } from 'vitest';
import { formatGap } from './format';

const NOW = new Date('2026-09-18T12:00:00Z');
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('formatGap', () => {
  it('reads in hours while the gap is short enough to matter in hours', () => {
    expect(formatGap(hoursBefore(1), NOW)).toBe('1 hour');
    expect(formatGap(hoursBefore(26), NOW)).toBe('26 hours');
    expect(formatGap(hoursBefore(47), NOW)).toBe('47 hours');
  });

  it('switches to days at two days', () => {
    expect(formatGap(hoursBefore(48), NOW)).toBe('2 days');
    expect(formatGap(hoursBefore(24 * 30), NOW)).toBe('30 days');
  });

  it('does not pretend a gap under an hour is a number of hours', () => {
    expect(formatGap(hoursBefore(0.5), NOW)).toBe('under an hour');
    // A clock skew, or a row written a moment in the future, must not render as "-1 hours".
    expect(formatGap(new Date(NOW.getTime() + 60_000), NOW)).toBe('under an hour');
  });

  it('takes an ISO string, and says nothing useful for nothing', () => {
    expect(formatGap('2026-09-16T12:00:00Z', NOW)).toBe('2 days');
    expect(formatGap(null, NOW)).toBe('—');
    expect(formatGap('not a date', NOW)).toBe('—');
  });
});
