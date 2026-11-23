import type { QueueSortKey, QueueTab } from '@mps/db/queries';

/**
 * Default page sizes for the Task 5 lists (today's page size, or 50 for lists that were not paged
 * before), and the params each accordion list keeps on its pager and sort links.
 */
export const PM_DEFAULT_ROWS = 100;
export const RECONNECT_DEFAULT_ROWS = 50;
export const REGISTRATIONS_DEFAULT_ROWS = 100;
export const ALERTS_DEFAULT_ROWS = 50;
export const SITE_STOCK_DEFAULT_ROWS = 50;
export const ORDERS_DEFAULT_ROWS = 50;
export const TONER_YIELD_DEFAULT_ROWS = 50;

type Params = Record<string, string | number | null | undefined>;

/** PM due: the filters plus the open accordion row, so paging or sorting keeps it open. */
export function pmKeep(filters: Params, openId: number | null): Params {
  return { ...filters, open: openId ?? undefined };
}

/** Toner orders: the tab (Review, the default, needs no param). */
export function ordersKeep(tab: QueueTab): { tab: string | undefined } {
  return { tab: tab === 'review' ? undefined : tab };
}

/** The order a tab shows with no `sort` param: most urgent on Review / Probably on site, most recent elsewhere. */
export function queueDefaultSort(tab: QueueTab): QueueSortKey {
  return tab === 'review' || tab === 'on-site' ? 'urgency' : 'recent';
}
