/**
 * Fleet-wide meter-collection health.
 *
 * DRMS collects meter counters roughly once a day, for the whole fleet at once. "This device has
 * not reported a counter in 24 hours" therefore says nothing about whether the device is
 * reachable — it says DRMS collected no reading for it. When a large share of the fleet is stale
 * at the same moment, the cause is almost certainly that collection is behind, not that hundreds
 * of devices went offline together (2026-09-18: DRMS collected nothing after 17 Sep 12:01 UTC and
 * all 35 reporting devices looked "offline" while CSRC showed them online).
 */
export interface CollectionTally {
  /** Devices DRMS still expects a reading from: monitored, and they have reported at least once. */
  devicesExpectingReadings: number;
  /** How many of those have not reported inside the staleness threshold. */
  devicesStale: number;
}

/**
 * The stale share at which we stop believing the devices and start blaming the collection.
 *
 * DRMS collects the fleet in a batch, so the readings arrive together or not at all. A large stale
 * fraction means the batch is behind, not that the devices are down — the batch simply has not
 * reached them yet. It is deliberately not 1.0: on 2026-09-18 collection restarted and delivered
 * 5 of 35 devices, and an all-or-nothing rule read that partial recovery as "collection is fine"
 * and opened 30 alerts for devices that were only waiting their turn.
 */
export const COLLECTION_OUTAGE_STALE_RATIO = 0.7;

/**
 * True when at least `COLLECTION_OUTAGE_STALE_RATIO` of the devices that have ever reported are
 * stale. Proportional rather than all-or-nothing, so a collection that is only part-way through
 * the fleet still counts as behind.
 *
 * A fleet with nothing to collect from (`devicesExpectingReadings === 0`) is not an outage — there
 * is no evidence either way, and the zero check is also what keeps the ratio from dividing by zero.
 */
export function isCollectionOutage(tally: CollectionTally): boolean {
  const { devicesExpectingReadings, devicesStale } = tally;
  if (devicesExpectingReadings <= 0) return false;
  return devicesStale / devicesExpectingReadings >= COLLECTION_OUTAGE_STALE_RATIO;
}
