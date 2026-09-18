import { AppSidebar } from '@/components/app-sidebar';
import { Toaster } from '@/components/ui/sonner';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getNavCounts } from '@/lib/nav-counts';

/** Every page inside this group needs a session, so the shell can never be prerendered. */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const user = await requireUser();
  const counts = await getNavCounts(getDb());

  return (
    <div className="flex min-h-screen bg-page">
      <AppSidebar
        username={user.username ?? 'Unknown'}
        role={user.role ?? 'operator'}
        openAlerts={counts.openAlerts}
        openIssues={counts.openIssues}
      />
      <main className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-shell px-8 py-8">{children}</div>
      </main>
      {/* Task 4 shipped the sonner wrapper unmounted; the issues queue is the first screen whose
          actions finish inside a dialog and so need a confirmation the operator can see. */}
      <Toaster position="bottom-right" />
    </div>
  );
}
