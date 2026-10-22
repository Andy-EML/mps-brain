import { describe, expect, it } from 'vitest';
import type { ShelfConsumableCounts } from '@mps/core';
import { coveredColours, coveredColoursText, eventAlarmText, eventOutcome, pillState, shelfColours, shelfPills, shelfStatus } from './shelf';

const zero: ShelfConsumableCounts = { black: 0, cyan: 0, magenta: 0, yellow: 0, waste: 0 };
const counts = (c: Partial<ShelfConsumableCounts>): ShelfConsumableCounts => ({ ...zero, ...c });

describe('pillState', () => {
  it('is full once used reaches a holding above 0', () => {
    expect(pillState(3, 3)).toBe('full');
    expect(pillState(2, 5)).toBe('full');
  });
  it('is holding while spares are left', () => {
    expect(pillState(3, 0)).toBe('holding');
    expect(pillState(3, 2)).toBe('holding');
  });
  it('is not held when the holding is 0, whatever the used count', () => {
    expect(pillState(0, 0)).toBe('not_held');
    expect(pillState(0, 2)).toBe('not_held');
  });
});

describe('shelfColours', () => {
  it('is every consumable for a colour family and black + waste for mono', () => {
    expect(shelfColours(true)).toEqual(['black', 'cyan', 'magenta', 'yellow', 'waste']);
    expect(shelfColours(false)).toEqual(['black', 'waste']);
  });
});

describe('shelfPills', () => {
  it('matches the mockup: K full, the rest holding, waste dropped when not held', () => {
    const pills = shelfPills({
      isColour: true,
      holding: counts({ black: 3, cyan: 2, magenta: 2, yellow: 2 }),
      used: counts({ black: 3, cyan: 1, yellow: 1 }),
    });
    expect(pills.map((p) => [p.colour, p.text, p.state])).toEqual([
      ['black', 'K 3/3', 'full'],
      ['cyan', 'C 1/2', 'holding'],
      ['magenta', 'M 0/2', 'holding'],
      ['yellow', 'Y 1/2', 'holding'],
    ]);
    expect(pills[0]!.label).toBe('Black: 3 of 3 spares used, last one in');
    expect(pills[1]!.label).toBe('Cyan: 1 of 2 spares used');
  });

  it('keeps a consumable that is not held but has a used count, so a correction is visible', () => {
    const pills = shelfPills({ isColour: true, holding: counts({ black: 1 }), used: counts({ waste: 1 }) });
    expect(pills.map((p) => [p.colour, p.state])).toEqual([
      ['black', 'holding'],
      ['waste', 'not_held'],
    ]);
  });

  it('never shows cyan, magenta or yellow for a mono family', () => {
    const pills = shelfPills({ isColour: false, holding: counts({ black: 2, cyan: 1, waste: 1 }), used: counts({ magenta: 1 }) });
    expect(pills.map((p) => p.colour)).toEqual(['black', 'waste']);
    expect(pills[1]!.text).toBe('W 0/1');
  });

  it('is empty when nothing is held or used', () => {
    expect(shelfPills({ isColour: true, holding: zero, used: zero })).toEqual([]);
  });
});

describe('shelfStatus', () => {
  it('reads Top-up proposed while a top-up is live, Holding otherwise', () => {
    expect(shelfStatus(true)).toEqual({ text: 'Top-up proposed', tone: 'critical' });
    expect(shelfStatus(false)).toEqual({ text: 'Holding', tone: 'ok' });
  });
});

describe('coveredColours', () => {
  it('is the carried consumables with a holding above 0, in order', () => {
    expect(coveredColours(true, counts({ waste: 1, black: 2 }))).toEqual(['black', 'waste']);
    expect(coveredColours(false, counts({ black: 1, cyan: 3 }))).toEqual(['black']);
    expect(coveredColours(true, zero)).toEqual([]);
  });

  it('reads as a plain list', () => {
    expect(coveredColoursText([])).toBe('');
    expect(coveredColoursText(['black'])).toBe('black');
    expect(coveredColoursText(['black', 'waste'])).toBe('black and waste toner');
    expect(coveredColoursText(['black', 'cyan', 'magenta', 'yellow'])).toBe('black, cyan, magenta and yellow');
  });
});

describe('eventOutcome', () => {
  it('says why an Empty did or did not count, in plain words', () => {
    expect(eventOutcome({ counted: false, reason: 'repeat' })).toBe('repeat, not counted');
    expect(eventOutcome({ counted: false, reason: 'before_counting_start' })).toBe('before this shelf existed, not counted');
    expect(eventOutcome({ counted: true, reason: 'first' })).toBe('counted, first one from this machine');
    expect(eventOutcome({ counted: true, reason: 'fresh_cartridge' })).toBe('counted, a fresh cartridge went in since the last');
    expect(eventOutcome({ counted: true, reason: 'after_recount_days' })).toBe('counted, more than 14 days since the last');
  });

  it('falls back on counted / not counted for a reason it does not know', () => {
    expect(eventOutcome({ counted: true, reason: 'manual' })).toBe('counted');
    expect(eventOutcome({ counted: false, reason: 'something' })).toBe('not counted');
  });
});

describe('eventAlarmText', () => {
  it('names the alarm from its consumable', () => {
    expect(eventAlarmText('black')).toBe('Toner Empty (black)');
    expect(eventAlarmText('waste')).toBe('Waste toner bottle full');
    expect(eventAlarmText(null)).toBe('Alarm');
  });
});
