import Link from 'next/link';
import { lastGoodSyncRun, listPlannerRows, loadBoard, loadUpcoming } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageHeader } from '@/components/page-header';
import { PlannerBoard } from '@/components/planner-board';
import { PlannerUpcoming } from '@/components/planner-upcoming';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { pmErrorMessage } from '@/lib/pm-action-form';
import { upcomingView } from '@/lib/planner-upcoming';

export const metadata = { title: 'PM planner · MPS Dashboard' };

const PLANNER = '/pm/planner';
/** The engineers' diary job; the panel says when it has not refreshed lately. */
const SCHEDULE_JOB = 'vantage-schedule';

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * `/pm/planner`: the PM board — the machines the office put on the plan (and Priority machines),
 * in To plan → Asked engineer → Booked → Done, grouped by county, patch and postcode district —
 * with the upcoming-jobs panel (`#upcoming`) beside it. Reads our own database only (`loadBoard`
 * also runs the board sync, which writes `pm_plan` only); every action is recorded in
 * this app — nothing is written to Vantage.
 */
export default async function PmPlannerPage({ searchParams }: PageProps<'/pm/planner'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;
  const cardRaw = first(params.card);
  const errorKey = first(params.plannerError);
  const error =
    errorKey && cardRaw && /^\d{1,10}$/.test(cardRaw) ? { card: Number(cardRaw), message: pmErrorMessage(errorKey) } : null;

  const db = getDb();
  const now = new Date();
  // The PM list once for both loaders. The board first: its sync writes `pm_plan` (the PM rows do
  // not depend on it), and `loadUpcoming` reads the plan rows afresh for the suggestions' "On board".
  const [rows, lastSchedule] = await Promise.all([listPlannerRows(db, now), lastGoodSyncRun(db, SCHEDULE_JOB)]);
  const { cards, settings } = await loadBoard(db, now, rows);
  const upcoming = await loadUpcoming(db, now, rows);
  const upcomingPanel = upcomingView(upcoming, lastSchedule ? [lastSchedule] : [], now, error);
  // Forms post this back; the device page's Back returns to it. Errors and the card are not kept.
  const back = PLANNER;
  const pageError = errorKey && !error ? pmErrorMessage(errorKey) : null;
  // A refused action shows on its card, or under its suggestion; the page says it only when neither is on screen.
  const errorCardMissing = error !== null && !cards.some((c) => c.vantageEquipmentId === error.card) && !upcomingPanel.showsError;

  return (
    <>
      <Breadcrumb
        className="mb-3"
        items={[{ label: 'Fleet overview', href: '/' }, { label: 'PM due', href: '/pm' }, { label: 'PM planner' }]}
      />
      <PageHeader
        title="PM planner"
        subtitle="Machines on the plan, by area. Moves and bookings are recorded in this app only — book PM in Vantage."
        actions={
          <Link
            href="/pm"
            className="flex h-10 items-center rounded-lg border border-line bg-card px-3.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            ← PM due
          </Link>
        }
      />

      {pageError || errorCardMissing ? (
        <p role="alert" className="mb-4 rounded-lg bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive">
          {pageError ?? error?.message}
        </p>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          {cards.length === 0 ? (
            <section className="rounded-xl border border-line bg-card px-5 py-10 text-center text-[14px]">
              <p className="font-medium">Nothing on the plan yet — add machines from PM due</p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Use <em>Add to plan</em> on a machine in the Due or When in area tab; Priority machines join the plan on their own.
              </p>
              <Link href="/pm" className="mt-3 inline-block text-[13px] text-brand hover:underline">
                Go to PM due
              </Link>
            </section>
          ) : (
            <PlannerBoard
              cards={cards}
              patches={settings.patches}
              doneRetentionDays={settings.doneRetentionDays}
              back={back}
              error={error}
            />
          )}
        </div>
        {/* Upcoming jobs: each engineer's booked calls for today and tomorrow with nearby PMs. */}
        <aside id="upcoming" aria-labelledby="upcoming-heading" className="min-w-0">
          <PlannerUpcoming view={upcomingPanel} back={back} />
        </aside>
      </div>
    </>
  );
}
