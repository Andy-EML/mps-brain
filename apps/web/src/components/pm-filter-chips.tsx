import Link from 'next/link';
import { X } from 'lucide-react';

export interface PmFilterChip {
  /** The facet's name, e.g. "Town". */
  facet: string;
  /** The value's display name, e.g. "Newbury". */
  label: string;
  /** This view with just this value removed. */
  href: string;
}

/** The ticked facet values above the PM due table, each a link that removes it, plus Clear all. */
export function PmFilterChips({ chips, clearAllHref }: { chips: PmFilterChip[]; clearAllHref: string }) {
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
      {chips.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          scroll={false}
          aria-label={`Remove ${c.facet}: ${c.label}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-brand bg-brand-soft py-1 pr-2 pl-3 text-[13px] transition-colors hover:bg-muted"
        >
          <span className="text-muted-foreground">{c.facet}:</span>
          <span className="font-medium">{c.label}</span>
          <X aria-hidden className="size-3.5" />
        </Link>
      ))}
      <Link href={clearAllHref} scroll={false} className="px-1 text-[13px] text-brand hover:underline">
        Clear all
      </Link>
    </div>
  );
}
