import { describe, expect, it } from 'vitest';
import { mapCustomerPerson, pickContactPhone } from './customer-people';

// Field names as returned by `GET /customerperson` (checked live 2026-11-27).
const person = (extra: object = {}) => ({
  Id: 501,
  CustomerId: 55,
  Title: 'Mrs',
  FirstName: 'Jane',
  LastName: 'Smith',
  FullName: 'Jane Smith',
  Role: 'Office Manager',
  PhoneNumber: ' 01234 567890 ',
  PhoneNumberExtension: '212',
  MobileNumber: '07700 900123',
  EmailAddress: 'jane@example.com',
  IsPrimary: true,
  IsActive: true,
  ModifiedDate: '2022-02-18T11:19:22Z',
  ...extra,
});

describe('mapCustomerPerson', () => {
  it('maps the fields the contact panels show, trimmed', () => {
    expect(mapCustomerPerson(person())).toEqual({
      personId: 501,
      customerId: 55,
      fullName: 'Jane Smith',
      role: 'Office Manager',
      phone: '01234 567890',
      extension: '212',
      mobile: '07700 900123',
      email: 'jane@example.com',
      isPrimary: true,
      modifiedDate: new Date('2022-02-18T11:19:22Z'),
    });
  });

  it('reads field names case-insensitively', () => {
    expect(mapCustomerPerson({ id: 1, customerid: 2, fullname: 'A B', isprimary: false })).toMatchObject({
      personId: 1,
      customerId: 2,
      fullName: 'A B',
      isPrimary: false,
    });
  });

  it('turns blanks into nulls and IsPrimary missing into false', () => {
    const p = mapCustomerPerson(person({ Role: '  ', PhoneNumber: '', PhoneNumberExtension: null, MobileNumber: undefined, EmailAddress: ' ', IsPrimary: undefined }));
    expect(p).toMatchObject({ role: null, phone: null, extension: null, mobile: null, email: null, isPrimary: false });
  });

  it('builds the name from first and last when FullName is blank', () => {
    expect(mapCustomerPerson(person({ FullName: ' ', FirstName: ' Jo ', LastName: 'Bloggs' }))?.fullName).toBe('Jo Bloggs');
    expect(mapCustomerPerson(person({ FullName: null, FirstName: null, LastName: null }))?.fullName).toBeNull();
  });

  it('is null without an Id or a CustomerId', () => {
    expect(mapCustomerPerson(person({ Id: null }))).toBeNull();
    expect(mapCustomerPerson(person({ CustomerId: null }))).toBeNull();
    expect(mapCustomerPerson(null)).toBeNull();
    expect(mapCustomerPerson('x')).toBeNull();
  });
});

describe('pickContactPhone', () => {
  it('uses the site’s own phone when it has one', () => {
    expect(pickContactPhone({ customerId: 1, sitePhone: '01234 567890', headOfficeId: 2, headOfficePhone: '0207 000000' })).toEqual({
      phone: '01234 567890',
      source: 'site',
    });
  });

  it('falls back to the head office’s phone when the site has none', () => {
    expect(pickContactPhone({ customerId: 1, sitePhone: '  ', headOfficeId: 2, headOfficePhone: ' 0207 000000 ' })).toEqual({
      phone: '0207 000000',
      source: 'headOffice',
    });
    expect(pickContactPhone({ customerId: 1, sitePhone: null, headOfficeId: 2, headOfficePhone: '0207 000000' })?.source).toBe('headOffice');
  });

  it('is null when neither has a phone, or there is no head office', () => {
    expect(pickContactPhone({ customerId: 1, sitePhone: null, headOfficeId: 2, headOfficePhone: ' ' })).toBeNull();
    expect(pickContactPhone({ customerId: 1, sitePhone: null, headOfficeId: null, headOfficePhone: '0207 000000' })).toBeNull();
  });

  it('never labels a customer as its own head office', () => {
    expect(pickContactPhone({ customerId: 2, sitePhone: null, headOfficeId: 2, headOfficePhone: '0207 000000' })).toBeNull();
  });
});
