import { describe, expect, it } from 'vitest';
import { deviceHref, resolveDeviceOrigin, safeBackPath } from './device-origin';

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
