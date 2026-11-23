import { hrefWith } from './href';

/**
 * The sections a device page can be opened from, for its breadcrumb root and "Back to" link. The
 * device page gets `?from=<key>` (and optionally `?back=<the list's own URL>`), and only a key in
 * this map is believed — anything else reads as the Devices list.
 */
export const DEVICE_ORIGINS = {
  devices: { label: 'Devices', href: '/devices' },
  fleet: { label: 'Fleet overview', href: '/' },
  orders: { label: 'Toner orders', href: '/orders' },
  'toner-yield': { label: 'Toner yield', href: '/orders/yield' },
  'site-stock': { label: 'Site stock', href: '/site-stock' },
  pm: { label: 'PM due', href: '/pm' },
  reconnect: { label: 'Reconnect', href: '/reconnect' },
  registrations: { label: 'DRMS registrations', href: '/registrations' },
  alerts: { label: 'Alerts', href: '/alerts' },
  issues: { label: 'Link issues', href: '/issues' },
  customers: { label: 'Customers', href: '/customers' },
} as const satisfies Record<string, { label: string; href: string }>;

export type DeviceOriginKey = keyof typeof DEVICE_ORIGINS;

export interface DeviceOrigin {
  key: DeviceOriginKey;
  label: string;
  /** The section's URL, with the list's tab/filter/search/page when `back` carried them. */
  href: string;
}

const DEFAULT_ORIGIN: DeviceOriginKey = 'devices';

/**
 * Sub-pages a section's `back` may also name. A device opened from a customer page goes back to
 * that customer page (`/customers/42`), not just the list.
 */
const SUB_PAGES: Partial<Record<string, RegExp>> = {
  '/customers': /^\/customers\/\d{1,9}$/,
  // A device opened from a shelf page (`/site-stock/9`) goes back to that shelf.
  '/site-stock': /^\/site-stock\/\d{1,9}$/,
};

/** Far longer than any list URL we build; anything bigger is not one of ours. */
const MAX_BACK_LENGTH = 1000;

/** A throwaway origin to resolve relative paths against; never shown or followed. */
const BASE = 'http://device-origin.invalid';

function isOriginKey(value: unknown): value is DeviceOriginKey {
  return typeof value === 'string' && Object.hasOwn(DEVICE_ORIGINS, value);
}

/**
 * `back` as a same-site path + query, or null. Its pathname must be exactly one of `allowedBases`
 * (or one of that base's `SUB_PAGES`, or match one of `allowedPaths`), so a "Back" link can only ever return to a list it names —
 * no `//host`, no scheme, no backslashes, no control characters, nothing over `MAX_BACK_LENGTH`.
 * The hash is dropped.
 */
export function safeReturnPath(
  back: unknown,
  allowedBases: readonly string[],
  /** Further exact pathnames a caller allows (anchored patterns), on top of `allowedBases`. */
  allowedPaths: readonly RegExp[] = [],
): string | null {
  if (typeof back !== 'string' || back.length === 0 || back.length > MAX_BACK_LENGTH) return null;
  if (!back.startsWith('/') || back.startsWith('//') || back.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(back)) return null;
  let url: URL;
  try {
    url = new URL(back, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const allowed =
    allowedBases.some((base) => url.pathname === base || SUB_PAGES[base]?.test(url.pathname) === true) ||
    allowedPaths.some((pattern) => pattern.test(url.pathname));
  if (!allowed) return null;
  return `${url.pathname}${url.search}`;
}

/** `safeReturnPath` for one section: the device page's `back`, checked against its origin's URL. */
export function safeBackPath(back: unknown, basePath: string): string | null {
  return safeReturnPath(back, [basePath]);
}

/** The device page's `from` / `back` search params, as the section to go back to. */
export function resolveDeviceOrigin(from: unknown, back: unknown): DeviceOrigin {
  const key = isOriginKey(from) ? from : DEFAULT_ORIGIN;
  const origin = DEVICE_ORIGINS[key];
  const href = safeBackPath(back, origin.href) ?? origin.href;
  // Back to one customer's page rather than the Customers list.
  const label =
    key === 'customers' && href.startsWith('/customers/')
      ? 'Customer'
      : key === 'site-stock' && href.startsWith('/site-stock/')
        ? 'Shelf'
        : origin.label;
  return { key, label, href };
}

/**
 * A link to a device page that remembers where it was opened from. `back` is the origin list's
 * current URL (path + query) so its tab, filter, search and page survive the round trip; it is
 * left off when it adds nothing to the section's own URL, and `from` is left off for the default.
 */
export function deviceHref(drmsId: string, from: DeviceOriginKey, back?: string): string {
  const base = DEVICE_ORIGINS[from].href;
  const keptBack = back != null && back !== base ? safeBackPath(back, base) : null;
  return hrefWith(`/devices/${encodeURIComponent(drmsId)}`, {
    from: from === DEFAULT_ORIGIN && keptBack === null ? undefined : from,
    back: keptBack,
  });
}

/** The device page's own URL with the `from` / `back` it was opened with, for links that come back to it. */
export function devicePageHref(drmsId: string, origin?: { from?: string; back?: string }): string {
  return hrefWith(`/devices/${encodeURIComponent(drmsId)}`, { from: origin?.from, back: origin?.back });
}

/**
 * A posted `from` / `back` pair (a device page's form) as the device page's own query params, for
 * an action that redirects back to it: `from` only when it is a known section, `back` only when it
 * is that section's list. Whatever fails is left off, so the page falls back to the Devices list.
 */
export function deviceOriginParams(from: unknown, back: unknown): { from?: DeviceOriginKey; back?: string } {
  if (!isOriginKey(from)) return { from: undefined, back: undefined };
  return { from, back: safeBackPath(back, DEVICE_ORIGINS[from].href) ?? undefined };
}
