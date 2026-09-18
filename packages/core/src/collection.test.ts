import { describe, expect, it } from 'vitest';
import { COLLECTION_OUTAGE_STALE_RATIO, isCollectionOutage } from './collection';

describe('isCollectionOutage', () => {
  it('is an outage when every reporting device is stale', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 35 })).toBe(true);
  });

  it('is an outage when most of the fleet is stale but a few have come in', () => {
    // The 2026-09-18 partial recovery: 5 of 35 collected, 30 still on the previous day. The old
    // all-or-nothing rule let this through and opened 30 alerts.
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 30 })).toBe(true);
  });

  it('is not an outage when only a few devices are stale', () => {
    // 5/35 = 0.143 — collection is plainly running, so these really are individually quiet.
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 5 })).toBe(false);
  });

  it('is not an outage just under the line', () => {
    // 24/35 = 0.686
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 24 })).toBe(false);
  });

  it('is an outage exactly on the line', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 10, devicesStale: 7 })).toBe(true);
  });

  it('is not an outage when nothing is stale', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 35, devicesStale: 0 })).toBe(false);
  });

  it('is not an outage when no device has ever reported, and never divides by zero', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 0, devicesStale: 0 })).toBe(false);
  });

  it('treats a single stale device as an outage, because it is the whole evidence base', () => {
    expect(isCollectionOutage({ devicesExpectingReadings: 1, devicesStale: 1 })).toBe(true);
  });

  it('reads its threshold from the exported constant', () => {
    expect(COLLECTION_OUTAGE_STALE_RATIO).toBe(0.7);
    const expecting = 1000;
    const onTheLine = expecting * COLLECTION_OUTAGE_STALE_RATIO;
    expect(isCollectionOutage({ devicesExpectingReadings: expecting, devicesStale: onTheLine })).toBe(true);
    expect(isCollectionOutage({ devicesExpectingReadings: expecting, devicesStale: onTheLine - 1 })).toBe(false);
  });
});
