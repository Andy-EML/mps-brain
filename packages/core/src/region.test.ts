import { describe, expect, it } from 'vitest';
import { isEircode, postcodeArea, postcodeOutward, regionOf, resolveOtherDealer, type OtherDealerFlag } from './region';

const pc = (postCode: string | null | undefined, county: string | null | undefined = null) => regionOf({ postCode, county });

describe('regionOf', () => {
  it.each(['D04 EK2K', 'Y35 HYE0', 'A92 X7FA', 'E91 HX70', 'd04ek2k', 'D6W 1234'])('Eircode %s is Ireland', (p) => {
    expect(pc(p)).toBe('ireland');
  });
  it.each(['B46 1DA', 'W14 9EQ', 'B16 8TP'])('UK code %s with a 3-char inward part is not Ireland', (p) => {
    expect(pc(p)).toBeNull();
  });
  it.each(['BT1 1AA', 'BT48 7XX', 'bt11aa'])('Northern Ireland %s is Ireland', (p) => {
    expect(pc(p)).toBe('ireland');
  });
  it.each(['EH1 1YZ', 'G1 1AA', 'G72 0AA', 'AB10 1AA', 'ZE1 0AA', 'g11aa', 'KW1 4AA', 'HS1 2AA'])('Scottish %s is Scotland', (p) => {
    expect(pc(p)).toBe('scotland');
  });
  it.each(['GL1 1AA', 'GU14 7PR', 'GU51 1AA', 'KT1 1AA', 'PE1 1AA', 'DE1 1AA'])('English %s is neither', (p) => {
    expect(pc(p)).toBeNull();
  });
  it.each(['Co. Cork', 'Co Mayo', 'County Kerry', 'Dublin 4', 'dublin', 'Co.Clare', 'Co. Antrim', 'Co. Down', 'County Londonderry'])(
    'no postcode + county %s is Ireland',
    (c) => {
      expect(pc(null, c)).toBe('ireland');
      expect(pc('', c)).toBe('ireland');
    },
  );
  it.each(['Co. Durham', 'County Durham', 'Hampshire', '', 'Down', 'Cork'])('no postcode + county "%s" is not Ireland', (c) => {
    expect(pc(null, c)).toBeNull();
  });
  it('no postcode and no county is ours', () => {
    expect(pc(null, null)).toBeNull();
    expect(pc(undefined, undefined)).toBeNull();
  });
  it('a recognised postcode always wins over the county', () => {
    expect(pc('GU14 7PR', 'Co. Cork')).toBeNull();
    expect(pc('EH1 1YZ', 'Co. Cork')).toBe('scotland');
    expect(pc('D04 EK2K', 'Hampshire')).toBe('ireland');
  });
  it('an unparseable postcode falls back to the county', () => {
    expect(pc('???', 'Co. Cork')).toBe('ireland');
    expect(pc('???', 'Hampshire')).toBeNull();
  });
});

describe('postcode helpers', () => {
  it('postcodeOutward', () => {
    expect(postcodeOutward('gu147pr')).toBe('GU14');
    expect(postcodeOutward('gu14 7pr')).toBe('GU14');
    expect(postcodeOutward('GU14')).toBe('GU14');
    expect(postcodeOutward('W14 9EQ')).toBe('W14');
    expect(postcodeOutward('EH1 1YZ')).toBe('EH1');
    expect(postcodeOutward('G11AA')).toBe('G1');
    expect(postcodeOutward('SW1A 1AA')).toBe('SW1A');
    expect(postcodeOutward('D04 EK2K')).toBeNull();
    expect(postcodeOutward('junk')).toBeNull();
    expect(postcodeOutward('')).toBeNull();
    expect(postcodeOutward(null)).toBeNull();
    expect(postcodeOutward(undefined)).toBeNull();
  });
  it('postcodeArea', () => {
    expect(postcodeArea('gu147pr')).toBe('GU');
    expect(postcodeArea('G1 1AA')).toBe('G');
    expect(postcodeArea('D04 EK2K')).toBeNull();
    expect(postcodeArea(null)).toBeNull();
  });
  it('isEircode', () => {
    expect(isEircode('D04 EK2K')).toBe(true);
    expect(isEircode('d04ek2k')).toBe(true);
    expect(isEircode('W14 9EQ')).toBe(false);
    expect(isEircode(null)).toBe(false);
  });
});

describe('resolveOtherDealer', () => {
  const dealers = { ireland: 'MJ Flood', scotland: 'CMYK' };
  const flag = (override: OtherDealerFlag['override'], name: string | null = null): OtherDealerFlag => ({ override, name });
  const resolve = (o: Partial<Parameters<typeof resolveOtherDealer>[0]>) =>
    resolveOtherDealer({ own: null, headOffice: null, region: null, regionDealers: { ...dealers }, ...o });

  it('no flags and no region is ours', () => {
    expect(resolve({})).toEqual({ dealer: null, source: null, region: null });
  });
  it('the region rule names the regional dealer', () => {
    expect(resolve({ region: 'ireland' })).toEqual({ dealer: 'MJ Flood', source: 'region', region: 'ireland' });
    expect(resolve({ region: 'scotland' })).toEqual({ dealer: 'CMYK', source: 'region', region: 'scotland' });
  });
  it('a blank region dealer resolves to ours', () => {
    expect(resolve({ region: 'ireland', regionDealers: { ireland: null, scotland: 'CMYK' } }).dealer).toBeNull();
  });
  it('a site dealer beats a head-office ours', () => {
    expect(resolve({ own: flag('dealer', 'Acme'), headOffice: flag('ours') })).toEqual({ dealer: 'Acme', source: 'site', region: null });
  });
  it('a site ours beats a head-office dealer and the region', () => {
    expect(resolve({ own: flag('ours'), headOffice: flag('dealer', 'Acme'), region: 'ireland' })).toEqual({ dealer: null, source: 'site', region: 'ireland' });
  });
  it('a head-office dealer applies when the site has no flag, and beats the region', () => {
    expect(resolve({ headOffice: flag('dealer', 'Acme'), region: 'ireland' })).toEqual({ dealer: 'Acme', source: 'head_office', region: 'ireland' });
  });
  it('a head-office ours beats the region', () => {
    expect(resolve({ headOffice: flag('ours'), region: 'scotland' })).toEqual({ dealer: null, source: 'head_office', region: 'scotland' });
  });
  it('a flag with a null override is no flag', () => {
    expect(resolve({ own: flag(null), headOffice: flag(null), region: 'scotland' })).toEqual({ dealer: 'CMYK', source: 'region', region: 'scotland' });
  });
});
