import type { ReconnectFilter } from '@mps/db/queries';

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
