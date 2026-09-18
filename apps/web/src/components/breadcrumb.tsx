import Link from 'next/link';
import { cn } from 'cn';

export interface Crumb {
  label: string;
  /** Omit on the last crumb — the page you are already on is not a link. */
  href?: string;
}

/** `Fleet overview / Customer / Device`, as in the mockup. */
export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn('text-[13px]', className)}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-2">
            {i > 0 ? (
              <span aria-hidden className="text-muted-foreground/50">
                /
              </span>
            ) : null}
            {item.href ? (
              <Link href={item.href} className="truncate text-brand hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className="truncate text-muted-foreground" aria-current="page">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
