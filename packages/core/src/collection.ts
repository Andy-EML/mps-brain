/**
 * Fleet-wide meter-collection health.
 *
 * DRMS collects meter counters roughly once a day, for the whole fleet at once. "This device has
 * not reported a counter in 24 hours" therefore says nothing about whether the device is
 * reachable — it says DRMS collected no reading for it. When *every* device that has ever
 * reported is stale at the same moment, the cause is almost certainly that collection stopped,
 * not that the whole fleet went offline together (2026-09-18: DRMS collected nothing after
 * 17 Sep 12:01 UTC and all 35 reporting devices looked "offline" while CSRC showed them online).
 */
export interface CollectionTally {
  /** Devices DRMS still expects a reading from: monitored, and they have reported at least once. */
  devicesExpectingReadings: number;
  /** How many of those have not reported inside the staleness threshold. */
  devicesStale: number;
}

/**
 * True when every device that has ever reported is stale. Deliberately all-or-nothing: one device
 * still reporting proves collection is running, so the rest really are individually quiet.
 *
 * A fleet with nothing to collect from (`devicesExpectingReadings === 0`) is not an outage — there
 * is no evidence either way.
 */
export function isCollectionOutage(tally: CollectionTally): boolean {
  return tally.devicesExpectingReadings > 0 && tally.devicesStale === tally.devicesExpectingReadings;
}
