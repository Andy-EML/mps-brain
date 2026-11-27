import { describe, expect, it } from 'vitest';
import { classifyPart, parsePartsAlarm, partLifeKey } from './parts';

describe('classifyPart', () => {
  it('reads a black IU part code', () => {
    expect(classifyPart('IUP35K - Black IU C3350i', true)).toEqual({ part: 'drum', colours: ['K'] });
  });
  it('treats Colour / CMY drums as C, M, Y', () => {
    expect(classifyPart('DD Colour Drum MF254/MF284', true)).toEqual({ part: 'drum', colours: ['C', 'M', 'Y'] });
    expect(classifyPart('Katun C450/550/650i CMY Drum Unit', true)).toEqual({ part: 'drum', colours: ['C', 'M', 'Y'] });
    expect(classifyPart('Drum Unit C,M,Y', true)).toEqual({ part: 'drum', colours: ['C', 'M', 'Y'] });
  });
  it('reads a developer', () => {
    expect(classifyPart('Konica C450i/550i/650i Black Developing Unit', true)).toEqual({ part: 'developer', colours: ['K'] });
    expect(classifyPart('Yellow Developer Unit', true)).toEqual({ part: 'developer', colours: ['Y'] });
  });
  it('is black on a mono machine, unknown on a colour machine with no colour word', () => {
    expect(classifyPart('Drum Unit 4050i', false)).toEqual({ part: 'drum', colours: ['K'] });
    expect(classifyPart('Developing Unit', true)).toEqual({ part: 'developer', colours: [] });
  });
  it('finds transfer belt / unit, roller and fuser', () => {
    expect(classifyPart('C250i/300i/450i Transfer Belt', true)).toEqual({ part: 'transfer_belt', colours: [] });
    expect(classifyPart('MF3301 / MF3801 Transfer Unit', true)).toEqual({ part: 'transfer_belt', colours: [] });
    expect(classifyPart('2nd Transfer Roller Unit', true)).toEqual({ part: 'transfer_roller', colours: [] });
    expect(classifyPart('Konica C3350i/C4050i Fuser Unit', true)).toEqual({ part: 'fuser', colours: [] });
  });
  it('treats a transfer unit on a mono machine as a transfer roller', () => {
    expect(classifyPart('MF3301 / MF3801 Transfer Unit', false)).toEqual({ part: 'transfer_roller', colours: [] });
  });
  it('classifies bare KM part codes', () => {
    expect(classifyPart('DR-313', false)).toEqual({ part: 'drum', colours: ['K'] });
    expect(classifyPart('DR-316K', true)).toEqual({ part: 'drum', colours: ['K'] });
    expect(classifyPart('DV-318Y', true)).toEqual({ part: 'developer', colours: ['Y'] });
    expect(classifyPart('DV-313', true)).toEqual({ part: 'developer', colours: [] });
    expect(classifyPart('IUP-35K', true)).toEqual({ part: 'drum', colours: ['K'] });
  });
  it('excludes lookalikes', () => {
    expect(classifyPart('Pick up roller C3350i', true)).toBeNull();
    expect(classifyPart('Separation roller', true)).toBeNull();
    expect(classifyPart('DF sep roller', true)).toBeNull();
    expect(classifyPart('IU Chip Black', true)).toBeNull();
    expect(classifyPart('Drum cleaning blade', true)).toBeNull();
    expect(classifyPart('Black toner TN-328K', true)).toBeNull();
    expect(classifyPart('', true)).toBeNull();
  });
});

describe('parsePartsAlarm', () => {
  it('parses levels', () => {
    expect(parsePartsAlarm('PartsLife(IU_K) 1st Call')).toEqual({ part: 'drum', colour: 'K', level: 'near_end' });
    expect(parsePartsAlarm('TP-01 PartsLife(IU_M) 2nd Call')).toEqual({ part: 'drum', colour: 'M', level: 'end' });
    expect(parsePartsAlarm('PartsLifePrediction(DC_Y) 1st Call')).toEqual({ part: 'developer', colour: 'Y', level: 'predicted' });
  });
  it('parses machine parts', () => {
    expect(parsePartsAlarm('PartsLife(Transfer belt unit) 2nd Call')).toEqual({ part: 'transfer_belt', colour: null, level: 'end' });
    expect(parsePartsAlarm('PartsLife(Transfer roller unit) 1st Call')).toEqual({ part: 'transfer_roller', colour: null, level: 'near_end' });
    expect(parsePartsAlarm('PartsLife(Fusing unit) 1st Call')).toEqual({ part: 'fuser', colour: null, level: 'near_end' });
  });
  it('ignores other alarms', () => {
    expect(parsePartsAlarm('TZ-04 Missing:(Parts Missing Drum (K))')).toBeNull();
    expect(parsePartsAlarm('PM Warning(PM Count)')).toBeNull();
    expect(parsePartsAlarm(null)).toBeNull();
  });
});

describe('partLifeKey', () => {
  it('maps part and colour to a rated-life key', () => {
    expect(partLifeKey('drum', 'K')).toBe('drumK');
    expect(partLifeKey('drum', 'C')).toBe('drumCmy');
    expect(partLifeKey('developer', 'Y')).toBe('developerCmy');
    expect(partLifeKey('fuser', null)).toBe('fuser');
  });
});
