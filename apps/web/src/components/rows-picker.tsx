'use client';

import { useRouter } from 'next/navigation';
import { ROWS_OPTIONS, rowsCookieName } from '@/lib/list-state';

export interface RowsPickerProps {
  listKey: string;
  value: number;
  /** Target URL for each rows option, built on the server. */
  hrefFor: Record<number, string>;
}

/** Rows-per-page select. Remembers the choice per list in a cookie, then navigates. */
export function RowsPicker({ listKey, value, hrefFor }: RowsPickerProps) {
  const router = useRouter();
  return (
    <select
      aria-label="Rows per page"
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        const href = hrefFor[n];
        if (!href) return;
        document.cookie = `${rowsCookieName(listKey)}=${n}; path=/; max-age=31536000; samesite=lax`;
        router.push(href);
      }}
      className="h-8 rounded-lg border border-line bg-transparent px-2 text-sm"
    >
      {ROWS_OPTIONS.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}
