'use client';

import { useOptimistic, useTransition } from 'react';
import { toast } from 'sonner';
import { setCounterCategoryAction } from '@/app/(app)/admin/actions';

export interface CounterCategorySelectProps {
  name: string;
  /** `null` is "unset" — the counter has been seen but nobody has said what it is. */
  value: string | null;
}

const OPTIONS = [
  { value: '', label: 'Unset' },
  { value: 'meter', label: 'Meter' },
  { value: 'supply', label: 'Supply' },
  { value: 'other', label: 'Other' },
];

/**
 * One row's category dropdown on `/admin/counters`. Saving on change (rather than behind a Save
 * button on each of 83 rows) is the point of making this a client component.
 *
 * The selected value is `useOptimistic` over the server's, not `useState` seeded from it: the
 * server's value is the truth, so a failed write — or a change made elsewhere on the page, such as
 * "Set defaults" rewriting seven rows at once — leaves every dropdown showing what is actually
 * stored rather than a stale local guess.
 */
export function CounterCategorySelect({ name, value }: CounterCategorySelectProps) {
  const [current, setCurrent] = useOptimistic(value ?? '');
  const [pending, start] = useTransition();

  return (
    <select
      aria-label={`Category for ${name}`}
      value={current}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        start(async () => {
          setCurrent(next);
          const result = await setCounterCategoryAction(name, next);
          // No rollback needed: the optimistic value falls back to the server's once the
          // transition ends, so a rejected change simply snaps back.
          if (!result.ok) toast.error(result.message);
        });
      }}
      className="h-8 w-32 rounded-lg border border-input bg-transparent px-2 text-[13px] transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
    >
      {OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
