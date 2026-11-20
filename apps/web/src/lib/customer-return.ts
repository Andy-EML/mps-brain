/**
 * The customer page (`/customers/<id>`) reuses forms whose actions normally land on their own page
 * (shelf forms → `/site-stock/<id>`, settings dialogs → `/settings/replenishment`). Those forms post
 * a hidden `returnTo`, and the action sends the user back there instead. Only a customer page path
 * is believed, so a crafted form cannot redirect anywhere else.
 */

const CUSTOMER_PAGE = /^\/customers\/\d{1,9}$/;

/** `value` when it is exactly a customer page path (`/customers/123`), else null. */
export function safeCustomerReturn(value: unknown): string | null {
  return typeof value === 'string' && CUSTOMER_PAGE.test(value) ? value : null;
}

/** The posted `returnTo`, when it names a customer page. */
export function customerReturn(formData: FormData): string | null {
  return safeCustomerReturn(formData.get('returnTo'));
}

