import { describe, expect, it } from 'vitest';
import { countyFor } from './county';

describe('countyFor', () => {
  it('uses the two-tier county when postcodes.io gives one', () => {
    expect(countyFor('Hampshire', 'Rushmoor')).toBe('Hampshire');
    expect(countyFor(' Surrey ', 'Guildford')).toBe('Surrey');
  });

  it.each([
    ['West Berkshire', 'Berkshire'],
    ['Slough', 'Berkshire'],
    ['Wokingham', 'Berkshire'],
    ['Southampton', 'Hampshire'],
    ['Swindon', 'Wiltshire'],
    ['Milton Keynes', 'Buckinghamshire'],
    ['Bournemouth, Christchurch and Poole', 'Dorset'],
    ['Birmingham', 'West Midlands'],
    ['Bolton', 'Greater Manchester'],
    ['Westminster', 'Greater London'],
    ['City of London', 'Greater London'],
    ['Bristol, City of', 'Bristol'],
    ['Herefordshire, County of', 'Herefordshire'],
    ['Brighton and Hove', 'East Sussex'],
    ['York', 'North Yorkshire'],
  ])('maps the unitary / metropolitan / London authority %s to %s', (lad, county) => {
    expect(countyFor(null, lad)).toBe(county);
  });

  it('keeps the authority name when it is not in the map (Wales, Scotland, unitary counties)', () => {
    expect(countyFor(null, 'Cardiff')).toBe('Cardiff');
    expect(countyFor(null, 'Wiltshire')).toBe('Wiltshire');
    expect(countyFor(null, 'Cornwall')).toBe('Cornwall');
  });

  it('gives null when neither is known', () => {
    expect(countyFor(null, null)).toBeNull();
    expect(countyFor('  ', '')).toBeNull();
  });
});
