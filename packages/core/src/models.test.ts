import { describe, expect, it } from 'vitest';

import { isColourModel, isMonoModel } from './models';

describe('isColourModel', () => {
  // Every colour model seen in the fleet, one per naming shape.
  it.each([
    'bizhub C3350i',
    'bizhub C301i',
    'bizhub C4050i',
    'bizhub C751i',
    'C458',
    'C308',
    'C3351',
    'ineo+308',
    'ineo+3350i',
    'ineo+224e',
    'ineo+227',
    'ineo+551i',
  ])('treats %s as colour', (model) => {
    expect(isColourModel(model)).toBe(true);
    expect(isMonoModel(model)).toBe(false);
  });

  // Every mono model seen in the fleet. bizhub 4050i, 301i and 4701i have
  // reported counters with no CMY toner levels at all, which confirms these.
  it.each([
    'bizhub 300i',
    'bizhub 301i',
    'bizhub 4050i',
    'bizhub 4051i',
    'bizhub 4700i',
    'bizhub 4701i',
    'bizhub 751i',
    '287',
  ])('treats %s as mono', (model) => {
    expect(isColourModel(model)).toBe(false);
    expect(isMonoModel(model)).toBe(true);
  });

  it('ignores lower-case c inside range and brand names', () => {
    // 'Konica' and 'AccurioPrint' both contain a c; neither makes a device colour.
    expect(isColourModel('Konica Minolta bizhub 4050i')).toBe(false);
    expect(isColourModel('AccurioPrint 2100')).toBe(false);
  });

  it('accepts a space between the C and the model number', () => {
    expect(isColourModel('bizhub C 258')).toBe(true);
  });

  it('does not treat a trailing C-word as colour', () => {
    // A capital C must sit in front of the model number, not inside a word.
    expect(isColourModel('bizhub 227 CLASSIC')).toBe(false);
  });

  it('defaults to mono when the model name is missing', () => {
    expect(isColourModel(null)).toBe(false);
    expect(isColourModel(undefined)).toBe(false);
    expect(isColourModel('')).toBe(false);
    expect(isMonoModel(null)).toBe(true);
  });
});
