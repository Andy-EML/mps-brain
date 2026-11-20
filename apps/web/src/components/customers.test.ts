import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_TABS,
  customerHref,
  customerStockBadge,
  parseCustomerSearchParams,
  selfManagedPreviewText,
} from './customers';

describe('parseCustomerSearchParams', () => {
  it('defaults to the With machines tab, no search, page 1', () => {
    expect(parseCustomerSearchParams({})).toEqual({ tab: 'with-machines', search: '', page: 1 });
  });

  it('keeps every known tab', () => {
    for (const tab of ['with-machines', 'self-managed', 'head-offices', 'all'] as const) {
      expect(parseCustomerSearchParams({ tab }).tab).toBe(tab);
    }
  });

  it('falls back to With machines for an unknown or repeated-garbage tab', () => {
    expect(parseCustomerSearchParams({ tab: 'nope' }).tab).toBe('with-machines');
    expect(parseCustomerSearchParams({ tab: '' }).tab).toBe('with-machines');
    expect(parseCustomerSearchParams({ tab: 'constructor' }).tab).toBe('with-machines');
  });

  it('takes the first value of a repeated param', () => {
    expect(parseCustomerSearchParams({ tab: ['all', 'self-managed'], search: ['howd', 'x'], page: ['3', '9'] })).toEqual({
      tab: 'all',
      search: 'howd',
      page: 3,
    });
  });

  it('trims the search', () => {
    expect(parseCustomerSearchParams({ search: '  Howden  ' }).search).toBe('Howden');
    expect(parseCustomerSearchParams({ search: '   ' }).search).toBe('');
  });

  it('clamps the page to a whole number of at least 1', () => {
    expect(parseCustomerSearchParams({ page: '0' }).page).toBe(1);
    expect(parseCustomerSearchParams({ page: '-4' }).page).toBe(1);
    expect(parseCustomerSearchParams({ page: 'abc' }).page).toBe(1);
    expect(parseCustomerSearchParams({ page: '2.7' }).page).toBe(2);
    expect(parseCustomerSearchParams({ page: '12' }).page).toBe(12);
  });
});

describe('CUSTOMER_TABS', () => {
  it('lists the four tabs in order', () => {
    expect(CUSTOMER_TABS.map((t) => t.value)).toEqual(['with-machines', 'self-managed', 'head-offices', 'all']);
    expect(CUSTOMER_TABS.map((t) => t.label)).toEqual(['With machines', 'Self-managed', 'Head offices', 'All']);
  });
});

describe('customerStockBadge', () => {
  it('says Self-managed for the customer’s own flag', () => {
    expect(customerStockBadge('site')).toEqual({ text: 'Self-managed', tone: 'warn' });
  });
  it('says it comes via the head office when the head office has the flag', () => {
    expect(customerStockBadge('head_office')).toEqual({ text: 'Self-managed via head office', tone: 'warn' });
  });
  it('is Dealer otherwise', () => {
    expect(customerStockBadge(null)).toEqual({ text: 'Dealer', tone: 'muted' });
  });
});

describe('customerHref', () => {
  it('is the customer page by Vantage id', () => {
    expect(customerHref(1234)).toBe('/customers/1234');
  });
});

describe('selfManagedPreviewText', () => {
  it('says what turning it on clears', () => {
    expect(selfManagedPreviewText({ pending: 3, devices: 2, sites: 2 })).toBe(
      'Clears 3 pending proposals on 2 machines across 2 sites.',
    );
    expect(selfManagedPreviewText({ pending: 1, devices: 1, sites: 1 })).toBe('Clears 1 pending proposal on 1 machine.');
    expect(selfManagedPreviewText({ pending: 0, devices: 0, sites: 0 })).toBe('No pending proposals to clear.');
  });
});
