import { customerHref } from '../components/customers';

/**
 * The customer page (`/customers/<id>`) reuses forms whose actions normally land on their own page
 * (shelf forms → `/site-stock/<id>`, settings dialogs → `/settings/replenishment`). Those forms post
 * a hidden `returnTo`, and the action sends the user back there instead. Only a customer page path
 * is believed, so a crafted form cannot redirect anywhere else; of its query only `back` survives,
 * and only when it is a Customers list view (so the page's Back link survives a save or an error).
 */

const CUSTOMER_PAGE = /^\/customers\/(\d{1,9})$/;

/** A throwaway origin to resolve the path against; never shown or followed. */
const BASE = 'http://customer-return.invalid';

/**
 * `value` rebuilt as a customer page path (`/customers/123`, plus `?back=` when it names a
 * Customers list view), when it is one; else null.
 */
export function safeCustomerReturn(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const match = CUSTOMER_PAGE.exec(url.pathname);
  if (!match) return null;
  // customerHref keeps `back` only when it is a Customers list view that adds something.
  return customerHref(Number(match[1]), url.searchParams.get('back') ?? undefined);
}

/** The posted `returnTo`, when it names a customer page. */
export function customerReturn(formData: FormData): string | null {
  return safeCustomerReturn(formData.get('returnTo'));
}
