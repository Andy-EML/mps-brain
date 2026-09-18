import { Bell, LayoutGrid, Link2Off, LogOut, Printer, Settings } from 'lucide-react';
import { signOut } from '@/app/(app)/actions';
import { NavLink } from '@/components/nav-link';
import { Wordmark } from '@/components/wordmark';
import type { NavCounts } from '@/lib/nav-counts';

export interface AppSidebarProps extends NavCounts {
  username: string;
  role: 'admin' | 'operator';
}

function initials(username: string): string {
  const parts = username.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : username.slice(0, 2);
  return letters.toUpperCase();
}

export function AppSidebar({ username, role, openAlerts, openIssues }: AppSidebarProps) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="px-5 pt-6 pb-5">
        <Wordmark />
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5 px-3">
        <NavLink href="/" label="Fleet overview" icon={<LayoutGrid />} exact />
        <NavLink href="/devices" label="Devices" icon={<Printer />} />
        <NavLink href="/alerts" label="Alerts" icon={<Bell />} count={openAlerts} tone="critical" />
        <NavLink href="/issues" label="Link issues" icon={<Link2Off />} count={openIssues} tone="warn" />
        {role === 'admin' ? <NavLink href="/admin" label="Admin" icon={<Settings />} /> : null}
      </nav>

      <div className="mt-auto border-t border-line px-4 py-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand"
          >
            {initials(username)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{username}</span>
            <span className="block text-xs text-muted-foreground capitalize">{role}</span>
          </span>
          <form action={signOut}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <LogOut className="size-[18px]" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
