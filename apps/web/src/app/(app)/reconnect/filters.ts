import type { ReconnectFilter, ReconnectSortKey } from '@mps/db/queries';

/** The `?filter=` values the page and its CSV export both accept; anything else reads as `all`. */
export const RECONNECT_FILTERS = [
  'all',
  'new',
  'long',
  'unmonitored',
] as const satisfies readonly ReconnectFilter[];

export function parseReconnectFilter(value: string | null | undefined): ReconnectFilter {
  return RECONNECT_FILTERS.includes(value as ReconnectFilter) ? (value as ReconnectFilter) : 'all';
}

/** The unmonitored list's two groups, in the order the list sorts them. */
export function monitoringGroupLabel(registeredInDrms: boolean): string {
  return registeredInDrms ? 'Registered, waiting for first reading' : 'Not registered in DRMS';
}

const COMMON_SORT_KEYS = ['customer', 'location', 'device', 'serial', 'status'] as const satisfies readonly ReconnectSortKey[];

/**
 * The sort keys of the columns a filter's table shows: Last contact on the silent lists, First
 * connected and Last alarm on Not monitored yet. A sort carried over from the other table is
 * dropped, which also keeps Not monitored yet in its default grouping.
 */
export function reconnectSortKeys(filter: ReconnectFilter): readonly ReconnectSortKey[] {
  return filter === 'unmonitored' ? [...COMMON_SORT_KEYS, 'firstConnected', 'lastAlarm'] : [...COMMON_SORT_KEYS, 'lastContact'];
}
