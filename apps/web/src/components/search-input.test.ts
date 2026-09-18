import { describe, expect, it } from 'vitest';
import { clearSearchHref } from './search-input';

describe('clearSearchHref', () => {
  it('keeps the other query parameters (e.g. the active filter tab) when clearing search', () => {
    expect(clearSearchHref('/devices', { filter: 'offline' })).toBe('/devices?filter=offline');
  });

  it('drops empty or undefined hidden params, same as the rest of the form', () => {
    expect(clearSearchHref('/devices', { filter: undefined })).toBe('/devices');
    expect(clearSearchHref('/devices', { filter: '' })).toBe('/devices');
  });

  it('falls back to the bare action when there are no hidden params at all', () => {
    expect(clearSearchHref('/devices')).toBe('/devices');
  });
});
