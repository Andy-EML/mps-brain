import { describe, expect, it } from 'vitest';
import { deviceDisplayName, deviceNameAddsInfo } from './device-name';

describe('deviceNameAddsInfo', () => {
  it('is false when there is no name to show', () => {
    expect(deviceNameAddsInfo(null, 'bizhub C3351i')).toBe(false);
    expect(deviceNameAddsInfo('   ', 'bizhub C3351i')).toBe(false);
  });

  it('is true when there is a name but no model to compare it against', () => {
    expect(deviceNameAddsInfo('Reception', null)).toBe(true);
  });

  it('is false when the name is just the model with a version suffix', () => {
    expect(deviceNameAddsInfo('ineo+458_Ver42', 'ineo+458')).toBe(false);
    expect(deviceNameAddsInfo('ineo+458Ver2', 'ineo+458')).toBe(false);
  });

  it('is false when the name and the model are the same thing punctuated differently', () => {
    expect(deviceNameAddsInfo('bizhub C3351i', 'bizhub-C3351i')).toBe(false);
    expect(deviceNameAddsInfo('BIZHUB C3351I', 'bizhub C3351i')).toBe(false);
  });

  it('is false when the name is only part of the model', () => {
    expect(deviceNameAddsInfo('C3351i', 'bizhub C3351i')).toBe(false);
  });

  it('is true when the name carries a site the model does not', () => {
    expect(deviceNameAddsInfo('Little Heath School (Maths) C3351i', 'bizhub C3351i')).toBe(true);
    expect(deviceNameAddsInfo('Reception', 'bizhub C458')).toBe(true);
  });

  it('keeps a site name that wraps the whole model, which plain containment would have hidden', () => {
    expect(deviceNameAddsInfo('A-Plan (Southampton) MF3303', 'MF3303')).toBe(true);
  });

  it('only drops a trailing version suffix, not a version in the middle of a name', () => {
    expect(deviceNameAddsInfo('Ver42 Studio ineo+458', 'ineo+458')).toBe(true);
  });
});

describe('deviceDisplayName', () => {
  const base = { equipmentName: null, customerName: 'Hazell & Jefferies', model: 'bizhub C450i', serial: 'A1B2C3D4E', drmsId: 'd1' };

  it("uses DRMS's equipment Name when it says more than the model", () => {
    expect(deviceDisplayName({ ...base, equipmentName: ' Hazell & Jefferies Downstairs C450i ' })).toBe(
      'Hazell & Jefferies Downstairs C450i',
    );
  });

  it('falls back to customer and model when the Name is only the model', () => {
    expect(deviceDisplayName({ ...base, equipmentName: 'bizhub C450i_Ver22' })).toBe('Hazell & Jefferies bizhub C450i');
    expect(deviceDisplayName(base)).toBe('Hazell & Jefferies bizhub C450i');
    expect(deviceDisplayName({ ...base, customerName: null })).toBe('bizhub C450i');
  });

  it('falls back to the serial, then the DRMS id, when there is nothing else', () => {
    expect(deviceDisplayName({ ...base, customerName: null, model: null })).toBe('A1B2C3D4E');
    expect(deviceDisplayName({ ...base, customerName: ' ', model: null, serial: null })).toBe('d1');
  });
});
