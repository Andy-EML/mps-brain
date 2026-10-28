'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { inArray } from 'drizzle-orm';
import { drmsEquipment } from '@mps/db';
import {
  describeSelection,
  HideError,
  hideDevices,
  resolveDeviceSelection,
  SettingsError,
  unhideDevices,
  updateDeviceSettings,
  type DeviceListOptions,
} from '@mps/db/queries';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { deviceFilterParams, parseDeviceFilters, type DeviceFilters } from '@/lib/device-filters';
import { hideErrorMessage } from '@/lib/hide-device';
import { hrefWith } from '@/lib/href';
import {
  describeSettingsPatch,
  parseSettingsForm,
  patchTouchesColour,
  settingsErrorMessage,
} from '@/lib/settings-form';

/**
 * The devices list's bulk bar: review a settings change over a selection, then apply it; or
 * review a hide, then hide. Plus *Unhide* on the Hidden tab. Both call
 * `requireUser()` first — an action is a public POST endpoint — and take the user id from the
 * session. Any signed-in user may change settings.
 *
 * The selection arrives in one of two modes:
 * - `ids`: repeated `drmsId` fields, the rows ticked on the current page (capped at 5,000);
 * - `matching`: "all N matching this view", resolved **here** from `search` + `filter` and the
 *   customer/colour/model/replenishment filters with `resolveDeviceSelection` — the same
 *   conditions the list is drawn with. No id list from the
 *   browser is trusted for this mode, however it arrives.
 *
 * The form is parsed as colour (`isColour: true`) whatever the selection holds: a cyan, magenta
 * or yellow override written to a mono device is harmless — the engine and the UI ignore CMY on
 * mono — and the review step says how many mono devices will ignore it.
 */

/** Most ids one explicit selection may post; "select all matching" has no such cap. */
const MAX_IDS = 5_000;

const FILTERS: readonly NonNullable<DeviceListOptions['filter']>[] = [
  'all',
  'needs-toner',
  'manual',
  'offline',
  'unlinked',
];

class TooManyDevices extends Error {
  readonly code = 'too_many';
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

interface ListView {
  search: string | undefined;
  filter: NonNullable<DeviceListOptions['filter']>;
  filters: DeviceFilters;
  page: number;
}

/** The list view the bar was used from, validated, so the redirect goes back to exactly it. */
function listView(formData: FormData): ListView {
  const requested = text(formData, 'filter');
  const filter = FILTERS.find((f) => f === requested) ?? 'all';
  const page = Number.parseInt(text(formData, 'page'), 10);
  return {
    search: text(formData, 'search') || undefined,
    filter,
    filters: parseDeviceFilters((name) => text(formData, name) || undefined),
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** `/devices?search=…&filter=…&page=…` plus any extra params; never a URL taken from the form. */
function listHref(view: ListView, extra: Record<string, string | number>): string {
  return hrefWith('/devices', {
    search: view.search,
    filter: view.filter === 'all' ? undefined : view.filter,
    ...deviceFilterParams(view.filters),
    page: view.page > 1 ? view.page : undefined,
    ...extra,
  });
}

/** The selected DRMS ids, deduplicated. Explicit ids may include ones that no longer exist. */
async function selectedIds(formData: FormData, view: ListView): Promise<string[]> {
  if (text(formData, 'mode') === 'matching') {
    const { drmsIds } = await resolveDeviceSelection(getDb(), {
      search: view.search,
      filter: view.filter,
      ...view.filters,
    });
    return drmsIds;
  }
  const ids = [
    ...new Set(
      formData.getAll('drmsId').filter((v): v is string => typeof v === 'string' && v !== ''),
    ),
  ];
  if (ids.length > MAX_IDS) throw new TooManyDevices();
  return ids;
}

export type BulkReview =
  | {
      ok: true;
      /** "Set cyan, magenta and yellow threshold to 15%" — the caller adds "on N devices". */
      summary: string;
      count: number;
      customers: number;
      mono: number;
      /** Whether the change writes a cyan/magenta/yellow threshold, which mono devices ignore. */
      touchesColour: boolean;
      /** Up to 50 `Customer · serial` lines. */
      names: string[];
    }
  | { ok: false; message: string };

/**
 * The confirmation step: what the form would change, and on which devices. Writes nothing. A
 * mistake in the form comes back as a sentence rather than a redirect, so the settings dialog can
 * stay open with it.
 */
export async function reviewBulkSettingsAction(formData: FormData): Promise<BulkReview> {
  await requireUser();
  try {
    const patch = parseSettingsForm(formData, { allowInherit: true, isColour: true });
    if (Object.keys(patch).length === 0)
      throw new SettingsError('Nothing to change.', 'empty_patch');
    const ids = await selectedIds(formData, listView(formData));
    const selection = await describeSelection(getDb(), ids);
    if (selection.count === 0) throw new SettingsError('Select at least one device.', 'no_devices');
    return {
      ok: true,
      summary: describeSettingsPatch(patch),
      count: selection.count,
      customers: selection.customers,
      mono: selection.mono,
      touchesColour: patchTouchesColour(patch),
      names: selection.names,
    };
  } catch (err) {
    if (err instanceof SettingsError || err instanceof TooManyDevices) {
      return { ok: false, message: settingsErrorMessage(err.code) };
    }
    throw err;
  }
}

/**
 * Applies the reviewed change: one `updateDeviceSettings` call, so one transaction and one audit
 * row however many devices. Redirects back to the same list view with `?updated=N`, or
 * `?settingsError=<code>` when the form or the selection is refused.
 */
export async function bulkUpdateSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const view = listView(formData);
  const db = getDb();

  let updated: number;
  try {
    const patch = parseSettingsForm(formData, { allowInherit: true, isColour: true });
    const ids = await selectedIds(formData, view);
    // A device deleted since the page was drawn would fail the settings row's foreign key and
    // take the whole transaction with it; drop it here instead.
    const existing =
      ids.length === 0
        ? []
        : (
            await db
              .select({ drmsId: drmsEquipment.drmsId })
              .from(drmsEquipment)
              .where(inArray(drmsEquipment.drmsId, ids))
          ).map((r) => r.drmsId);
    ({ updated } = await updateDeviceSettings(db, {
      drmsIds: existing,
      patch,
      userId: user.userId,
    }));
  } catch (err) {
    if (err instanceof SettingsError || err instanceof TooManyDevices)
      redirect(listHref(view, { settingsError: err.code }));
    throw err;
  }

  // The list and every device page under it, and everything that counts "Needs toner" /
  // "Manual replenishment".
  revalidatePath('/devices', 'layout');
  revalidatePath('/orders');
  revalidatePath('/');
  redirect(listHref(view, { updated }));
}

/* ------------------------------------------------------------------ Hide */

export type BulkHideReview =
  | { ok: true; count: number; customers: number; names: string[] }
  | { ok: false; message: string };

/**
 * The bulk bar's *Hide selected…* first step: how many devices the selection reaches, and which,
 * so the operator confirms the count before anything is hidden. Writes nothing. The selection is
 * resolved exactly as for a settings change — `matching` from the view on the server.
 */
export async function reviewBulkHideAction(formData: FormData): Promise<BulkHideReview> {
  await requireUser();
  try {
    const ids = await selectedIds(formData, listView(formData));
    const selection = await describeSelection(getDb(), ids);
    if (selection.count === 0) return { ok: false, message: hideErrorMessage('no_devices') };
    return { ok: true, count: selection.count, customers: selection.customers, names: selection.names };
  } catch (err) {
    if (err instanceof TooManyDevices) return { ok: false, message: hideErrorMessage(err.code) };
    throw err;
  }
}

/**
 * Hides the confirmed selection with the optional reason: one `hideDevices` call, so one
 * transaction and one audit row. Redirects back to the list (the devices are gone from it) with
 * `?hid=N`, or `?hideError=<code>`. Nothing is sent to DRMS.
 */
export async function bulkHideAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const view = listView(formData);
  let hidden: number;
  try {
    const ids = await selectedIds(formData, view);
    ({ hidden } = await hideDevices(getDb(), { drmsIds: ids, userId: user.userId, reason: text(formData, 'reason') }));
  } catch (err) {
    if (err instanceof HideError || err instanceof TooManyDevices) redirect(listHref(view, { hideError: err.code }));
    throw err;
  }
  revalidateHidden();
  // Back to page one: the hidden devices have left the list, so the old page may now be past the end.
  redirect(listHref({ ...view, page: 1 }, { hid: hidden }));
}

/**
 * *Unhide* on a row of the Hidden tab. Redirects back to that tab (same search and page) with
 * `?unhid=N`.
 */
export async function unhideFromListAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const drmsId = text(formData, 'drmsId');
  const search = text(formData, 'search') || undefined;
  const page = Number.parseInt(text(formData, 'page'), 10);
  const back = (extra: Record<string, string | number>) =>
    hrefWith('/devices', { filter: 'hidden', search, page: Number.isInteger(page) && page > 1 ? page : undefined, ...extra });
  let unhidden: number;
  try {
    ({ unhidden } = await unhideDevices(getDb(), { drmsIds: drmsId ? [drmsId] : [], userId: user.userId }));
  } catch (err) {
    if (err instanceof HideError) redirect(back({ hideError: err.code }));
    throw err;
  }
  revalidateHidden();
  redirect(back({ unhid: unhidden }));
}

/**
 * Hiding or unhiding changes every list and count that leaves hidden devices out — the devices
 * list, Fleet overview, the reconnect and issues queues, alerts, the orders queue (withdrawn
 * proposals) and the sidebar badges in the shared layout — so revalidate the whole app.
 */
function revalidateHidden() {
  revalidatePath('/', 'layout');
}
