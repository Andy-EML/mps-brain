import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from 'cn';
import { formatNumber, pluralise } from '@/lib/format';
import { hrefWith } from '@/lib/href';

export interface PaginationProps {
  basePath: string;
  /** Params to keep on the prev/next links (search, filter). */
  params?: Record<string, string | number | null | undefined>;
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  /** Singular noun for the count line; pluralised for you. */
  noun?: string;
  className?: string;
}

const STEP =
  'flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-sm transition-colors hover:bg-muted hover:text-foreground';

/** "Showing 1–50 of 836 devices" with Previous / Next links. */
export function Pagination({ basePath, params, page, pageSize, total, noun = 'device', className }: PaginationProps) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <p className="text-sm text-muted-foreground">
        {total === 0
          ? `No ${pluralise(0, noun)}`
          : `Showing ${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)} ${pluralise(total, noun)}`}
      </p>
      {lastPage > 1 ? (
        <div className="flex items-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">
            Page {formatNumber(page)} of {formatNumber(lastPage)}
          </span>
          {page > 1 ? (
            <Link href={hrefWith(basePath, { ...params, page: page - 1 > 1 ? page - 1 : undefined })} className={STEP}>
              <ChevronLeft className="size-4" aria-hidden />
              Previous
            </Link>
          ) : (
            <span className={cn(STEP, 'pointer-events-none opacity-40')} aria-disabled>
              <ChevronLeft className="size-4" aria-hidden />
              Previous
            </span>
          )}
          {page < lastPage ? (
            <Link href={hrefWith(basePath, { ...params, page: page + 1 })} className={STEP}>
              Next
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : (
            <span className={cn(STEP, 'pointer-events-none opacity-40')} aria-disabled>
              Next
              <ChevronRight className="size-4" aria-hidden />
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
