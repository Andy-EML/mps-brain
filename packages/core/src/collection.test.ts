import { describe, expect, it } from 'vitest';
import { isCollectionOutage } from './collection';

describe('isCollectionOutage', () => {
  it('is an outage when every reporting device is stale', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 35 })).toBe(true);
  });

  it('is not an outage while one device is still reporting', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 34 })).toBe(false);
  });

  it('is not an outage when nothing is stale', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 0 })).toBe(false);
  });

  it('is not an outage when no device has ever reported', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 0, devicesStale: 0 })).toBe(false);
  });

  it('treats a single stale device as an outage, because it is the whole evidence base', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 1, devicesStale: 1 })).toBe(true);
  });
});
