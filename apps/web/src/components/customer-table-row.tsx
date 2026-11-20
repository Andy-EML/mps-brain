'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/** Anything in a row that does its own thing on click, so the row must not also navigate. */
const OWN_CLICK = 'a, button, input, select, textarea, label, [data-no-row-nav]';

/**
 * A `/customers` table row that opens the customer page on click, as device rows do: not on its
 * own links, not when the click ended a text selection, and Ctrl / Cmd + click opens a new tab.
 * From the keyboard the customer name is the link, so the row itself takes no focus.
 */
export function CustomerTableRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();

  function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
    if ((e.target as Element).closest(OWN_CLICK)) return;
    if (window.getSelection()?.toString()) return;
    if (e.ctrlKey || e.metaKey) window.open(href, '_blank', 'noopener');
    else router.push(href);
  }

  return (
    <tr onClick={onRowClick} className="cursor-pointer border-b border-line transition-colors last:border-b-0 hover:bg-muted/40">
      {children}
    </tr>
  );
}
