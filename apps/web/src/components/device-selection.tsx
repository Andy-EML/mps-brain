'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { TriangleAlert, X } from 'lucide-react';
import {
  bulkUpdateSettingsAction,
  reviewBulkSettingsAction,
  type BulkReview,
} from '@/app/(app)/devices/actions';
import { SettingsDialog } from '@/components/settings-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { deviceFilterParams, type DeviceFilters } from '@/lib/device-filters';
import { formatNumber, pluralise } from '@/lib/format';

/**
 * Selection on the devices list, and the bulk settings bar that acts on it.
 *
 * Two modes: `ids` — the rows ticked on this page — and `matching` — "all N devices matching this
 * view", which posts only the search, tab and filters; the server resolves the devices itself. The
 * page remounts the provider (a `key`) whenever any of those or the page changes, which is what
 * resets the selection.
 */

type Selection = { mode: 'ids'; ids: ReadonlySet<string> } | { mode: 'matching' };

interface SelectionContext {
  pageIds: string[];
  total: number;
  selection: Selection;
  isSelected: (drmsId: string) => boolean;
  toggle: (drmsId: string, on: boolean) => void;
  togglePage: (on: boolean) => void;
  selectMatching: () => void;
  clear: () => void;
}

const Ctx = createContext<SelectionContext | null>(null);

function useSelection(): SelectionContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('Device selection controls must be inside <DeviceSelectionProvider>.');
  return ctx;
}

const NONE: Selection = { mode: 'ids', ids: new Set() };

export interface DeviceSelectionProviderProps {
  /** The devices on this page, in order. */
  pageIds: string[];
  /** How many devices match the current search and filter, across every page. */
  total: number;
  children: ReactNode;
}

export function DeviceSelectionProvider({
  pageIds,
  total,
  children,
}: DeviceSelectionProviderProps) {
  const [selection, setSelection] = useState<Selection>(NONE);

  // Stable, so an effect can depend on `clear` without re-running every time the selection moves.
  const toggle = useCallback(
    (id: string, on: boolean) =>
      setSelection((s) => {
        if (s.mode === 'matching') return s;
        const ids = new Set(s.ids);
        if (on) ids.add(id);
        else ids.delete(id);
        return { mode: 'ids', ids };
      }),
    [],
  );
  const selectMatching = useCallback(() => setSelection({ mode: 'matching' }), []);
  const clear = useCallback(() => setSelection(NONE), []);

  const value = useMemo<SelectionContext>(
    () => ({
      pageIds,
      total,
      selection,
      isSelected: (id) => selection.mode === 'matching' || selection.ids.has(id),
      toggle,
      togglePage: (on) => setSelection(on ? { mode: 'ids', ids: new Set(pageIds) } : NONE),
      selectMatching,
      clear,
    }),
    [pageIds, total, selection, toggle, selectMatching, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const CHECKBOX = 'size-4 cursor-pointer accent-brand align-middle disabled:cursor-default';
const MATCHING_HINT =
  'Every device matching this view is selected — Clear to pick devices one by one.';

/** The header box: select this page. Indeterminate when only some of the page is ticked. */
export function SelectPageCheckbox() {
  const { pageIds, selection, togglePage } = useSelection();
  const ref = useRef<HTMLInputElement>(null);
  const ticked =
    selection.mode === 'matching'
      ? pageIds.length
      : pageIds.filter((id) => selection.ids.has(id)).length;
  const all = pageIds.length > 0 && ticked === pageIds.length;
  const some = ticked > 0 && !all;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select every device on this page"
      title={selection.mode === 'matching' ? MATCHING_HINT : undefined}
      className={CHECKBOX}
      checked={all}
      disabled={selection.mode === 'matching' || pageIds.length === 0}
      onChange={(e) => togglePage(e.target.checked)}
    />
  );
}

export function SelectRowCheckbox({ drmsId, label }: { drmsId: string; label: string }) {
  const { selection, isSelected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label={`Select ${label}`}
      title={selection.mode === 'matching' ? MATCHING_HINT : undefined}
      className={CHECKBOX}
      checked={isSelected(drmsId)}
      disabled={selection.mode === 'matching'}
      onChange={(e) => toggle(drmsId, e.target.checked)}
    />
  );
}

export interface BulkSettingsBarProps {
  /** The list view the selection was made in; posted so the server can resolve "all matching" and redirect back. */
  search?: string;
  filter: string;
  /** The customer, colour, model and replenishment filters. */
  filters: DeviceFilters;
  page: number;
}

/**
 * Shown above the table while anything is selected: the count, "select all N matching", *Change
 * settings…* and *Clear*. *Change settings…* opens the shared `SettingsDialog`; its *Review*
 * asks the server what would change (nothing is written) and moves to the confirmation step,
 * whose *Apply* posts the same form to `bulkUpdateSettingsAction`.
 */
export function BulkSettingsBar(props: BulkSettingsBarProps) {
  const { total, selection } = useSelection();
  const count = selection.mode === 'matching' ? total : selection.ids.size;
  // Unmounted, not just hidden, when the selection empties, so a review from the last selection
  // (and its error) cannot reappear on the next one.
  return count === 0 ? null : <ActiveBulkBar {...props} count={count} />;
}

function ActiveBulkBar({ search, filter, filters, page, count }: BulkSettingsBarProps & { count: number }) {
  const { total, selection, selectMatching, clear } = useSelection();
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    form: FormData;
    review: Extract<BulkReview, { ok: true }>;
  } | null>(null);

  const hidden: Record<string, string | string[]> = {
    mode: selection.mode,
    search: search ?? '',
    filter,
    ...Object.fromEntries(Object.entries(deviceFilterParams(filters)).map(([k, v]) => [k, v ?? ''])),
    page: String(page),
    ...(selection.mode === 'ids' ? { drmsId: [...selection.ids] } : {}),
  };

  async function review(form: FormData): Promise<boolean> {
    const result = await reviewBulkSettingsAction(form);
    if (!result.ok) {
      setReviewError(result.message);
      return false;
    }
    setReviewError(null);
    setPending({ form, review: result });
    return true;
  }

  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-line bg-brand-soft px-5 py-2.5 text-sm">
      <span className="font-semibold tabular" aria-live="polite">
        {selection.mode === 'matching'
          ? `All ${formatNumber(total)} ${pluralise(total, 'device')} matching this view`
          : `${formatNumber(count)} selected`}
      </span>
      {selection.mode === 'ids' && total > count ? (
        <button type="button" onClick={selectMatching} className="text-brand hover:underline">
          Select all {formatNumber(total)} matching
        </button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <SettingsDialog
          title={`Change settings on ${formatNumber(count)} ${pluralise(count, 'device')}`}
          fields={['black', 'cyan', 'magenta', 'yellow', 'autoReplenish', 'alertsEnabled']}
          allowInherit
          isColour
          action={review}
          hidden={hidden}
          error={reviewError}
          triggerLabel="Change settings…"
          submitLabel="Review"
          pendingLabel="Checking…"
        />
        <Button variant="ghost" size="sm" onClick={clear}>
          <X aria-hidden />
          Clear
        </Button>
      </div>

      <ConfirmBulkDialog pending={pending} onClose={() => setPending(null)} />
    </div>
  );
}

function ConfirmBulkDialog({
  pending,
  onClose,
}: {
  pending: { form: FormData; review: Extract<BulkReview, { ok: true }> } | null;
  onClose: () => void;
}) {
  const [applying, startApply] = useTransition();
  const review = pending?.review;

  // Close once the apply has landed. On success the selection is cleared and this whole bar goes
  // away anyway; on a refused write the toast says why and the operator starts again.
  const wasApplying = useRef(false);
  useEffect(() => {
    if (wasApplying.current && !applying) onClose();
    wasApplying.current = applying;
  }, [applying, onClose]);

  function apply() {
    if (!pending) return;
    startApply(async () => {
      // Redirects back to this list with `?updated=N` (or `?settingsError=`), which
      // `BulkResultToast` reports.
      await bulkUpdateSettingsAction(pending.form);
    });
  }

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => (!open && !applying ? onClose() : undefined)}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm the change</DialogTitle>
          <DialogDescription>Nothing has been written yet.</DialogDescription>
        </DialogHeader>
        {review ? (
          <div className="flex flex-col gap-3">
            <p className="text-[15px]">
              {review.summary} on{' '}
              <strong className="tabular">
                {formatNumber(review.count)} {pluralise(review.count, 'device')}
              </strong>
              .
            </p>
            {review.customers > 1 ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-[13px] text-warn"
              >
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                This selection spans {formatNumber(review.customers)} customers.
              </p>
            ) : null}
            {review.touchesColour && review.mono > 0 ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-[13px] text-muted-foreground">
                {formatNumber(review.mono)} mono {pluralise(review.mono, 'device')} will ignore the
                colour thresholds.
              </p>
            ) : null}
            <details className="text-[13px]">
              <summary className="cursor-pointer text-brand">
                Show the {pluralise(review.count, 'device')}
              </summary>
              <ul className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-line px-3 py-2 font-mono text-[12px]">
                {review.names.map((name) => (
                  <li key={name} className="truncate py-0.5">
                    {name}
                  </li>
                ))}
                {review.count > review.names.length ? (
                  <li className="py-0.5 font-sans text-muted-foreground">
                    and {formatNumber(review.count - review.names.length)} more
                  </li>
                ) : null}
              </ul>
            </details>
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={applying} />}>
            Cancel
          </DialogClose>
          <Button onClick={apply} disabled={applying} className="bg-brand hover:bg-brand/90">
            {applying ? 'Applying…' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reports what `bulkUpdateSettingsAction` redirected back with — `?updated=N`, or
 * `?settingsError=<code>` which the page has already turned into a sentence (`error`) — as a
 * toast, clears the selection after a successful write, and drops the parameter so a reload does
 * not repeat it.
 */
export function BulkResultToast({ updated, error }: { updated?: number; error?: string }) {
  const { clear } = useSelection();
  const router = useRouter();

  useEffect(() => {
    if (updated === undefined && error === undefined) return;
    // A fixed id, so React's development double-run of this effect shows one toast, not two.
    if (updated !== undefined) {
      toast.success(
        `Settings updated on ${formatNumber(updated)} ${pluralise(updated, 'device')}.`,
        { id: 'bulk-settings' },
      );
      clear();
    } else if (error !== undefined) {
      toast.error(error, { id: 'bulk-settings' });
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('updated');
    url.searchParams.delete('settingsError');
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [updated, error, clear, router]);

  return null;
}
