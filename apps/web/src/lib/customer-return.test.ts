import { describe, expect, it } from 'vitest';
import { customerReturn, safeCustomerReturn } from './customer-return';

describe('safeCustomerReturn', () => {
  it('accepts a customer page path', () => {
    expect(safeCustomerReturn('/customers/42')).toBe('/customers/42');
  });

  it('keeps a back that is a Customers list view', () => {
    const back = '/customers?tab=sites&page=2';
    const page = `/customers/42?back=${encodeURIComponent(back)}`;
    expect(safeCustomerReturn(page)).toBe(page);
  });

  it('drops any other param, and a back that is not a Customers list view', () => {
    expect(safeCustomerReturn('/customers/42?x=1')).toBe('/customers/42');
    expect(safeCustomerReturn('/customers/42?back=%2Fcustomers')).toBe('/customers/42');
    expect(safeCustomerReturn('/customers/42?back=%2Fcustomers%2F7')).toBe('/customers/42');
    expect(safeCustomerReturn('/customers/42?back=https%3A%2F%2Fevil.com%2Fcustomers')).toBe('/customers/42');
    expect(safeCustomerReturn('/customers/42?back=%2Forders&settingsError=x')).toBe('/customers/42');
    expect(safeCustomerReturn('/customers/42#shelf-3')).toBe('/customers/42');
  });

  it('refuses anything that is not a customer page', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      '/customers',
      '/customers/',
      '/customers/abc',
      '/customers/42/edit',
      '//evil.com/customers/42',
      'https://evil.com/customers/42',
      '/\evil.com/customers/42',
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
    form.set('returnTo', '/customers/7?back=%2Fcustomers%3Fq%3Dacme');
    expect(customerReturn(form)).toBe('/customers/7?back=%2Fcustomers%3Fq%3Dacme');
    form.set('returnTo', '/orders');
    expect(customerReturn(form)).toBeNull();
  });
});
