import { describe, expect, it } from 'vitest';
import {
  chunk,
  getBool,
  getField,
  getNumber,
  getString,
  mapPool,
  normaliseKey,
  normaliseSerial,
  parseApiDate,
} from './fields';

describe('normaliseSerial', () => {
  it('trims, upper-cases and strips spaces and dashes', () => {
    expect(normaliseSerial(' a1b2-c3 d4e ')).toBe('A1B2C3D4E');
  });
  it('returns null for empty or missing', () => {
    expect(normaliseSerial('  - ')).toBeNull();
    expect(normaliseSerial(null)).toBeNull();
    expect(normaliseSerial(undefined)).toBeNull();
  });
});

describe('normaliseKey', () => {
  it('stringifies numbers and upper-cases strings', () => {
    expect(normaliseKey(42)).toBe('42');
    expect(normaliseKey(' cust1 ')).toBe('CUST1');
    expect(normaliseKey('')).toBeNull();
  });
});

describe('getField family', () => {
  const obj = { SerialNumber: 'X1', id: '7', IsActive: 'false', Flag: true, Empty: '' };
  it('finds keys case-insensitively', () => {
    expect(getField(obj, 'serialnumber')).toBe('X1');
    expect(getField(obj, 'Id')).toBe('7');
    expect(getField(null, 'x')).toBeUndefined();
  });
  it('converts types', () => {
    expect(getString(obj, 'Id')).toBe('7');
    expect(getNumber(obj, 'Id')).toBe(7);
    expect(getNumber(obj, 'Empty')).toBeNull();
    expect(getNumber(obj, 'SerialNumber')).toBeNull();
    expect(getBool(obj, 'IsActive')).toBe(false);
    expect(getBool(obj, 'Flag')).toBe(true);
    expect(getBool(obj, 'Missing')).toBeNull();
  });
});

describe('parseApiDate', () => {
  it('parses DRMS space format as UTC', () => {
    expect(parseApiDate('2026-09-17 06:30:00')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
  });
  it('parses ISO with and without zone', () => {
    expect(parseApiDate('2026-09-17T06:30:00Z')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
    expect(parseApiDate('2026-09-17T06:30:00')?.toISOString()).toBe('2026-09-17T06:30:00.000Z');
    expect(parseApiDate('2026-09-17T07:30:00+01:00')?.toISOString()).toBe(
      '2026-09-17T06:30:00.000Z',
    );
  });
  it('returns null for junk', () => {
    expect(parseApiDate('not a date')).toBeNull();
    expect(parseApiDate(null)).toBeNull();
    expect(parseApiDate('')).toBeNull();
  });
});

describe('chunk', () => {
  it('splits into fixed-size pieces', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('mapPool', () => {
  it('processes every item with bounded concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const seen: number[] = [];
    await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(maxActive).toBe(2);
  });
  it('stops picking new items when shouldStop returns true', async () => {
    const seen: number[] = [];
    let stop = false;
    await mapPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        seen.push(n);
        if (n === 2) stop = true;
      },
      () => stop,
    );
    expect(seen).toEqual([1, 2]);
  });
});
