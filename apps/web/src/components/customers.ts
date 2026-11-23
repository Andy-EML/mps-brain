import type { CustomerTab, SelfManagedSource } from '@mps/db/queries';
import { hrefWith } from '../lib/href';
import { safeReturnPath } from '../lib/device-origin';
import type { Tone } from './toner';

/**
 * The pure helpers behind the Customers pages: which tab / search / page a URL asks for, the Stock
 * column's badge, and a customer's page URL. Type-only database imports, so client components can
 * use them too.
 */

export const CUSTOMER_TABS = [
  { value: 'with-machines', label: 'With machines' },
  { value: 'self-managed', label: 'Self-managed' },
  { value: 'head-offices', label: 'Head offices' },
  { value: 'all', label: 'All' },
] as const satisfies readonly { value: CustomerTab; label: string }[];

export const DEFAULT_CUSTOMER_TAB: CustomerTab = 'with-machines';

export interface CustomerSearchParams {
  tab: CustomerTab;
  /** Trimmed; `''` when there is none. */
  search: string;
  /** A whole number, at least 1. */
  page: number;
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isCustomerTab(value: string | undefined): value is CustomerTab {
  return CUSTOMER_TABS.some((t) => t.value === value);
}

/**
 * `/customers?tab=&search=&page=` read safely: an unknown tab is the default (With machines) and
 * the page is clamped to at least 1, so only values `listCustomers` accepts reach it.
 */
export function parseCustomerSearchParams(sp: RawParams): CustomerSearchParams {
  const requested = first(sp.tab);
  const tab = isCustomerTab(requested) ? requested : DEFAULT_CUSTOMER_TAB;
  const search = first(sp.search)?.trim() ?? '';
  const page = Math.max(1, Number.parseInt(first(sp.page) ?? '1', 10) || 1);
  return { tab, search, page };
}

/** The Stock column: who keeps this customer's toner. */
export function customerStockBadge(selfManaged: SelfManagedSource | null): { text: string; tone: Tone } {
  if (selfManaged === 'site') return { text: 'Self-managed', tone: 'warn' };
  if (selfManaged === 'head_office') return { text: 'Self-managed via head office', tone: 'warn' };
  return { text: 'Dealer', tone: 'muted' };
}

const CUSTOMERS_LIST = '/customers';

/** `back` when it is a Customers list view (not a customer page), else null. */
function customersListBack(back: unknown): string | null {
  const kept = safeReturnPath(back, [CUSTOMERS_LIST]);
  return kept === CUSTOMERS_LIST || kept?.startsWith(`${CUSTOMERS_LIST}?`) ? kept : null;
}

/**
 * The customer page. `back` is the Customers list view it was opened from (tab, search, page, sort,
 * rows), kept only when it is that list and adds something to it, so the page's Back link and
 * breadcrumb return to the same view.
 */
export function customerHref(vantageId: number, back?: string): string {
  // Only the list: a customer page as back would chain one customer to another.
  const kept = back != null && back !== CUSTOMERS_LIST ? customersListBack(back) : null;
  return hrefWith(`/customers/${vantageId}`, { back: kept });
}

/** The customer page's Back link / breadcrumb root: the list view in `back`, else the plain list. */
export function customersBackHref(back: unknown): string {
  return customersListBack(back) ?? CUSTOMERS_LIST;
}

/**
 * The switch's confirm-dialog line for turning self-managed on: what it will clear, from
 * `previewSelfManaged` ("Clears 3 pending proposals on 2 machines across 2 sites").
 */
export function selfManagedPreviewText(p: { pending: number; devices: number; sites: number }): string {
  if (p.pending === 0) return 'No pending proposals to clear.';
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const sites = p.sites > 1 ? ` across ${s(p.sites, 'site', 'sites')}` : '';
  return `Clears ${s(p.pending, 'pending proposal', 'pending proposals')} on ${s(p.devices, 'machine', 'machines')}${sites}.`;
}
