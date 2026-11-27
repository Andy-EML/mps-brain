import { describe, expect, it } from 'vitest';
import { dedupeDeliveries, deliveryColour, deliveryFitDates, effectiveTonerLevel, isDeliveryAlarm } from './toner-delivery';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('deliveryColour', () => {
  it('reads Toner Delivery(X) and Waste Toner Bottle Delivery', () => {
    expect(deliveryColour('Toner Delivery(BK)')).toBe('black');
    expect(deliveryColour('Toner Delivery(K)')).toBe('black');
    expect(deliveryColour('Toner Delivery(C)')).toBe('cyan');
    expect(deliveryColour('Toner Delivery(M)')).toBe('magenta');
    expect(deliveryColour('Toner Delivery(Y)')).toBe('yellow');
    expect(deliveryColour('Waste Toner Bottle Delivery')).toBe('waste');
  });
  it('is null for anything else', () => {
    expect(deliveryColour('Toner Empty(K)')).toBeNull();
    expect(deliveryColour('Toner Near Empty(K)')).toBeNull();
    expect(deliveryColour('Waste Toner Bottle Full')).toBeNull();
    expect(deliveryColour('Toner Delivery')).toBeNull();
    expect(deliveryColour(null)).toBeNull();
    expect(isDeliveryAlarm('Toner Delivery(Y)')).toBe(true);
  });
});

describe('effectiveTonerLevel', () => {
  it('is 100% when the Delivery is newer than the reading', () => {
    expect(effectiveTonerLevel({ level: 8, readAt: d('2026-11-20'), deliveryAt: d('2026-11-21') })).toEqual({
      level: 100,
      newCartridgeAt: d('2026-11-21'),
    });
  });
  it('is 100% when there is a Delivery but no reading at all', () => {
    expect(effectiveTonerLevel({ level: null, readAt: null, deliveryAt: d('2026-11-21') }).level).toBe(100);
  });
  it('keeps the reading when it is newer than, or the same time as, the Delivery', () => {
    expect(effectiveTonerLevel({ level: 8, readAt: d('2026-11-22'), deliveryAt: d('2026-11-21') })).toEqual({ level: 8, newCartridgeAt: null });
    expect(effectiveTonerLevel({ level: 8, readAt: d('2026-11-21'), deliveryAt: d('2026-11-21') }).level).toBe(8);
  });
  it('keeps the reading when there is no Delivery', () => {
    expect(effectiveTonerLevel({ level: 42, readAt: d('2026-11-20'), deliveryAt: null })).toEqual({ level: 42, newCartridgeAt: null });
    expect(effectiveTonerLevel({ level: null, readAt: null, deliveryAt: null }).level).toBeNull();
  });
});

describe('dedupeDeliveries', () => {
  it('keeps one Delivery per cartridge change', () => {
    const r = dedupeDeliveries([d('2026-11-05'), d('2026-11-01'), d('2026-11-02'), d('2026-11-20')]);
    expect(r).toEqual([d('2026-11-01'), d('2026-11-05'), d('2026-11-20')]);
  });
});

describe('deliveryFitDates', () => {
  it('is the first Delivery on or after the order date and before the next order', () => {
    const orders = [d('2026-10-01'), d('2026-11-01')];
    const fits = deliveryFitDates(orders, [d('2026-10-04'), d('2026-10-05'), d('2026-11-03')]);
    expect(fits).toEqual([d('2026-10-04'), d('2026-11-03')]);
  });
  it('is null when no Delivery falls in the order window (a Delivery after the next order is that one)', () => {
    expect(deliveryFitDates([d('2026-10-01'), d('2026-11-01')], [d('2026-11-03')])).toEqual([null, d('2026-11-03')]);
  });
  it('ignores a Delivery before the first order and gives null without Deliveries', () => {
    expect(deliveryFitDates([d('2026-10-01')], [d('2026-09-01')])).toEqual([null]);
    expect(deliveryFitDates([d('2026-10-01')], [])).toEqual([null]);
  });
  it('gives orders on the same date the same fit', () => {
    const o = d('2026-10-01');
    expect(deliveryFitDates([o, o], [d('2026-10-02')])).toEqual([d('2026-10-02'), d('2026-10-02')]);
  });
});
