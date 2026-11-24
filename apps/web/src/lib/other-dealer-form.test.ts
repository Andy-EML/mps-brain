import { describe, expect, it } from 'vitest';
import { OTHER_DEALER_NAME_MAX, OtherDealerFormError, otherDealerBadgeText, parseOtherDealerForm } from './other-dealer-form';

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

describe('parseOtherDealerForm', () => {
  it('reads a dealer with its trimmed name', () => {
    expect(parseOtherDealerForm(form({ vantageCustomerId: '42', mode: 'dealer', name: '  Acme Print  ' }))).toEqual({
      vantageCustomerId: 42,
      mode: 'dealer',
      name: 'Acme Print',
    });
  });

  it('rejects dealer mode without a name', () => {
    expect(() => parseOtherDealerForm(form({ vantageCustomerId: '42', mode: 'dealer', name: '   ' }))).toThrow(OtherDealerFormError);
    expect(() => parseOtherDealerForm(form({ vantageCustomerId: '42', mode: 'dealer' }))).toThrow(/dealer’s name/);
  });

  it('rejects a name over 60 characters, accepts exactly 60', () => {
    expect(OTHER_DEALER_NAME_MAX).toBe(60);
    expect(() => parseOtherDealerForm(form({ vantageCustomerId: '42', mode: 'dealer', name: 'x'.repeat(61) }))).toThrow(/60 characters/);
    expect(parseOtherDealerForm(form({ vantageCustomerId: '42', mode: 'dealer', name: 'x'.repeat(60) })).name).toHaveLength(60);
  });

  it('default and ours ignore the name', () => {
    expect(parseOtherDealerForm(form({ vantageCustomerId: '7', mode: 'default', name: 'Acme' }))).toEqual({ vantageCustomerId: 7, mode: 'default', name: null });
    expect(parseOtherDealerForm(form({ vantageCustomerId: '7', mode: 'ours', name: 'x'.repeat(200) }))).toEqual({ vantageCustomerId: 7, mode: 'ours', name: null });
  });

  it('rejects a bad id or an unknown mode', () => {
    for (const id of ['', 'abc', '-1', '1.5', '1234567890', ' 1 2']) {
      expect(() => parseOtherDealerForm(form({ vantageCustomerId: id, mode: 'ours' }))).toThrow(/no longer exists/);
    }
    expect(() => parseOtherDealerForm(form({ vantageCustomerId: '7', mode: 'theirs' }))).toThrow(OtherDealerFormError);
    expect(() => parseOtherDealerForm(form({ vantageCustomerId: '7' }))).toThrow(OtherDealerFormError);
  });
});

describe('otherDealerBadgeText', () => {
  it('names the dealer, with where the flag came from', () => {
    expect(otherDealerBadgeText({ dealer: 'MJ Flood', source: 'site' })).toBe('Other dealer: MJ Flood');
    expect(otherDealerBadgeText({ dealer: 'Acme', source: 'head_office' })).toBe('Other dealer: Acme (head office)');
    expect(otherDealerBadgeText({ dealer: 'CMYK', source: 'region' })).toBe('Other dealer: CMYK (by region)');
  });

  it('is null when we service the site', () => {
    expect(otherDealerBadgeText({ dealer: null, source: null })).toBeNull();
    expect(otherDealerBadgeText({ dealer: null, source: 'site' })).toBeNull();
    expect(otherDealerBadgeText({ dealer: null, source: 'head_office' })).toBeNull();
  });
});
