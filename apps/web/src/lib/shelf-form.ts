import { MAX_HOLDING, REPLENISH_COLOURS, type ShelfConsumableCounts } from '@mps/core';
import { SiteStockError, type SiteStockErrorCode } from '@mps/db/queries';

/**
 * Turns the site stock forms into query arguments. The forms post `shelfId`, `vantageCustomerId`,
 * `familyId`, and one `<prefix>-<consumable>` per count they show (`holding-black`, `used-cyan`):
 * a mono shelf's form simply has no cyan/magenta/yellow fields, so they are left as they are.
 *
 * Pure. Throws `SiteStockError` with the queries' own codes, so an action handles both alike; the
 * queries validate again.
 */

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** A posted row id; a missing, stale or crafted one reads as `not_found`. */
export function parseId(formData: FormData, name: string, what: string): number {
  const raw = text(formData, name);
  if (!/^\d{1,9}$/.test(raw)) throw new SiteStockError(`That ${what} no longer exists.`, 'not_found');
  return Number(raw);
}

/**
 * The counts present in the form. A holding is a whole number 0–`MAX_HOLDING`; a used count a whole
 * number 0 or more. A blank field is 0.
 */
export function parseCounts(formData: FormData, prefix: 'holding' | 'used'): Partial<ShelfConsumableCounts> {
  const out: Partial<ShelfConsumableCounts> = {};
  for (const c of REPLENISH_COLOURS) {
    if (!formData.has(`${prefix}-${c}`)) continue;
    const raw = text(formData, `${prefix}-${c}`);
    const value = raw === '' ? 0 : /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value) || (prefix === 'holding' && value > MAX_HOLDING)) {
      throw new SiteStockError(
        prefix === 'holding' ? `A holding is a whole number from 0 to ${MAX_HOLDING}.` : 'A used count is a whole number, 0 or more.',
        'bad_value',
      );
    }
    out[c] = value;
  }
  return out;
}

const SHELF_ERRORS: Record<SiteStockErrorCode, string> = {
  not_found: 'That shelf, customer or family no longer exists. Refresh the page and try again.',
  bad_value: `Check the numbers: a holding is a whole number from 0 to ${MAX_HOLDING}, a used count 0 or more. A mono shelf holds black and waste only.`,
  duplicate: 'This customer already has a shelf for that family.',
  in_use: 'A top-up for this shelf is approved and waiting to be ordered. Settle it on Toner orders first.',
  empty: 'Nothing was changed.',
};

/** `?error=<code>` as a sentence; looked up, so a crafted link cannot put text on the page. */
export function shelfErrorMessage(code: string): string {
  return (SHELF_ERRORS as Record<string, string>)[code] ?? 'The shelf was not saved. Refresh the page and try again.';
}
