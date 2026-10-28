import { describe, expect, it } from 'vitest';
import { deviceFilterParams, hasDeviceFilters, parseDeviceFilters } from './device-filters';

const from = (params: Record<string, string>) => (key: string) => params[key];

describe('parseDeviceFilters', () => {
  it('reads every filter', () => {
    expect(
      parseDeviceFilters(from({ customer: ' Acme Ltd ', colour: 'mono', model: 'bizhub 4050i', replenish: 'site-stock' })),
    ).toEqual({ customer: 'Acme Ltd', colour: 'mono', model: 'bizhub 4050i', replenish: 'site-stock' });
  });

  it('drops unknown choices, blanks and over-long names', () => {
    expect(
      parseDeviceFilters(from({ customer: '   ', colour: 'purple', model: 'x'.repeat(201), replenish: 'urgent' })),
    ).toEqual({ customer: undefined, colour: undefined, model: undefined, replenish: undefined });
  });
});

describe('deviceFilterParams / hasDeviceFilters', () => {
  it('round-trips through URL params', () => {
    const f = parseDeviceFilters(from({ colour: 'colour', replenish: 'auto-off' }));
    const params = deviceFilterParams(f);
    expect(params).toEqual({ customer: undefined, colour: 'colour', model: undefined, replenish: 'auto-off' });
    expect(parseDeviceFilters((k) => params[k])).toEqual(f);
  });

  it('says whether any filter is set', () => {
    expect(hasDeviceFilters(parseDeviceFilters(from({})))).toBe(false);
    expect(hasDeviceFilters(parseDeviceFilters(from({ model: 'bizhub C300i' })))).toBe(true);
  });
});
