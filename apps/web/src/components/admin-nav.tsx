import Link from 'next/link';
import { cn } from 'cn';

export type AdminSection = 'overview' | 'users' | 'counters' | 'jobs';

const SECTIONS: { key: AdminSection; href: string; label: string }[] = [
  { key: 'overview', href: '/admin', label: 'Overview' },
  { key: 'users', href: '/admin/users', label: 'Users' },
  { key: 'counters', href: '/admin/counters', label: 'Counter names' },
  { key: 'jobs', href: '/admin/jobs', label: 'Jobs' },
];

/**
 * The admin section's own tab row. `current` is passed in by each page rather than read from
 * `usePathname`, so this stays a server component.
 */
export function AdminNav({ current }: { current: AdminSection }) {
  return (
    <nav aria-label="Admin sections" className="flex flex-wrap items-center gap-1">
      {SECTIONS.map((section) => {
        const active = section.key === current;
        return (
          <Link
            key={section.key}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-full px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
