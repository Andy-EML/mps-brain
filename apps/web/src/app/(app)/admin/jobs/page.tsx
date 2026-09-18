import { getAppStateValue, listSyncRuns } from '@mps/db/queries';
import { AdminNav } from '@/components/admin-nav';
import { JOB_CARDS, tokenExpiry } from '@/components/admin-jobs';
import { JobRunTable } from '@/components/job-run-table';
import { JobTriggerButton } from '@/components/job-trigger-button';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/tone-badge';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { formatRelative } from '@/lib/format';

export const metadata = { title: 'Jobs · Admin · MPS Dashboard' };

/** The plan's window. Twenty runs is about a week of scheduled work plus any manual ones. */
const LIMIT = 20;

export default async function AdminJobsPage() {
  // First statement — see the note in `actions.ts`: an admin page is a public URL until this runs.
  await requireAdmin();

  const db = getDb();
  const [runs, expiryValue] = await Promise.all([
    listSyncRuns(db, LIMIT),
    // Only ever the *expiry date*. The token itself lives in the worker's environment and has no
    // business in a page, a log or a URL.
    getAppStateValue<string>(db, 'drms_token_expiry'),
  ]);

  const now = new Date();
  const token = tokenExpiry(expiryValue, now);
  const lastRun = runs[0];

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle={
          lastRun
            ? `Last run: ${lastRun.job} ${formatRelative(lastRun.startedAt, now)} · ${lastRun.status}`
            : 'No job has run yet.'
        }
      />

      <AdminNav current="jobs" />

      <section
        className={
          token.warn
            ? 'mt-5 rounded-xl border border-warn/40 bg-warn/5 px-5 py-4'
            : 'mt-5 rounded-xl border border-line bg-card px-5 py-4'
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-medium">DRMS token</h2>
          <ToneBadge tone={token.tone}>{token.expired ? 'Expired' : token.warn ? 'Expiring soon' : 'Valid'}</ToneBadge>
        </div>
        <p className="mt-1.5 text-sm text-muted-foreground">{token.label}</p>
      </section>

      <section className="mt-5">
        <h2 className="mb-3 text-[15px] font-medium">Run a job now</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {JOB_CARDS.map((card) => (
            <div key={card.queue} className="flex flex-col rounded-xl border border-line bg-card px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium">{card.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">{card.queue}</p>
                </div>
                <JobTriggerButton
                  queue={card.queue}
                  confirm={
                    card.external
                      ? `Run ${card.title} now? It calls the live ${card.queue.startsWith('vantage') ? 'Vantage' : 'DRMS'} API.`
                      : undefined
                  }
                />
              </div>
              <p className="mt-2 text-[13px] text-muted-foreground">{card.description}</p>
              <p className="mt-auto pt-2 text-xs text-muted-foreground">Normally: {card.schedule}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 max-w-3xl text-xs text-muted-foreground">
          “Run now” queues the job — the worker picks it up and writes a row below when it starts. If the
          worker is not running, the job waits in the queue until it is.
        </p>
      </section>

      <section className="mt-6 rounded-xl border border-line bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-medium">Recent runs</h2>
          <p className="text-xs text-muted-foreground">Last {LIMIT}</p>
        </div>
        <JobRunTable rows={runs} now={now} />
      </section>
    </>
  );
}
