import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { cn } from 'cn';
import { hrefWith } from '../lib/href';

export interface SearchInputProps {
  /** Where the form submits. The overview's box sends you to the devices list. */
  action: string;
  defaultValue?: string;
  placeholder?: string;
  /**
   * Extra query params to carry through the submit. A GET form replaces the whole query string,
   * so anything that must survive a search (the active filter tab) has to ride along as a hidden
   * field. `page` deliberately does not — a new search starts at page 1.
   */
  hiddenParams?: Record<string, string | undefined>;
  className?: string;
}

/**
 * The "Clear search" link's target: `action` with `hiddenParams` carried over (e.g. the active
 * filter tab), so clearing the search box doesn't also drop back to the "All" tab.
 */
export function clearSearchHref(action: string, hiddenParams?: SearchInputProps['hiddenParams']): string {
  return hrefWith(action, hiddenParams ?? {});
}

/**
 * A plain GET form, so search needs no client JavaScript and the result is a real, shareable URL.
 */
export function SearchInput({ action, defaultValue, placeholder = 'Search device or customer', hiddenParams, className }: SearchInputProps) {
  const hidden = Object.entries(hiddenParams ?? {}).filter(([, v]) => v != null && v !== '');

  return (
    <form action={action} method="get" role="search" className={cn('relative', className)}>
      {hidden.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        name="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-10 w-full rounded-lg border border-line bg-card pr-9 pl-9 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
      />
      {defaultValue ? (
        <Link
          href={clearSearchHref(action, hiddenParams)}
          aria-label="Clear search"
          title="Clear search"
          className="absolute top-1/2 right-2.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </Link>
      ) : null}
    </form>
  );
}
