import { describe, expect, it } from 'vitest';
import { customerReturn, safeCustomerReturn } from './customer-return';

describe('safeCustomerReturn', () => {
  it('accepts a customer page path', () => {
    expect(safeCustomerReturn('/customers/42')).toBe('/customers/42');
  });

  it('refuses anything else', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      '/customers',
      '/customers/',
      '/customers/abc',
      '/customers/42?x=1',
      '/customers/42/edit',
      '//evil.com/customers/42',
      'https://evil.com/customers/42',
      '/customers/1234567890',
      '/site-stock/3',
    ]) {
      expect(safeCustomerReturn(bad)).toBeNull();
    }
  });
});

describe('customerReturn', () => {
  it('reads returnTo from the form', () => {
    const form = new FormData();
    expect(customerReturn(form)).toBeNull();
    form.set('returnTo', '/customers/7');
    expect(customerReturn(form)).toBe('/customers/7');
    form.set('returnTo', '/orders');
    expect(customerReturn(form)).toBeNull();
  });
});
