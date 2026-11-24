// Types only from @mps/db: the badge text is used by client components, which must not pull the
// database client into the browser bundle.
import type { OtherDealerInfo } from '@mps/db/queries';

/**
 * The customer page's *Other dealer* control and the badge text. Pure, so both are tested without a
 * database; the action checks the customer exists and `setOtherDealer` validates again.
 *
 * The form posts `vantageCustomerId`, `mode` (`default` | `ours` | `dealer`) and, for `dealer`,
 * `name` (the dealer's name, up to 60 characters). `default` and `ours` ignore the name.
 */

/** Longest dealer name kept (as `setOtherDealer` and the planner settings); the field stops here too. */
export const OTHER_DEALER_NAME_MAX = 60;

export type OtherDealerMode = 'default' | 'ours' | 'dealer';

export type OtherDealerResult = { ok: true } | { ok: false; error: string };

/** A refused form; its message is ours (never echoed input), so it is safe to show. */
export class OtherDealerFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtherDealerFormError';
  }
}

function text(fd: FormData, name: string): string {
  const value = fd.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export function parseOtherDealerForm(fd: FormData): { vantageCustomerId: number; mode: OtherDealerMode; name: string | null } {
  const id = text(fd, 'vantageCustomerId');
  if (!/^\d{1,9}$/.test(id)) throw new OtherDealerFormError('That customer no longer exists. Refresh the page.');
  const mode = text(fd, 'mode');
  if (mode !== 'default' && mode !== 'ours' && mode !== 'dealer') {
    throw new OtherDealerFormError('Pick who services this site.');
  }
  if (mode !== 'dealer') return { vantageCustomerId: Number(id), mode, name: null };
  const name = text(fd, 'name');
  if (name === '') throw new OtherDealerFormError('Enter the dealer’s name.');
  if (name.length > OTHER_DEALER_NAME_MAX) {
    throw new OtherDealerFormError(`Keep the dealer’s name to ${OTHER_DEALER_NAME_MAX} characters.`);
  }
  return { vantageCustomerId: Number(id), mode, name };
}

/** `Other dealer: MJ Flood`, with ` (head office)` / ` (by region)` when not set on the site itself; null when ours. */
export function otherDealerBadgeText(i: Pick<OtherDealerInfo, 'dealer' | 'source'>): string | null {
  if (i.dealer === null) return null;
  const suffix = i.source === 'head_office' ? ' (head office)' : i.source === 'region' ? ' (by region)' : '';
  return `Other dealer: ${i.dealer}${suffix}`;
}
