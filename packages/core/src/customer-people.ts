import { getBool, getField, getNumber, getString, parseApiDate } from './fields';

/** One Vantage `CustomerPerson` (a site contact), mapped. Text fields are trimmed; blanks are null. */
export interface CustomerPerson {
  personId: number;
  /** The `vantage_customers` id (the site) the person belongs to. */
  customerId: number;
  fullName: string | null;
  role: string | null;
  phone: string | null;
  extension: string | null;
  mobile: string | null;
  email: string | null;
  isPrimary: boolean;
  modifiedDate: Date | null;
}

function text(raw: unknown, name: string): string | null {
  const v = getString(raw, name)?.trim() ?? '';
  return v === '' ? null : v;
}

/** A `GET /customerperson` row with an Id and a CustomerId; null otherwise. Case-insensitive fields. */
export function mapCustomerPerson(raw: unknown): CustomerPerson | null {
  if (raw == null || typeof raw !== 'object') return null;
  const personId = getNumber(raw, 'Id');
  const customerId = getNumber(raw, 'CustomerId');
  if (personId === null || customerId === null) return null;
  const builtName = [text(raw, 'FirstName'), text(raw, 'LastName')].filter(Boolean).join(' ');
  return {
    personId,
    customerId,
    fullName: text(raw, 'FullName') ?? (builtName === '' ? null : builtName),
    role: text(raw, 'Role'),
    phone: text(raw, 'PhoneNumber'),
    extension: text(raw, 'PhoneNumberExtension'),
    mobile: text(raw, 'MobileNumber'),
    email: text(raw, 'EmailAddress'),
    isPrimary: getBool(raw, 'IsPrimary') === true,
    modifiedDate: parseApiDate(getField(raw, 'ModifiedDate')),
  };
}

/** Where the number shown for a customer came from. */
export type PhoneSource = 'site' | 'headOffice';

export interface ContactPhone {
  phone: string;
  source: PhoneSource;
}

/**
 * The number to show for a customer (a Vantage customer record is a site): its own `PhoneNumber`,
 * else its head office's (`HeadOfficeId`), labelled as such. A head office's own page shows its own
 * number, and a record naming itself as head office never gets the "Head office" label.
 */
export function pickContactPhone(o: {
  customerId: number;
  sitePhone: string | null | undefined;
  headOfficeId: number | null | undefined;
  headOfficePhone: string | null | undefined;
}): ContactPhone | null {
  const site = o.sitePhone?.trim() ?? '';
  if (site !== '') return { phone: site, source: 'site' };
  if (o.headOfficeId == null || o.headOfficeId === o.customerId) return null;
  const head = o.headOfficePhone?.trim() ?? '';
  return head === '' ? null : { phone: head, source: 'headOffice' };
}
