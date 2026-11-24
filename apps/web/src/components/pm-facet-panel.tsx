'use client';

import { useState, useTransition, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from 'cn';
// Client-safe: pm-facets takes only types from @mps/db.
import type { FacetOption, PmFacet } from '@/lib/pm-facets';
import { formatNumber } from '@/lib/format';

/** How many options a facet lists before "Show all". */
export const FACET_TOP = 8;

export interface PmFacetGroup {
  facet: PmFacet;
  title: string;
  /** By count, most first; ticked ones included even at zero. */
  options: FacetOption[];
  /** This facet cleared, or null when nothing in it is ticked. */
  clearHref: string | null;
}

export interface PmFacetPanelProps {
  groups: PmFacetGroup[];
  /** The rest of the view (tab, search, due reason, sort, rows, town order) as hidden fields; never `page`. */
  hidden: [string, string][];
  /** Ticked values across every facet, for the narrow-screen "Filters (n)" button. */
  activeCount: number;
  /** Every facet cleared, or null when none is ticked. */
  clearAllHref: string | null;
}

/** The first `FACET_TOP` options by count plus any ticked one; the rest go under "Show all". */
export function splitFacetOptions(options: FacetOption[]): {
  top: FacetOption[];
  rest: FacetOption[];
} {
  const top: FacetOption[] = [];
  const rest: FacetOption[] = [];
  options.forEach((o, i) => (i < FACET_TOP || o.checked ? top : rest).push(o));
  return { top, rest };
}

/**
 * The PM due side filters: one checkbox list per facet with counts. A plain GET form to `/pm` (the
 * Apply button is the no-JavaScript way); with JavaScript a tick navigates straight away. Below `lg`
 * it sits behind a "Filters (n)" button.
 */
export function PmFacetPanel({ groups, hidden, activeCount, clearAllHref }: PmFacetPanelProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const onChange = (e: ChangeEvent<HTMLFormElement>) => {
    if ((e.target as EventTarget as HTMLInputElement).type !== 'checkbox') return;
    const qs = new URLSearchParams();
    for (const [k, v] of new FormData(e.currentTarget)) if (typeof v === 'string' && v !== '') qs.append(k, v);
    const query = qs.toString();
    startTransition(() => router.push(query ? `/pm?${query}` : '/pm', { scroll: false }));
  };

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="pm-filters"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line bg-card px-3.5 text-sm font-medium transition-colors hover:bg-muted lg:hidden"
      >
        <SlidersHorizontal aria-hidden className="size-4" />
        Filters ({formatNumber(activeCount)})
      </button>
      <form
        id="pm-filters"
        action="/pm"
        method="get"
        aria-label="PM filters"
        aria-busy={pending || undefined}
        onChange={onChange}
        className={cn(
          'mt-3 rounded-xl border border-line bg-card lg:mt-0 lg:block',
          open ? 'block' : 'hidden',
          pending && 'opacity-70',
        )}
      >
        {hidden.map(([name, value]) => (
          <input key={`${name}=${value}`} type="hidden" name={name} value={value} />
        ))}
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">Filters</h2>
          {clearAllHref ? (
            <Link href={clearAllHref} className="text-[13px] text-brand hover:underline">
              Clear all
            </Link>
          ) : null}
        </div>
        {groups.map((g) => (
          <FacetFieldset key={g.facet} group={g} />
        ))}
        <div className="px-4 py-3">
          <button type="submit" className="h-9 w-full rounded-lg border border-line text-[13px] font-medium hover:bg-muted">
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}

function FacetFieldset({ group }: { group: PmFacetGroup }) {
  const [find, setFind] = useState('');
  const { top, rest } = splitFacetOptions(group.options);
  const needle = find.trim().toLowerCase();
  const found = needle ? rest.filter((o) => o.label.toLowerCase().includes(needle)) : rest;
  const titleId = `pm-facet-${group.facet}`;

  return (
    <fieldset aria-labelledby={titleId} className="min-w-0 border-b border-line px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 id={titleId} className="text-[13px] font-semibold">
          {group.title}
        </h3>
        {group.clearHref ? (
          <Link href={group.clearHref} className="text-[12px] text-brand hover:underline" aria-label={`Clear ${group.title}`}>
            Clear
          </Link>
        ) : null}
      </div>
      {group.options.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">None in this view.</p>
      ) : (
        <ul className="space-y-1">
          {top.map((o) => (
            <FacetCheckbox key={`${o.value}:${o.checked}`} facet={group.facet} option={o} />
          ))}
        </ul>
      )}
      {rest.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[13px] text-brand hover:underline">
            Show all ({formatNumber(group.options.length)})
          </summary>
          <input
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            // Enter here filters the list; it must not submit the form.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            placeholder={`Find ${group.title.toLowerCase()}`}
            aria-label={`Find ${group.title.toLowerCase()}`}
            className="my-2 h-8 w-full rounded-md border border-input bg-card px-2 text-[13px] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          />
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {rest.map((o) => (
              <FacetCheckbox key={`${o.value}:${o.checked}`} facet={group.facet} option={o} hidden={!found.includes(o)} />
            ))}
          </ul>
          {found.length === 0 ? <p className="text-[12px] text-muted-foreground">No match.</p> : null}
        </details>
      ) : null}
    </fieldset>
  );
}

/**
 * One option. Keyed on its value and ticked state by the caller, so a tick changed elsewhere (a
 * chip, Clear) remounts it with the new default rather than keeping the old one.
 */
function FacetCheckbox({ facet, option, hidden }: { facet: PmFacet; option: FacetOption; hidden?: boolean }) {
  return (
    <li hidden={hidden}>
      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-muted">
        <input
          type="checkbox"
          name={facet}
          value={option.value}
          defaultChecked={option.checked}
          className="size-4 shrink-0 accent-brand"
        />
        <span className="min-w-0 flex-1 truncate" title={option.label}>
          {option.label}
        </span>
        <span className="text-[12px] text-muted-foreground tabular-nums">{formatNumber(option.count)}</span>
      </label>
    </li>
  );
}
