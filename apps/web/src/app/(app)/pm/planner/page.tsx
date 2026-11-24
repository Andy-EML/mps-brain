import Link from 'next/link';
import { cn } from 'cn';
import { lastGoodSyncRun, listPlannerRows, loadBoard, loadMapPins, loadUpcoming } from '@mps/db/queries';
import { Breadcrumb } from '@/components/breadcrumb';
import { PageHeader } from '@/components/page-header';
import { PlannerBoard } from '@/components/planner-board';
import { PlannerMap } from '@/components/planner-map';
import { PlannerPmsInArea } from '@/components/planner-pms-in-area';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { pmErrorMessage } from '@/lib/pm-action-form';
import { visibleColumnOf } from '@/lib/planner-columns';
import { upcomingView } from '@/lib/planner-upcoming';

export const metadata = { title: 'PM planner · MPS Dashboard' };

const PLANNER = '/pm/planner';
/** The engineers' diary job; the panel says when it has not refreshed lately. */
const SCHEDULE_JOB = 'vantage-schedule';

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * `/pm/planner`: the PM board — PMs in area (the upcoming-jobs panel, `#upcoming`) → Planned →
 * Booked; the plan's machines (and Priority machines) grouped by county, patch and postcode
 * district. Done cards are not shown. Reads our own database only (`loadBoard`
 * also runs the board sync, which writes `pm_plan` only); every action is recorded in
 * this app — nothing is written to Vantage.
 */
export default async function PmPlannerPage({ searchParams }: PageProps<'/pm/planner'>) {
  // First statement: the (app) layout's own requireUser() does not gate this page, because Next
  // fetches layout and page data in parallel.
  await requireUser();
  const params = await searchParams;
  const view = first(params.view) === 'board' ? 'board' : 'map';
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
  if (view === 'map') {
    const { pins, unlocated } = await loadMapPins(db, now, rows);
    const onMap = new Set(pins.map((p) => p.vantageEquipmentId));
    const deviceIds: Record<number, string> = {};
    for (const r of rows) if (r.drmsEquipmentId && onMap.has(r.vantageEquipmentId)) deviceIds[r.vantageEquipmentId] = r.drmsEquipmentId;
    // The map lists calls, not their suggestions: leave those out of the client payload.
    const engineers = upcoming.engineers.map((e) => ({
      ...e,
      days: e.days.map((d) => ({ ...d, calls: d.calls.map((c) => ({ ...c, suggestions: [] })) })),
    }));
    return (
      <>
        <PlannerHeader view="map" />
        {errorKey ? (
          <p role="alert" className="mb-4 rounded-lg bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive">
            {pmErrorMessage(errorKey)}
          </p>
        ) : null}
        <PlannerMap
          pins={pins}
          unlocated={unlocated}
          engineers={engineers}
          today={upcoming.today}
          tomorrow={upcoming.tomorrow}
          nearMiles={settings.nearMiles}
          deviceIds={deviceIds}
        />
      </>
    );
  }
  // Both days; the panel's Today / Tomorrow switch picks one.
  const upcomingPanel = upcomingView(upcoming, lastSchedule ? [lastSchedule] : [], now, error);
  // Forms post this back; the device page's Back returns to it. Errors and the card are not kept.
  const back = `${PLANNER}?view=board`;
  const pageError = errorKey && !error ? pmErrorMessage(errorKey) : null;
  // A refused action shows on its card, or under its suggestion; the page says it only when neither is on screen.
  // Done cards are not on the board, so an error on one counts as missing.
  const onBoard = cards.filter((c) => visibleColumnOf(c.column) !== null);
  const errorCardMissing = error !== null && !onBoard.some((c) => c.vantageEquipmentId === error.card) && !upcomingPanel.showsError;

  return (
    <>
      <PlannerHeader view="board" />

      {pageError || errorCardMissing ? (
        <p role="alert" className="mb-4 rounded-lg bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive">
          {pageError ?? error?.message}
        </p>
      ) : null}

      {onBoard.length === 0 ? (
        <p className="mb-4 rounded-lg border border-line bg-card px-4 py-2.5 text-[13px] text-muted-foreground">
          Nothing on the plan yet — add machines from the PMs in area, or use <em>Add to plan</em> on{' '}
          <Link href="/pm" className="text-brand hover:underline">
            PM due
          </Link>
          ; Priority machines join the plan on their own.
        </p>
      ) : null}

      <PlannerBoard
        cards={cards}
        patches={settings.patches}
        pmsInArea={
          // PMs in area (was Upcoming jobs): each engineer's booked calls, today or tomorrow, with nearby PMs; drag onto Planned.
          <aside id="upcoming" aria-labelledby="upcoming-heading" className="min-w-0">
            <PlannerPmsInArea view={upcomingPanel} />
          </aside>
        }
        back={back}
        error={error}
      />
    </>
  );
}

/** Breadcrumb, title and the Map | Board switch (links, so back and refresh keep the view). */
function PlannerHeader({ view }: { view: 'board' | 'map' }) {
  const tab = (active: boolean) =>
    cn(
      'rounded-full px-3 py-1.5 text-sm transition-colors',
      active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    );
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
      <nav aria-label="Planner view" className="mb-4 flex flex-wrap items-center gap-1">
        <Link href={PLANNER} aria-current={view === 'map' ? 'page' : undefined} className={tab(view === 'map')}>
          Map
        </Link>
        <Link href={`${PLANNER}?view=board`} aria-current={view === 'board' ? 'page' : undefined} className={tab(view === 'board')}>
          Board
        </Link>
      </nav>
    </>
  );
}
