'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from 'cn';

export interface NavLinkProps {
  href: string;
  label: string;
  icon: ReactNode;
  /** Badge count; hidden when 0 or undefined. */
  count?: number;
  /** Badge tone — alerts are red in the mockup, link issues amber. */
  tone?: 'critical' | 'warn';
  /** `/` would otherwise match every route, so exact matching is opt-in. */
  exact?: boolean;
}

export function NavLink({ href, label, icon, count, tone = 'critical', exact }: NavLinkProps) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors',
        '[&_svg]:size-[18px] [&_svg]:shrink-0',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-foreground/85 hover:bg-muted',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {count ? (
        <span
          className={cn(
            'ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular',
            tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-critical/10 text-critical',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
