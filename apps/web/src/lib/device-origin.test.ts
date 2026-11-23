import { describe, expect, it } from 'vitest';
import { deviceHref, devicePageHref, resolveDeviceOrigin, safeBackPath, safeReturnPath, deviceOriginParams } from './device-origin';

describe('resolveDeviceOrigin', () => {
  it('defaults to the Devices list when there is no from', () => {
    expect(resolveDeviceOrigin(undefined, undefined)).toEqual({ key: 'devices', label: 'Devices', href: '/devices' });
  });

  it('maps every known key to its section', () => {
    expect(resolveDeviceOrigin('orders', undefined)).toEqual({ key: 'orders', label: 'Toner orders', href: '/orders' });
    expect(resolveDeviceOrigin('fleet', undefined).href).toBe('/');
    expect(resolveDeviceOrigin('fleet', undefined).label).toBe('Fleet overview');
    expect(resolveDeviceOrigin('reconnect', undefined).href).toBe('/reconnect');
    expect(resolveDeviceOrigin('registrations', undefined).label).toBe('DRMS registrations');
    expect(resolveDeviceOrigin('alerts', undefined).href).toBe('/alerts');
    expect(resolveDeviceOrigin('issues', undefined).label).toBe('Link issues');
    expect(resolveDeviceOrigin('pm', '/pm?status=all')).toEqual({ key: 'pm', label: 'PM due', href: '/pm?status=all' });
  });

  it('treats an unknown or inherited key as Devices', () => {
    expect(resolveDeviceOrigin('admin', undefined).key).toBe('devices');
    expect(resolveDeviceOrigin('constructor', undefined).key).toBe('devices');
    expect(resolveDeviceOrigin('__proto__', undefined).key).toBe('devices');
    expect(resolveDeviceOrigin(['orders'], undefined).key).toBe('devices');
  });

  it('keeps the origin list’s filters from back', () => {
    expect(resolveDeviceOrigin('orders', '/orders?tab=rejected').href).toBe('/orders?tab=rejected');
    expect(resolveDeviceOrigin('devices', '/devices?search=c450&filter=offline&page=2').href).toBe(
      '/devices?search=c450&filter=offline&page=2',
    );
  });

  it('ignores a back that points anywhere but the origin section', () => {
    expect(resolveDeviceOrigin('orders', '/devices?filter=offline').href).toBe('/orders');
    expect(resolveDeviceOrigin('orders', '//evil.com/orders').href).toBe('/orders');
    expect(resolveDeviceOrigin('orders', 'https://evil.com/orders').href).toBe('/orders');
    expect(resolveDeviceOrigin(undefined, '/orders?tab=rejected')).toEqual({
      key: 'devices',
      label: 'Devices',
      href: '/devices',
    });
  });
});

describe('safeBackPath', () => {
  it('accepts a relative path under the section, query included, hash dropped', () => {
    expect(safeBackPath('/alerts?status=cleared#x', '/alerts')).toBe('/alerts?status=cleared');
    expect(safeBackPath('/', '/')).toBe('/');
  });

  it('rejects protocol-relative, absolute and backslash tricks', () => {
    expect(safeBackPath('//evil.com', '/')).toBeNull();
    expect(safeBackPath('//evil.com/devices', '/devices')).toBeNull();
    expect(safeBackPath('https://evil.com/devices', '/devices')).toBeNull();
    expect(safeBackPath('/\\evil.com', '/')).toBeNull();
    expect(safeBackPath('/\\/evil.com/devices', '/devices')).toBeNull();
    expect(safeBackPath('javascript:alert(1)', '/devices')).toBeNull();
    expect(safeBackPath('/devices\n?x=1', '/devices')).toBeNull();
  });

  it('rejects another section, a sub-path, and non-strings', () => {
    expect(safeBackPath('/devices/abc', '/devices')).toBeNull();
    expect(safeBackPath('/admin', '/devices')).toBeNull();
    expect(safeBackPath('/devices/../admin', '/devices')).toBeNull();
    expect(safeBackPath(undefined, '/devices')).toBeNull();
    expect(safeBackPath(['/devices'], '/devices')).toBeNull();
    expect(safeBackPath('', '/devices')).toBeNull();
  });

  it('rejects an absurdly long value', () => {
    expect(safeBackPath(`/devices?search=${'a'.repeat(2000)}`, '/devices')).toBeNull();
  });
});

describe('deviceHref', () => {
  it('links to the device with its origin', () => {
    expect(deviceHref('d1', 'orders')).toBe('/devices/d1?from=orders');
  });

  it('leaves the default origin off the URL', () => {
    expect(deviceHref('d1', 'devices')).toBe('/devices/d1');
  });

  it('carries back only when it adds something to the origin', () => {
    expect(deviceHref('d1', 'orders', '/orders')).toBe('/devices/d1?from=orders');
    expect(deviceHref('d1', 'orders', '/orders?tab=rejected')).toBe(
      '/devices/d1?from=orders&back=%2Forders%3Ftab%3Drejected',
    );
    expect(deviceHref('d1', 'devices', '/devices?filter=offline')).toBe(
      '/devices/d1?from=devices&back=%2Fdevices%3Ffilter%3Doffline',
    );
  });

  it('encodes the device id', () => {
    expect(deviceHref('a/b', 'alerts')).toBe('/devices/a%2Fb?from=alerts');
  });

  it('round-trips through resolveDeviceOrigin', () => {
    const url = new URL(deviceHref('d1', 'issues', '/issues?type=all&status=any'), 'http://x');
    expect(resolveDeviceOrigin(url.searchParams.get('from') ?? undefined, url.searchParams.get('back') ?? undefined).href).toBe(
      '/issues?type=all&status=any',
    );
  });
});

describe('customers origin', () => {
  it('goes back to the Customers list, or to the customer page it came from', () => {
    expect(resolveDeviceOrigin('customers', undefined)).toEqual({ key: 'customers', label: 'Customers', href: '/customers' });
    expect(resolveDeviceOrigin('customers', '/customers?tab=all')).toEqual({
      key: 'customers',
      label: 'Customers',
      href: '/customers?tab=all',
    });
    expect(resolveDeviceOrigin('customers', '/customers/42')).toEqual({ key: 'customers', label: 'Customer', href: '/customers/42' });
  });

  it('refuses any other customers sub-path, and customer pages for other sections', () => {
    expect(resolveDeviceOrigin('customers', '/customers/42/x').href).toBe('/customers');
    expect(resolveDeviceOrigin('customers', '/customers/abc').href).toBe('/customers');
    expect(resolveDeviceOrigin('orders', '/customers/42').href).toBe('/orders');
  });

  it('deviceHref keeps a customer page as back', () => {
    expect(deviceHref('D1', 'customers', '/customers/42')).toBe('/devices/D1?from=customers&back=%2Fcustomers%2F42');
  });
});

describe('Devices list round trip (Review Focus 3)', () => {
  const back = '/devices?page=3&rows=20&sort=model&dir=desc&colour=colour';

  it('deviceHref keeps the whole list URL and resolveDeviceOrigin hands it back', () => {
    const href = deviceHref('d1', 'devices', back);
    const url = new URL(href, 'http://x');
    expect(url.searchParams.get('back')).toBe(back);
    expect(resolveDeviceOrigin(url.searchParams.get('from') ?? undefined, url.searchParams.get('back') ?? undefined).href).toBe(back);
  });

  it('survives a customer name with spaces, ampersands and plus signs', () => {
    const named = '/devices?customer=Smith+%26+Sons+%2B+Co&page=3&rows=20';
    const url = new URL(deviceHref('d1', 'devices', named), 'http://x');
    expect(resolveDeviceOrigin('devices', url.searchParams.get('back') ?? undefined).href).toBe(named);
  });
});

describe('site stock origin', () => {
  it('goes back to the shelf page a device was opened from', () => {
    expect(resolveDeviceOrigin('site-stock', '/site-stock/9')).toEqual({ key: 'site-stock', label: 'Shelf', href: '/site-stock/9' });
    expect(resolveDeviceOrigin('site-stock', '/site-stock/9/x').href).toBe('/site-stock');
  });
});

describe('deviceOriginParams', () => {
  it('keeps a valid from and the back it vouches for', () => {
    expect(deviceOriginParams('devices', '/devices?page=3')).toEqual({ from: 'devices', back: '/devices?page=3' });
    expect(deviceOriginParams('orders', '/devices?page=3')).toEqual({ from: 'orders', back: undefined });
    expect(deviceOriginParams('nope', '/devices?page=3')).toEqual({ from: undefined, back: undefined });
    expect(deviceOriginParams(null, null)).toEqual({ from: undefined, back: undefined });
  });
});

describe('safeReturnPath', () => {
  it('accepts a path under any allowed base, query kept, hash dropped', () => {
    expect(safeReturnPath('/site-stock?page=2&sort=site#x', ['/site-stock'])).toBe('/site-stock?page=2&sort=site');
    expect(safeReturnPath('/customers/42', ['/site-stock', '/customers'])).toBe('/customers/42');
  });

  it('rejects other origins, other sections, look-alike prefixes and over-long values', () => {
    expect(safeReturnPath('//evil', ['/devices'])).toBeNull();
    expect(safeReturnPath('https://x/devices', ['/devices'])).toBeNull();
    expect(safeReturnPath('/devicesX', ['/devices'])).toBeNull();
    expect(safeReturnPath('/devices/abc', ['/devices'])).toBeNull();
    expect(safeReturnPath('/admin', ['/devices', '/customers'])).toBeNull();
    expect(safeReturnPath(`/devices?q=${'a'.repeat(1001)}`, ['/devices'])).toBeNull();
    expect(safeReturnPath(undefined, ['/devices'])).toBeNull();
    expect(safeReturnPath('/devices', [])).toBeNull();
  });

  it('agrees with safeBackPath for one base', () => {
    expect(safeReturnPath('/pm?status=all', ['/pm'])).toBe(safeBackPath('/pm?status=all', '/pm'));
  });
});

describe('devicePageHref', () => {
  it('is the device page with the from / back it was opened with', () => {
    expect(devicePageHref('abc 1')).toBe('/devices/abc%201');
    expect(devicePageHref('abc', { from: 'orders', back: '/orders?tab=rejected' })).toBe(
      '/devices/abc?from=orders&back=%2Forders%3Ftab%3Drejected',
    );
  });
});

describe('safeReturnPath allowedPaths', () => {
  it('also accepts a pathname matching an extra pattern, and nothing else', () => {
    expect(safeReturnPath('/devices/abc?from=orders', ['/orders'], [/^\/devices\/[a-z]+$/])).toBe('/devices/abc?from=orders');
    expect(safeReturnPath('/devices/abc/x', ['/orders'], [/^\/devices\/[a-z]+$/])).toBeNull();
    expect(safeReturnPath('//evil.com/devices/abc', ['/orders'], [/^\/devices\/[a-z]+$/])).toBeNull();
  });
});
