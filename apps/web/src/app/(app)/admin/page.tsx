import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { getAppStateValue, listCounterNames, listSyncRuns, listUsers } from '@mps/db/queries';
import { AdminNav } from '@/components/admin-nav';
import { tokenExpiry } from '@/components/admin-jobs';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/tone-badge';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatNumber, formatRelative, pluralise } from '@/lib/format';

export const metadata = { title: 'Admin · MPS Dashboard' };

export default async function AdminPage() {
  // First statement. The sidebar hides the Admin link from operators, which gates nothing.
  const admin = await requireAdmin();

  const db = getDb();
  const [users, counters, runs, expiryValue] = await Promise.all([
    listUsers(db),
    listCounterNames(db),
    listSyncRuns(db, 1),
    getAppStateValue<string>(db, 'drms_token_expiry'),
  ]);

  const now = new Date();
  const token = tokenExpiry(expiryValue, now);
  const activeUsers = users.filter((row) => row.active).length;
  const categorised = counters.filter((row) => row.category != null).length;
  const lastRun = runs[0];

  const cards = [
    {
      href: '/admin/users',
      title: 'Users',
      value: `${formatNumber(users.length)} ${pluralise(users.length, 'account')}`,
      sub: `${formatNumber(activeUsers)} active · ${formatNumber(users.length - activeUsers)} deactivated`,
    },
    {
      href: '/admin/counters',
      title: 'Counter names',
      value: `${formatNumber(counters.length)} ${pluralise(counters.length, 'name')}`,
      sub: `${formatNumber(categorised)} categorised · ${formatNumber(counters.length - categorised)} unset`,
    },
    {
      href: '/admin/jobs',
      title: 'Jobs',
      value: lastRun ? lastRun.job : 'Nothing yet',
      sub: lastRun ? `${lastRun.status} · ${formatRelative(lastRun.startedAt, now)}` : 'No job has run yet',
    },
  ];

  return (
    <>
      <PageHeader title="Admin" subtitle={`Signed in as ${admin.username ?? 'an admin'}`} />

      <AdminNav current="overview" />

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="rounded-xl border border-line bg-card px-5 py-4 transition-colors hover:border-ring/40 hover:bg-muted/40"
          >
            <p className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
              {card.title}
              <ChevronRight aria-hidden className="size-4" />
            </p>
            <p className="mt-2 truncate text-[22px] leading-tight font-semibold">{card.value}</p>
            <p className="mt-2 text-[13px] text-muted-foreground">{card.sub}</p>
          </Link>
        ))}
      </div>

      <section
        className={
          token.warn
            ? 'mt-4 rounded-xl border border-warn/40 bg-warn/5 px-5 py-4'
            : 'mt-4 rounded-xl border border-line bg-card px-5 py-4'
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-medium">DRMS token</h2>
          <ToneBadge tone={token.tone}>{token.expired ? 'Expired' : token.warn ? 'Expiring soon' : 'Valid'}</ToneBadge>
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">{token.label}</p>
      </section>

      <p className="mt-4 max-w-3xl text-xs text-muted-foreground">
        These pages are admin-only. Operators are sent back to the fleet overview, whether they follow a
        link or post an action by hand.
      </p>
    </>
  );
}
