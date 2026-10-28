'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import type { DeviceFilterOptions } from '@mps/db/queries';
import { cn } from 'cn';
import {
  COLOUR_FILTERS,
  REPLENISH_FILTERS,
  deviceFilterParams,
  hasDeviceFilters,
  type DeviceFilters,
} from '@/lib/device-filters';
import { hrefWith } from '@/lib/href';

export interface DeviceFilterBarProps {
  /** The list this bar filters: `/devices`, or `/` for the Fleet overview's preview. */
  basePath: string;
  filters: DeviceFilters;
  /** The list's other params to keep (search, tab). `page` is left out: a new filter starts at page 1. */
  params?: Record<string, string | undefined>;
  options: DeviceFilterOptions;
  className?: string;
}

const CONTROL =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-[13px] transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30';

/**
 * The customer, colour, model and replenishment filters above a device table. Every choice is a
 * navigation to a new URL (no client state of its own), so a filtered list can be linked, and Back
 * undoes the last change.
 *
 * The customer box is a type-ahead over every customer in the fleet (a `<datalist>`): picking a
 * suggestion, or pressing Enter on a name that matches exactly one, applies it; emptying the box
 * removes it.
 */
export function DeviceFilterBar({ basePath, filters, params, options, className }: DeviceFilterBarProps) {
  const router = useRouter();
  const ids = { customer: useId(), list: useId() };
  const [typed, setTyped] = useState(filters.customer ?? '');
  // The URL is the truth: when it moves (Clear filters, Back), the box follows it.
  const [shown, setShown] = useState(filters.customer);
  if (shown !== filters.customer) {
    setShown(filters.customer);
    setTyped(filters.customer ?? '');
  }

  function apply(change: Partial<DeviceFilters>) {
    router.push(hrefWith(basePath, { ...params, ...deviceFilterParams({ ...filters, ...change }) }));
  }

  /** The one customer `text` names: an exact match (any case), else the only one containing it. */
  function customerFor(text: string): string | undefined {
    const q = text.trim().toLowerCase();
    if (q === '') return undefined;
    const exact = options.customers.find((c) => c.toLowerCase() === q);
    if (exact) return exact;
    const containing = options.customers.filter((c) => c.toLowerCase().includes(q));
    return containing.length === 1 ? containing[0] : undefined;
  }

  function onCustomerChange(value: string) {
    setTyped(value);
    // A suggestion picked from the list arrives as one change event carrying its exact text.
    if (options.customers.includes(value) && value !== filters.customer) apply({ customer: value });
    else if (value === '' && filters.customer) apply({ customer: undefined });
  }

  function onCustomerKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const match = customerFor(typed);
    if (match) {
      setTyped(match);
      if (match !== filters.customer) apply({ customer: match });
    }
  }

  const unknownCustomer = typed.trim() !== '' && typed !== filters.customer && customerFor(typed) === undefined;

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <label htmlFor={ids.customer} className="sr-only">
        Customer
      </label>
      <div className="relative w-full sm:w-64">
        <input
          id={ids.customer}
          list={ids.list}
          value={typed}
          onChange={(e) => onCustomerChange(e.target.value)}
          onKeyDown={onCustomerKey}
          onBlur={() => {
            if (unknownCustomer) setTyped(filters.customer ?? '');
          }}
          placeholder="Any customer"
          autoComplete="off"
          aria-invalid={unknownCustomer || undefined}
          className={cn(CONTROL, 'w-full pr-8 placeholder:text-muted-foreground')}
        />
        {filters.customer ? (
          <button
            type="button"
            onClick={() => {
              setTyped('');
              apply({ customer: undefined });
            }}
            aria-label="Clear customer"
            title="Clear customer"
            className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <datalist id={ids.list}>
          {options.customers.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <select
        aria-label="Colour or mono"
        value={filters.colour ?? ''}
        onChange={(e) => apply({ colour: (e.target.value || undefined) as DeviceFilters['colour'] })}
        className={cn(CONTROL, 'w-[calc(50%-0.25rem)] sm:w-auto')}
      >
        <option value="">Colour and mono</option>
        {COLOUR_FILTERS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Model"
        value={filters.model ?? ''}
        onChange={(e) => apply({ model: e.target.value || undefined })}
        className={cn(CONTROL, 'w-[calc(50%-0.25rem)] sm:w-auto sm:max-w-56')}
      >
        <option value="">Any model</option>
        {/* A model from an old link that no device carries any more still shows as chosen. */}
        {filters.model && !options.models.includes(filters.model) ? (
          <option value={filters.model}>{filters.model}</option>
        ) : null}
        {options.models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <select
        aria-label="Replenishment"
        value={filters.replenish ?? ''}
        onChange={(e) => apply({ replenish: (e.target.value || undefined) as DeviceFilters['replenish'] })}
        className={cn(CONTROL, 'w-full sm:w-auto')}
      >
        <option value="">Any replenishment</option>
        {REPLENISH_FILTERS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {hasDeviceFilters(filters) ? (
        <Link href={hrefWith(basePath, params ?? {})} className="px-1 text-[13px] text-brand hover:underline">
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}
