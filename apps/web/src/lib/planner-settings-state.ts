/**
 * The `/settings/pm` planner card's form state, shared by the client form and its server action.
 * No `@mps/db` values here: the client component imports this module.
 */

/** The card's fields exactly as typed, so a refused save gives them back unchanged. */
export interface PlannerFormValues {
  irelandDealer: string;
  scotlandDealer: string;
  channelIslandsDealer: string;
  nearMiles: string;
  doneRetentionDays: string;
  askedStaleDays: string;
  patches: string;
}

export const PLANNER_FIELDS = ['irelandDealer', 'scotlandDealer', 'channelIslandsDealer', 'nearMiles', 'doneRetentionDays', 'askedStaleDays', 'patches'] as const;

/**
 * `idle` before any save; `saved` with the stored (cleaned) values; `error` with our own message
 * (parser / `savePlannerSettings`, never raw error text) and the values as typed.
 */
export type PlannerFormState =
  | { status: 'idle' }
  | { status: 'saved'; values: PlannerFormValues }
  | { status: 'error'; error: string; values: PlannerFormValues };

/** The posted fields as typed (untrimmed; a missing field is ''). */
export function plannerFormValues(fd: FormData): PlannerFormValues {
  const get = (name: string): string => {
    const v = fd.get(name);
    return typeof v === 'string' ? v : '';
  };
  return {
    irelandDealer: get('irelandDealer'),
    scotlandDealer: get('scotlandDealer'),
    channelIslandsDealer: get('channelIslandsDealer'),
    nearMiles: get('nearMiles'),
    doneRetentionDays: get('doneRetentionDays'),
    askedStaleDays: get('askedStaleDays'),
    patches: get('patches'),
  };
}
