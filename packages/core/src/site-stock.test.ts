import { describe, expect, it } from 'vitest';
import { countUse, siteStockUse, topUpLines, type ShelfConsumableCounts } from './site-stock';

const DAY = 86_400_000;
const T0 = new Date('2026-10-01T09:00:00Z');
const after = (days: number) => new Date(T0.getTime() + days * DAY);
const counts = (k: number, c: number, m: number, y: number, w: number): ShelfConsumableCounts => ({
  black: k,
  cyan: c,
  magenta: m,
  yellow: y,
  waste: w,
});

describe('siteStockUse', () => {
  it.each([
    ['Toner Empty(BK)', 'black'],
    ['Toner Empty(K)', 'black'],
    ['Toner Empty(M)', 'magenta'],
    ['toner empty(c)', 'cyan'],
    ['Toner Empty(Y)', 'yellow'],
    ['Toner Near Empty(K)', null],
    ['Toner Delivery(BK)', null],
    ['Waste Toner Bottle Full', 'waste'],
    ['Waste Toner Bottle Almost Full', null],
    [null, null],
  ])('%s -> %s', (description, expected) => {
    expect(siteStockUse(description as string | null)).toBe(expected);
  });
});

describe('countUse', () => {
  const base = { colour: 'black' as const, countingFrom: new Date('2026-09-01T00:00:00Z') };

  it('does not count an alarm before the counting start', () => {
    const r = countUse({ ...base, receivedAt: new Date('2026-08-31T00:00:00Z'), previous: null, levelsSincePrevious: [] });
    expect(r).toEqual({ counted: false, reason: 'before_counting_start' });
  });

  it('counts the first use', () => {
    const r = countUse({ ...base, receivedAt: T0, previous: null, levelsSincePrevious: [] });
    expect(r).toEqual({ counted: true, reason: 'first' });
  });

  it('treats a repeat 4 days later with no levels as a repeat', () => {
    const r = countUse({ ...base, receivedAt: after(4), previous: { receivedAt: T0 }, levelsSincePrevious: [] });
    expect(r).toEqual({ counted: false, reason: 'repeat' });
  });

  it('counts a repeat 4 days later when a 92% reading came between', () => {
    const r = countUse({
      ...base,
      receivedAt: after(4),
      previous: { receivedAt: T0 },
      levelsSincePrevious: [{ at: after(2), value: 92 }],
    });
    expect(r).toEqual({ counted: true, reason: 'fresh_cartridge' });
  });

  it('counts 15 days later with no levels', () => {
    const r = countUse({ ...base, receivedAt: after(15), previous: { receivedAt: T0 }, levelsSincePrevious: [] });
    expect(r).toEqual({ counted: true, reason: 'after_recount_days' });
  });

  it('does not count 15 days later when levels exist but all are below 80', () => {
    const r = countUse({
      ...base,
      receivedAt: after(15),
      previous: { receivedAt: T0 },
      levelsSincePrevious: [
        { at: after(3), value: 10 },
        { at: after(9), value: 4 },
      ],
    });
    expect(r).toEqual({ counted: false, reason: 'repeat' });
  });

  it('counts waste 15 days later and ignores levels', () => {
    const r = countUse({
      ...base,
      colour: 'waste',
      receivedAt: after(15),
      previous: { receivedAt: T0 },
      levelsSincePrevious: [{ at: after(3), value: 95 }],
    });
    expect(r).toEqual({ counted: true, reason: 'after_recount_days' });
  });

  it('does not count waste 4 days later even with a high level', () => {
    const r = countUse({
      ...base,
      colour: 'waste',
      receivedAt: after(4),
      previous: { receivedAt: T0 },
      levelsSincePrevious: [{ at: after(2), value: 95 }],
    });
    expect(r).toEqual({ counted: false, reason: 'repeat' });
  });

  it('counts at exactly 14 days', () => {
    const r = countUse({ ...base, receivedAt: after(14), previous: { receivedAt: T0 }, levelsSincePrevious: [] });
    expect(r).toEqual({ counted: true, reason: 'after_recount_days' });
  });
});

describe('topUpLines', () => {
  it('tops up every used colour once any colour is exhausted', () => {
    expect(topUpLines(counts(3, 2, 2, 2, 0), counts(3, 1, 0, 1, 0))).toEqual([
      { colour: 'black', quantity: 3 },
      { colour: 'cyan', quantity: 1 },
      { colour: 'yellow', quantity: 1 },
    ]);
  });

  it('returns nothing while every colour still has stock', () => {
    expect(topUpLines(counts(3, 2, 2, 2, 0), counts(2, 1, 0, 1, 0))).toEqual([]);
  });

  it('ignores a colour with no holding', () => {
    expect(topUpLines(counts(3, 0, 0, 0, 0), counts(3, 0, 0, 0, 0))).toEqual([{ colour: 'black', quantity: 3 }]);
    expect(topUpLines(counts(3, 0, 0, 0, 0), counts(3, 5, 0, 0, 0))).toEqual([{ colour: 'black', quantity: 3 }]);
  });

  it('caps the quantity at 20', () => {
    expect(topUpLines(counts(20, 0, 0, 0, 0), counts(25, 0, 0, 0, 0))).toEqual([{ colour: 'black', quantity: 20 }]);
  });

  it('works for a mono shelf with waste', () => {
    expect(topUpLines(counts(4, 0, 0, 0, 2), counts(1, 0, 0, 0, 2))).toEqual([
      { colour: 'black', quantity: 1 },
      { colour: 'waste', quantity: 2 },
    ]);
  });
});
