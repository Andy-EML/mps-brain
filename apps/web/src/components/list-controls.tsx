import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from 'cn';
import { formatNumber, pluralise } from '@/lib/format';
import { ROWS_OPTIONS, listHref, pageWindow, type ListState } from '@/lib/list-state';
import type { QueryParams } from '@/lib/href';
import { RowsPicker } from '@/components/rows-picker';

export interface ListControlsProps {
  basePath: string;
  /** Params to keep on every link (search, filter, open row). */
  keep: QueryParams;
  state: ListState<string>;
  total: number;
  /** Singular noun for the count line; pluralised for you. */
  noun?: string;
  /** The plural when it is not `noun` + s ("shelves"). */
  nounPlural?: string;
  listKey: string;
  defaultRows: number;
  /** Page sizes offered; defaults to every size. */
  rowsOptions?: readonly number[];
  /** Which copy this is — lists render one above and one below — so the two navs have distinct names. */
  position?: 'top' | 'bottom';
  className?: string;
}

const STEP =
  'flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-sm transition-colors hover:bg-muted hover:text-foreground';
const ICON_STEP = cn(STEP, 'px-2');

/** Page links, rows-per-page picker and the "Showing a-b of n" line. Render above and below a list. */
export function ListControls({
  basePath,
  keep,
  state,
  total,
  noun = 'device',
  nounPlural,
  listKey,
  defaultRows,
  rowsOptions = ROWS_OPTIONS,
  position = 'top',
  className,
}: ListControlsProps) {
  const lastPage = Math.max(1, Math.ceil(total / state.rows));
  const page = Math.min(state.page, lastPage);
  const first = total === 0 ? 0 : (page - 1) * state.rows + 1;
  const last = Math.min(total, page * state.rows);
  const href = (p: number) => listHref(basePath, keep, state, { page: p }, { defaultRows });
  const hrefFor: Record<number, string> = {};
  for (const n of rowsOptions) hrefFor[n] = listHref(basePath, keep, state, { rows: n }, { defaultRows });

  const step = (label: string, target: number, enabled: boolean, icon: ReactNode) =>
    enabled ? (
      <Link href={href(target)} className={ICON_STEP} aria-label={label}>
        {icon}
      </Link>
    ) : (
      // A disabled link: announced as one, but not focusable and going nowhere.
      <span role="link" aria-disabled="true" aria-label={label} className={cn(ICON_STEP, 'pointer-events-none opacity-40')}>
        {icon}
      </span>
    );

  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      {lastPage > 1 ? (
        <nav aria-label={position === 'bottom' ? 'Pages (bottom)' : 'Pages (top)'} className="flex items-center gap-1">
          {step('First page', 1, page > 1, <ChevronsLeft className="size-4" aria-hidden />)}
          {step('Previous page', page - 1, page > 1, <ChevronLeft className="size-4" aria-hidden />)}
          {pageWindow(page, lastPage).map((p) =>
            p === page ? (
              <span
                key={p}
                aria-current="page"
                aria-label={`Page ${p}`}
                className="flex h-8 min-w-8 items-center justify-center rounded-lg bg-secondary px-2 text-sm font-medium text-foreground"
              >
                {formatNumber(p)}
              </span>
            ) : (
              <Link key={p} href={href(p)} aria-label={`Page ${p}`} className={cn(STEP, 'min-w-8 justify-center px-2')}>
                {formatNumber(p)}
              </Link>
            ),
          )}
          {step('Next page', page + 1, page < lastPage, <ChevronRight className="size-4" aria-hidden />)}
          {step('Last page', lastPage, page < lastPage, <ChevronsRight className="size-4" aria-hidden />)}
        </nav>
      ) : null}
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        Rows
        <RowsPicker listKey={listKey} value={state.rows} hrefFor={hrefFor} />
      </label>
      <p className="text-sm text-muted-foreground">
        {total === 0
          ? `No ${pluralise(0, noun, nounPlural)}`
          : `Showing ${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)} ${pluralise(total, noun, nounPlural)}`}
      </p>
    </div>
  );
}
