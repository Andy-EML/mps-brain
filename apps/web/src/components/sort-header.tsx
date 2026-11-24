import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from 'cn';
import type { QueryParams } from '@/lib/href';
import { listHref, nextSort, type ListState } from '@/lib/list-state';

export interface SortHeaderProps {
  label: string;
  sortKey: string;
  basePath: string;
  keep: QueryParams;
  state: ListState<string>;
  defaultRows: number;
  align?: 'left' | 'right';
  className?: string;
}

/** A sortable `<th>`: first click ascending, click again to flip. Page resets via listHref. */
export function SortHeader({
  label,
  sortKey,
  basePath,
  keep,
  state,
  defaultRows,
  align = 'left',
  className,
}: SortHeaderProps) {
  const active = state.sort === sortKey;
  const Icon = !active ? ArrowUpDown : state.dir === 'asc' ? ArrowUp : ArrowDown;
  const href = listHref(basePath, keep, state, nextSort(state, sortKey), { defaultRows });
  return (
    <th
      scope="col"
      // Only the active column says how it is sorted; the rest leave aria-sort off.
      aria-sort={active ? (state.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn(align === 'right' ? 'text-right' : 'text-left', className)}
    >
      <Link
        href={href}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        <Icon className={cn('size-3.5', !active && 'text-muted-foreground/60')} aria-hidden />
      </Link>
    </th>
  );
}

/** What a table needs to render its sortable headers: the list's URL, kept params and state. */
export interface SortContext {
  basePath: string;
  keep: QueryParams;
  state: ListState<string>;
  defaultRows: number;
}

/**
 * A column header that sorts when the table was given a `sorting` context, and is a plain `<th>`
 * otherwise — for tables used both on a sortable list and somewhere that isn't.
 */
export function SortableTh({
  label,
  sortKey,
  sorting,
  align = 'left',
  className,
}: {
  label: string;
  sortKey: string;
  sorting?: SortContext;
  align?: 'left' | 'right';
  className?: string;
}) {
  if (!sorting) {
    return (
      <th scope="col" className={cn(align === 'right' && 'text-right', className)}>
        {label}
      </th>
    );
  }
  return <SortHeader label={label} sortKey={sortKey} align={align} className={className} {...sorting} />;
}
