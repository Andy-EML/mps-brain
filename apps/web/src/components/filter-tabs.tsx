import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from 'cn';
import { hrefWith } from '@/lib/href';

export interface FilterTab {
  value: string;
  label: ReactNode;
}

export interface FilterTabsProps {
  basePath: string;
  /** Query param the tabs set. */
  param?: string;
  current: string;
  tabs: readonly FilterTab[];
  /** Other params to keep as you switch tab (the search term). */
  params?: Record<string, string | number | null | undefined>;
  /** The tab that needs no query param, because it is what a bare URL already shows. */
  defaultValue?: string;
  /** The nav's accessible name. */
  ariaLabel?: string;
  className?: string;
}

/** The pill row above the device table. Links, not client state — every tab is a real URL. */
export function FilterTabs({
  basePath,
  param = 'filter',
  current,
  tabs,
  params,
  defaultValue = 'all',
  ariaLabel = 'Filter devices',
  className,
}: FilterTabsProps) {
  return (
    <nav aria-label={ariaLabel} className={cn('flex flex-wrap items-center gap-1', className)}>
      {tabs.map((tab) => {
        const active = tab.value === current;
        return (
          <Link
            key={tab.value}
            href={hrefWith(basePath, { ...params, [param]: tab.value === defaultValue ? undefined : tab.value })}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-full px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
