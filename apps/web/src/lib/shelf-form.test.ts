import { describe, expect, it } from 'vitest';
import { SiteStockError } from '@mps/db/queries';
import { parseCounts, parseId, shelfErrorMessage } from './shelf-form';

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SiteStockError ? err.code : `not a SiteStockError: ${String(err)}`;
  }
  return undefined;
}

describe('parseCounts', () => {
  it('reads only the consumables the form shows; blank is 0', () => {
    expect(parseCounts(form([['holding-black', '3'], ['holding-waste', '']]), 'holding')).toEqual({ black: 3, waste: 0 });
  });

  it('caps a holding at 20 but not a used count', () => {
    expect(codeOf(() => parseCounts(form([['holding-black', '21']]), 'holding'))).toBe('bad_value');
    expect(parseCounts(form([['used-black', '21']]), 'used')).toEqual({ black: 21 });
  });

  it('refuses anything but a whole number 0 or more', () => {
    for (const bad of ['-1', '1.5', 'two', '1e2']) {
      expect(codeOf(() => parseCounts(form([['used-cyan', bad]]), 'used'))).toBe('bad_value');
    }
  });
});

describe('parseId', () => {
  it('reads a posted id and treats junk as not found', () => {
    expect(parseId(form([['shelfId', '12']]), 'shelfId', 'shelf')).toBe(12);
    expect(codeOf(() => parseId(form([['shelfId', 'x']]), 'shelfId', 'shelf'))).toBe('not_found');
    expect(codeOf(() => parseId(form([]), 'shelfId', 'shelf'))).toBe('not_found');
  });
});

describe('shelfErrorMessage', () => {
  it('looks the code up, so a crafted link cannot put its own text on the page', () => {
    expect(shelfErrorMessage('duplicate')).toBe('This customer already has a shelf for that family.');
    expect(shelfErrorMessage('<script>')).toBe('The shelf was not saved. Refresh the page and try again.');
  });
});
