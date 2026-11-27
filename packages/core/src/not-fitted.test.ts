import { describe, expect, it } from 'vitest';
import { countFits, decideHold, type HoldInput } from './not-fitted';

const d = (s: string) => new Date(`${s}T12:00:00Z`);
const lv = (s: string, value: number) => ({ at: d(s), value });

const order = (anchor: string, over: Partial<NonNullable<HoldInput['lastOrder']>> = {}) => ({
  anchor: d(anchor),
  orderDate: d(anchor),
  reference: null,
  quantity: 1,
  ...over,
});

const base = (over: Partial<HoldInput> = {}): HoldInput => ({
  colour: 'magenta',
  lastOrder: order('2026-09-22'),
  levels: [lv('2026-09-22', 3), lv('2026-09-25', 2), lv('2026-10-05', 1)],
  pagesSince: 1000,
  pagesSinceEstimated: false,
  ratedYield: 28000,
  metersStale: false,
  ...over,
});

describe('countFits', () => {
  it('counts a rise to >= RISE_LEVEL after a low reading', () => {
    expect(countFits([lv('2026-04-03', 12), lv('2026-04-04', 11), lv('2026-04-05', 55)], d('2026-04-02'))).toBe(1);
  });
  it('counts a jump of >= 30 points', () => {
    expect(countFits([lv('2026-04-03', 40), lv('2026-04-04', 75)], d('2026-04-02'))).toBe(1);
  });
  it('counts a jump spanning the anchor', () => {
    expect(countFits([lv('2026-04-01', 5), lv('2026-04-03', 95)], d('2026-04-02'))).toBe(1);
  });
  it('ignores readings that only fall', () => {
    expect(countFits([lv('2026-04-03', 60), lv('2026-04-04', 30), lv('2026-04-05', 10)], d('2026-04-02'))).toBe(0);
  });
  it('counts a staged rise 10 -> 45 -> 80 once', () => {
    expect(countFits([lv('2026-04-03', 10), lv('2026-04-04', 45), lv('2026-04-05', 80)], d('2026-04-02'))).toBe(1);
  });
  it('counts two separate fills 5 -> 95 -> 60 -> 3 -> 92 as two', () => {
    const l = [lv('2026-04-03', 5), lv('2026-04-04', 95), lv('2026-04-05', 60), lv('2026-04-06', 3), lv('2026-04-07', 92)];
    expect(countFits(l, d('2026-04-02'))).toBe(2);
  });
  it('sorts unordered readings', () => {
    expect(countFits([lv('2026-04-05', 92), lv('2026-04-03', 10)], d('2026-04-02'))).toBe(1);
  });
});

describe('decideHold with Delivery alarms', () => {
  it('does not hold when a Delivery says the cartridge was fitted, even with no level rise', () => {
    expect(decideHold(base({ deliveryFits: 1 }))).toBeNull();
  });
  it('still holds a multi-cartridge order that has fewer Deliveries than cartridges', () => {
    const r = decideHold(base({ lastOrder: order('2026-09-22', { quantity: 2 }), deliveryFits: 1 }));
    expect(r?.reason).toBe('not_fitted');
    expect(r?.detail).toContain('1 fitted since');
  });
  it('behaves as before with no Delivery', () => {
    expect(decideHold(base({ deliveryFits: 0 }))?.reason).toBe('not_fitted');
  });
});

describe('decideHold', () => {
  it('returns null without a last order', () => {
    expect(decideHold(base({ lastOrder: null }))).toBeNull();
  });

  it('Northwood: history starts after the anchor, low yield', () => {
    const r = decideHold(
      base({
        lastOrder: order('2026-04-02'),
        levels: [lv('2026-09-20', 1), lv('2026-09-21', 0)],
        pagesSince: 8220,
        pagesSinceEstimated: true,
      }),
    );
    expect(r).toEqual({
      reason: 'low_yield',
      detail: '~8,220 pages since magenta sent 2 Apr 2026 (29% of 28,000) — April cartridge probably not fitted',
    });
  });

  it('low_yield with quantity > 1 uses plural and total', () => {
    const r = decideHold(
      base({
        lastOrder: order('2026-04-02', { quantity: 2 }),
        levels: [lv('2026-09-20', 1)],
        pagesSince: 8220,
      }),
    );
    expect(r?.detail).toBe(
      '8,220 pages since 2 magenta sent 2 Apr 2026 (15% of 56,000) — April cartridges probably not fitted',
    );
  });

  it('history spans the anchor and level never recovered: not_fitted', () => {
    const r = decideHold(base());
    expect(r).toEqual({
      reason: 'not_fitted',
      detail: 'Magenta sent 22 Sep 2026, no new cartridge seen since — spare should be on site',
    });
  });

  it('includes the reference when present', () => {
    const r = decideHold(base({ lastOrder: order('2026-09-22', { reference: 'SO123' }) }));
    expect(r?.detail).toBe('Magenta sent 22 Sep 2026 (SO123), no new cartridge seen since — spare should be on site');
  });

  it('spanning history but pages since >= rated yield: released', () => {
    expect(decideHold(base({ pagesSince: 28000 }))).toBeNull();
  });

  it('released when level rises 10 -> 92 after the anchor', () => {
    expect(decideHold(base({ levels: [lv('2026-09-22', 10), lv('2026-09-25', 92)] }))).toBeNull();
  });

  it('released on a 35 point jump (40 -> 75)', () => {
    expect(decideHold(base({ levels: [lv('2026-09-22', 40), lv('2026-09-25', 75)] }))).toBeNull();
  });

  it('released when low 12 then 55 three readings later', () => {
    expect(
      decideHold(
        base({
          levels: [lv('2026-09-22', 20), lv('2026-09-23', 12), lv('2026-09-24', 20), lv('2026-09-25', 30), lv('2026-09-26', 55)],
        }),
      ),
    ).toBeNull();
  });

  it('released on a jump spanning the anchor (5 before, 95 after)', () => {
    expect(decideHold(base({ levels: [lv('2026-09-20', 5), lv('2026-09-25', 95)] }))).toBeNull();
  });

  it('quantity 3 with one fit says 2 spares should be on site', () => {
    const o = order('2026-09-22', { quantity: 3 });
    const r = decideHold(base({ lastOrder: o, levels: [lv('2026-09-22', 5), lv('2026-09-25', 95), lv('2026-10-20', 40)] }));
    expect(r?.detail).toBe('3 magenta sent 22 Sep 2026, 1 fitted since — 2 spares should be on site');
  });

  it('quantity 2 with one fit is held, two fits released', () => {
    const o = order('2026-09-22', { quantity: 2 });
    const one = [lv('2026-09-22', 5), lv('2026-09-25', 95), lv('2026-10-20', 40)];
    const r = decideHold(base({ lastOrder: o, levels: one }));
    expect(r).toEqual({
      reason: 'not_fitted',
      detail: '2 magenta sent 22 Sep 2026, 1 fitted since — spare should be on site',
    });
    const two = [...one, lv('2026-10-25', 8), lv('2026-11-02', 90)];
    expect(decideHold(base({ lastOrder: o, levels: two }))).toBeNull();
  });

  it('pages 15,000 of 28,000 with history after the anchor: released', () => {
    expect(
      decideHold(base({ lastOrder: order('2026-04-02'), levels: [lv('2026-09-20', 1)], pagesSince: 15000 })),
    ).toBeNull();
  });

  it('stale meters: no low_yield hold', () => {
    expect(
      decideHold(base({ lastOrder: order('2026-04-02'), levels: [lv('2026-09-20', 1)], pagesSince: 8220, metersStale: true })),
    ).toBeNull();
  });

  it('ratedYield null: no low_yield hold', () => {
    expect(
      decideHold(base({ lastOrder: order('2026-04-02'), levels: [lv('2026-09-20', 1)], pagesSince: 8220, ratedYield: null })),
    ).toBeNull();
  });

  it('pagesSince null (meter reset): no low_yield hold', () => {
    expect(
      decideHold(base({ lastOrder: order('2026-04-02'), levels: [lv('2026-09-20', 1)], pagesSince: null })),
    ).toBeNull();
  });

  it('not_fitted with quantity > 1 and a reference', () => {
    const r = decideHold(base({ lastOrder: order('2026-09-22', { quantity: 2, reference: 'SO9' }) }));
    expect(r?.detail).toBe('2 magenta sent 22 Sep 2026 (SO9), 0 fitted since — 2 spares should be on site');
  });

  it('formats a BST month-edge date in Europe/London', () => {
    const r = decideHold(
      base({ lastOrder: { anchor: new Date('2026-04-30T23:30:00Z'), orderDate: new Date('2026-04-30T23:30:00Z'), reference: null, quantity: 1 }, levels: [{ at: new Date('2026-04-30T23:30:00Z'), value: 3 }] }),
    );
    expect(r?.detail).toBe('Magenta sent 1 May 2026, no new cartridge seen since — spare should be on site');
  });

  it('pages just under the safety net is still held', () => {
    expect(decideHold(base({ pagesSince: 27999 }))?.reason).toBe('not_fitted');
  });

  it('spanning history with null ratedYield or null pagesSince is still not_fitted', () => {
    expect(decideHold(base({ ratedYield: null }))?.reason).toBe('not_fitted');
    expect(decideHold(base({ pagesSince: null }))?.reason).toBe('not_fitted');
  });
});
