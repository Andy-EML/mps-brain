'use client';

import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Star } from 'lucide-react';
import { cn } from 'cn';
import { addSuggestionToPlanAction, askEngineerAction } from '@/app/(app)/pm/planner/actions';
import { statusLabel, statusTone } from '@/components/pm-status';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
// Types only: the view model is built on the server (`upcomingView`), so no database value reaches the browser.
import type { UpcomingCallView, UpcomingEngineerView, UpcomingPanelView, UpcomingSuggestionView } from '@/lib/planner-upcoming';

export interface PlannerUpcomingProps {
  view: UpcomingPanelView;
  /** The planner URL the forms post back as `return`. */
  back: string;
}

/**
 * Upcoming jobs: each engineer's booked field calls for today and tomorrow, in scheduled order,
 * each with the due PMs near it (priority first, then overdue, due soon, when-in-area — muted).
 * *Asked engineer* records that the office rang the engineer (the card moves to Asked engineer);
 * *Add to plan* puts the machine on the board. Nothing is sent to the engineer or written to Vantage.
 */
export function PlannerUpcoming({ view, back }: PlannerUpcomingProps) {
  return (
    <section aria-labelledby="upcoming-heading" className="rounded-xl border border-line bg-muted/20">
      <header className="border-b border-line px-4 py-3">
        <h2 id="upcoming-heading" className="text-[15px] font-semibold">
          Upcoming jobs
        </h2>
        <p className="text-[12px] text-muted-foreground">
          Booked field calls today and tomorrow, with PMs nearby. Ring the engineer — nothing is sent from here.
        </p>
      </header>
      {view.empty !== null ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{view.empty}</p>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {view.engineers.map((e) => (
            <EngineerBlock key={e.key} engineer={e} back={back} />
          ))}
        </div>
      )}
    </section>
  );
}

function EngineerBlock({ engineer: e, back }: { engineer: UpcomingEngineerView; back: string }) {
  const headingId = `upcoming-eng-${e.key}`;
  return (
    <section aria-labelledby={headingId} className="px-4 py-3">
      <h3 id={headingId} className="text-[14px] font-semibold">
        {e.name}
      </h3>
      {e.days.map((d) => (
        <div key={d.which} className="mt-2">
          <h4 className="mb-1.5 text-[12px] font-medium text-muted-foreground">{d.heading}</h4>
          {d.calls.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">{d.emptyText}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {d.calls.map((c) => (
                <CallItem key={c.workUnitId} call={c} engineer={e} back={back} />
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}

function CallItem({ call: c, engineer, back }: { call: UpcomingCallView; engineer: UpcomingEngineerView; back: string }) {
  const meta = [c.category, c.reference].filter(Boolean).join(' · ');
  return (
    <li id={c.anchor} className="scroll-mt-24 rounded-lg border border-line bg-card p-2.5 text-[13px]">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold tabular-nums">{c.time}</span>
        <span className="min-w-0 flex-1 font-medium break-words">
          {c.customerLink ? (
            <Link href={c.customerLink} className="hover:underline">
              {c.customer}
            </Link>
          ) : (
            c.customer
          )}
        </span>
        {c.started ? (
          <ToneBadge tone="ok" className="px-2 py-0.5 text-[11px]">
            started
          </ToneBadge>
        ) : null}
      </div>
      {meta ? <p className="text-[12px] text-muted-foreground">{meta}</p> : null}
      {c.equipment ? <p className="text-[12px] break-words text-muted-foreground">{c.equipment}</p> : null}
      {c.locationNote ? <p className="mt-0.5 text-[12px] text-muted-foreground italic">{c.locationNote}</p> : null}

      {c.suggestions.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-muted-foreground">No due PMs nearby.</p>
      ) : (
        <ul aria-label={`PMs near ${c.customer} at ${c.time}`} className="mt-2 flex flex-col gap-1.5">
          {c.suggestions.map((s) => (
            <SuggestionItem key={s.id} s={s} call={c} engineer={engineer} back={back} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SuggestionItem({
  s,
  call,
  engineer,
  back,
}: {
  s: UpcomingSuggestionView;
  call: UpcomingCallView;
  engineer: UpcomingEngineerView;
  back: string;
}) {
  const who = `${s.customer}, ${s.machine}`;
  return (
    <li className={cn('rounded-md border p-2', s.whenInArea ? 'border-dashed border-line bg-muted/30 text-foreground/80' : 'border-line/70')}>
      <div className="flex items-start gap-1.5">
        {s.priority ? <Star role="img" aria-label="Priority" className="mt-0.5 size-3.5 shrink-0 fill-current text-warn" /> : null}
        <div className="min-w-0 flex-1">
          <p className="font-medium break-words">{s.customer}</p>
          <p className="text-[12px] break-words text-muted-foreground">{s.machine}</p>
        </div>
        {s.distanceText ? <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{s.distanceText}</span> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <ToneBadge tone={statusTone(s.status)} className="px-2 py-0.5 text-[11px]">
          {statusLabel(s.status)}
        </ToneBadge>
        {s.overdueText ? <span className="text-[12px] font-medium text-critical">{s.overdueText}</span> : null}
        {s.whenInArea ? (
          <ToneBadge tone="muted" dot={false} className="px-2 py-0.5 text-[11px]">
            When in area
          </ToneBadge>
        ) : null}
        {s.onBoardText ? <span className="text-[12px] text-brand">{s.onBoardText}</span> : null}
      </div>
      {s.error ? (
        <p role="alert" className="mt-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[12px] text-destructive">
          {s.error}
        </p>
      ) : null}
      {s.canAsk || s.canAdd ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {s.canAsk ? (
            <form action={askEngineerAction}>
              <SuggestionFields id={s.id} call={call.workUnitId} back={back} />
              <SubmitButton text="Asked engineer" subject={`${engineer.name} about ${who}`} pendingText="Saving…" primary />
            </form>
          ) : null}
          {s.canAdd ? (
            <form action={addSuggestionToPlanAction}>
              <SuggestionFields id={s.id} call={call.workUnitId} back={back} />
              <SubmitButton text="Add to plan" subject={who} pendingText="Adding…" />
            </form>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Hidden fields both suggestion forms post: the machine, the call (Ask reads the engineer from it; both come back to it) and the planner URL. */
function SuggestionFields({ id, call, back }: { id: number; call: number; back: string }) {
  return (
    <>
      <input type="hidden" name="vantageEquipmentId" value={id} />
      <input type="hidden" name="call" value={call} />
      <input type="hidden" name="return" value={back} />
    </>
  );
}

function SubmitButton({
  text,
  subject,
  pendingText,
  primary = false,
}: {
  /** The visible text. */
  text: string;
  /** Which machine: the accessible name is `<visible text>: <subject>`, pending or not. */
  subject: string;
  pendingText: string;
  primary?: boolean;
}) {
  const { pending } = useFormStatus();
  const shown = pending ? pendingText : text;
  return (
    <Button
      type="submit"
      size="sm"
      variant={primary ? 'default' : 'outline'}
      disabled={pending}
      aria-label={`${shown}: ${subject}`}
      className={cn('h-8 px-2.5 text-[12px]', primary && 'bg-brand hover:bg-brand/90')}
    >
      {shown}
    </Button>
  );
}
