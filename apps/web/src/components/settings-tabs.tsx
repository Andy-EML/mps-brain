import Link from 'next/link';
import { cn } from 'cn';

const TABS = [
  { href: '/settings/replenishment', label: 'Replenishment' },
  { href: '/settings/cartridge-families', label: 'Cartridge families' },
] as const;

export type SettingsTab = (typeof TABS)[number]['href'];

/**
 * The pill row that moves between the settings pages. `FilterTabs` switches a query param on one
 * page; these are separate pages, so each pill is its own path. Same look.
 */
export function SettingsTabs({ current, className }: { current: SettingsTab; className?: string }) {
  return (
    <nav aria-label="Settings" className={cn('mb-5 flex flex-wrap items-center gap-1', className)}>
      {TABS.map((tab) => {
        const active = tab.href === current;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-full px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
