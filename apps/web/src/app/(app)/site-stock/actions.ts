'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  SiteStockError,
  createShelf,
  deleteShelf,
  resetAutoReplenishForShelf,
  searchVantageCustomers,
  updateShelf,
  type VantageCustomerMatch,
} from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { customerReturn } from '@/lib/customer-return';
import { getDb } from '@/lib/db';
import { parseCounts, parseId } from '@/lib/shelf-form';

/**
 * `/site-stock` and `/site-stock/<id>`: create, edit and delete a customer-site shelf, correct its
 * used counts, and switch its machines' own "auto-replenish off" back to inherited. Every action
 * calls `requireUser()` first — an action is a public POST endpoint — and takes the user id from
 * the session, never the form. The query functions validate again and write the audit row.
 *
 * A `SiteStockError` comes back as `?error=<code>&errorFor=<form>`: the page turns the code into
 * a sentence and shows it beside the form it came from (`add` on the list; `holdings`, `correct`,
 * `delete` or `reset` on a shelf), which stays open.
 *
 * The customer page (`/customers/<id>`) shows the same forms for its shelves and posts
 * `returnTo=/customers/<id>`: the user then lands back on it, errors included (with `&shelf=<id>`
 * saying which shelf's form they belong to).
 */

const LIST = '/site-stock';
const MIN_QUERY = 2;

const shelfPage = (id: number) => `${LIST}/${id}`;

function fail(page: string, code: string, form: string, shelfId?: number | null): never {
  const shelf = shelfId == null ? '' : `&shelf=${shelfId}`;
  redirect(`${page}?error=${encodeURIComponent(code)}&errorFor=${encodeURIComponent(form)}${shelf}`);
}

function refresh() {
  // The list, every shelf page, the device pages that show a shelf badge, and the customer pages.
  revalidatePath(LIST, 'layout');
  revalidatePath('/devices', 'layout');
  revalidatePath('/customers', 'layout');
}

/** *+ New shelf*'s site search: Vantage customers with a linked device, by name or reference. */
export async function searchShelfCustomersAction(query: string): Promise<VantageCustomerMatch[]> {
  await requireUser();
  const q = String(query ?? '').trim();
  if (q.length < MIN_QUERY) return [];
  return searchVantageCustomers(getDb(), q, 20);
}

/** *+ New shelf*: a site and a family, nothing held yet; opens the new shelf to set its holdings. */
export async function createShelfAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const returnTo = customerReturn(formData);
  let shelfId: number;
  try {
    const vantageCustomerId = parseId(formData, 'vantageCustomerId', 'customer');
    const familyId = parseId(formData, 'familyId', 'family');
    ({ shelfId } = await createShelf(getDb(), { vantageCustomerId, familyId, holding: {}, userId: user.userId }));
  } catch (err) {
    if (err instanceof SiteStockError) fail(returnTo ?? LIST, err.code, 'add');
    throw err;
  }
  refresh();
  // From a customer page: back to it, where the new shelf's holdings can be set in place.
  redirect(returnTo ? `${returnTo}#shelf-${shelfId}` : shelfPage(shelfId));
}

/** The shelf page's holdings *Save*. */
export async function updateHoldingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageFor(formData);
  try {
    const shelfId = parseId(formData, 'shelfId', 'shelf');
    await updateShelf(getDb(), { shelfId, holding: parseCounts(formData, 'holding'), userId: user.userId });
  } catch (err) {
    if (err instanceof SiteStockError) fail(page, err.code, 'holdings', returnShelf(formData));
    throw err;
  }
  refresh();
}

/** *Correct counts*: the audited manual correction of what has been used since the last top-up. */
export async function correctCountsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageFor(formData);
  try {
    const shelfId = parseId(formData, 'shelfId', 'shelf');
    await updateShelf(getDb(), { shelfId, used: parseCounts(formData, 'used'), userId: user.userId });
  } catch (err) {
    if (err instanceof SiteStockError) fail(page, err.code, 'correct', returnShelf(formData));
    throw err;
  }
  refresh();
}

/** *Delete shelf*, confirmed first; `deleteShelf` refuses while a top-up is approved (`in_use`). */
export async function deleteShelfAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageFor(formData);
  try {
    const shelfId = parseId(formData, 'shelfId', 'shelf');
    await deleteShelf(getDb(), { shelfId, userId: user.userId });
  } catch (err) {
    if (err instanceof SiteStockError) fail(page, err.code, 'delete', returnShelf(formData));
    throw err;
  }
  refresh();
  redirect(customerReturn(formData) ?? LIST);
}

/**
 * The banner's *Switch back to inherited*: clears the shelf's machines' own auto-replenish Off.
 * When none of them had one (it is off for the customer or by default) the page says so.
 */
export async function resetAutoReplenishAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageFor(formData);
  let updated: number;
  try {
    const shelfId = parseId(formData, 'shelfId', 'shelf');
    ({ updated } = await resetAutoReplenishForShelf(getDb(), { shelfId, userId: user.userId }));
  } catch (err) {
    if (err instanceof SiteStockError) fail(page, err.code, 'reset', returnShelf(formData));
    throw err;
  }
  refresh();
  redirect(`${page}?reset=${updated}`);
}

/** The posted shelf id, or null when it is junk. */
function postedShelfId(formData: FormData): number | null {
  const raw = formData.get('shelfId');
  return typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

/** The page to come back to: the customer page that posted the form, else the shelf page, else the list. */
function pageFor(formData: FormData): string {
  const returnTo = customerReturn(formData);
  if (returnTo) return returnTo;
  const id = postedShelfId(formData);
  return id === null ? LIST : shelfPage(id);
}

/** On a customer page, which shelf's form an error belongs to; the shelf page needs no such hint. */
function returnShelf(formData: FormData): number | null {
  return customerReturn(formData) ? postedShelfId(formData) : null;
}
