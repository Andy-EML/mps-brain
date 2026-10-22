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
  'site-stock': { label: 'Site stock', href: '/site-stock' },
  reconnect: { label: 'Reconnect', href: '/reconnect' },
  registrations: { label: 'DRMS registrations', href: '/registrations' },
  alerts: { label: 'Alerts', href: '/alerts' },
  issues: { label: 'Link issues', href: '/issues' },
} as const satisfies Record<string, { label: string; href: string }>;

export type DeviceOriginKey = keyof typeof DEVICE_ORIGINS;

export interface DeviceOrigin {
  key: DeviceOriginKey;
  label: string;
  /** The section's URL, with the list's tab/filter/search/page when `back` carried them. */
  href: string;
}

const DEFAULT_ORIGIN: DeviceOriginKey = 'devices';

/** Far longer than any list URL we build; anything bigger is not one of ours. */
const MAX_BACK_LENGTH = 1000;

/** A throwaway origin to resolve relative paths against; never shown or followed. */
const BASE = 'http://device-origin.invalid';

function isOriginKey(value: unknown): value is DeviceOriginKey {
  return typeof value === 'string' && Object.hasOwn(DEVICE_ORIGINS, value);
}

/**
 * `back` as a same-site path + query, or null. It must be a relative path to exactly `basePath`
 * (the origin section itself, not a sub-page or another section), so the "Back" link can only
 * ever return to the list it names — no `//host`, no scheme, no backslashes, no control
 * characters. The hash is dropped.
 */
export function safeBackPath(back: unknown, basePath: string): string | null {
  if (typeof back !== 'string' || back.length === 0 || back.length > MAX_BACK_LENGTH) return null;
  if (!back.startsWith('/') || back.startsWith('//') || back.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(back)) return null;
  let url: URL;
  try {
    url = new URL(back, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE || url.pathname !== basePath) return null;
  return `${url.pathname}${url.search}`;
}

/** The device page's `from` / `back` search params, as the section to go back to. */
export function resolveDeviceOrigin(from: unknown, back: unknown): DeviceOrigin {
  const key = isOriginKey(from) ? from : DEFAULT_ORIGIN;
  const origin = DEVICE_ORIGINS[key];
  return { key, label: origin.label, href: safeBackPath(back, origin.href) ?? origin.href };
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
