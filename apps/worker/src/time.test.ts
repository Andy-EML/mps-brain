import { describe, expect, it } from 'vitest';
import { isSundayIn, startOfUtcDay } from './time';

describe('time helpers', () => {
  it('detects Sunday in the given zone', () => {
    // 23:30 UTC Saturday = 00:30 BST Sunday
    expect(isSundayIn('Europe/London', new Date('2026-09-19T23:30:00Z'))).toBe(true);
    expect(isSundayIn('UTC', new Date('2026-09-19T23:30:00Z'))).toBe(false);
  });
  it('truncates to UTC midnight', () => {
    expect(startOfUtcDay(new Date('2026-09-17T15:04:05Z')).toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });
});
