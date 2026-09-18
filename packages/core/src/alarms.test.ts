import { describe, expect, it } from 'vitest';
import { classifyAlarm } from './alarms';

describe('classifyAlarm', () => {
  const cases: [string, ReturnType<typeof classifyAlarm>][] = [
    ['TN-00', 'toner'],
    ['TS-00', 'toner'],
    ['TO-00', 'waste'],
    ['TR-00', 'waste'],
    ['TP-00', 'parts'],
    ['TP-01', 'parts'],
    ['TQ-10 PartsLife(DC_K)', 'parts'],
    ['SC-00', 'service'],
    ['SR-00', 'service'],
    ['TV-00', 'service'],
    ['JF-00', 'jam'],
    ['JF-01', 'jam'],
    ['FW-00', 'jam'],
    ['FW-01', 'jam'],
    ['FW-02', 'jam'],
    ['FW-03', 'jam'],
    ['FW-04', 'jam'],
    ['09-1156', 'other'],
  ];

  it.each(cases)('classifies %s as %s', (fcCode, expected) => {
    expect(classifyAlarm(fcCode, 'irrelevant description')).toBe(expected);
  });

  it('is case-insensitive on the fc code prefix', () => {
    expect(classifyAlarm('tn-00', null)).toBe('toner');
  });

  it('falls back to other for null/undefined/empty fcCode', () => {
    expect(classifyAlarm(null, null)).toBe('other');
    expect(classifyAlarm(undefined, undefined)).toBe('other');
    expect(classifyAlarm('', '')).toBe('other');
  });

  it('falls back to a two-letter prefix in the description when fcCode is missing', () => {
    expect(classifyAlarm(null, 'PartsLife(IU_M) 2nd Call (TP-01)')).toBe('other');
    expect(classifyAlarm(null, 'TP-01 PartsLife(IU_M) 2nd Call')).toBe('parts');
  });
});
