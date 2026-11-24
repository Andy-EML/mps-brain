'use client';

import { useCallback, useId, useState, useTransition, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, GripVertical, Star } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { mapAddToPlanAction, mapAskEngineerAction, type MapActionResult } from '@/app/(app)/pm/planner/map-actions';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { PM_IDS_MIME, dayPanel, dragPayload, type DayEngineer } from '@/lib/planner-pms-in-area';
// Types only: the view model is built on the server (`upcomingView`), so no database value reaches the browser.
import type { UpcomingCallView, UpcomingPanelView, UpcomingSuggestionView } from '@/lib/planner-upcoming';

const SAVE_FAILED = "Couldn't save — try again";

type Day = 'today' | 'tomorrow';

/** The visible Ask button names the engineer by first name (the accessible name has the full name). */
const firstName = (name: string) => name.trim().split(/\s+/, 1)[0] || name;

/**
 * Runs a planner action from the client: toast the result and refresh the page data (no redirect).
 * Shared by the PMs-in-area buttons and the Planned drop zone.
 */
export function usePlannerSave() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const save = useCallback(
    (call: () => Promise<MapActionResult>) =>
      startTransition(async () => {
        let r: MapActionResult;
        try {
          r = await call();
        } catch {
          toast.error(SAVE_FAILED);
          return;
        }
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success(r.text);
        router.refresh();
      }),
    [router],
  );
  return { save, pending };
}

/** Starts a drag of some machines (Planned takes the drop). */
function startDrag(e: DragEvent, ids: number[], subject: string) {
  e.dataTransfer.setData(PM_IDS_MIME, dragPayload(ids));
  e.dataTransfer.setData('text/plain', subject);
  e.dataTransfer.effectAllowed = 'copy';
}

export interface PlannerPmsInAreaProps {
  /** Both days; the Today / Tomorrow switch picks one. */
  view: UpcomingPanelView;
}

/**
 * PMs in area (was Upcoming jobs): each engineer's booked field calls for today or tomorrow, one
 * line per call (`09:30 Bravo Ltd · 4 nearby`), collapsed. A click opens a call to its due machines
 * (it stays open until clicked again; hovering only previews them in a tooltip, so nothing moves),
 * one line each; machines at the call's own site fold into one line, also opened by a click. Each
 * engineer's block collapses from its heading (open to start). Drag a machine (or the site line)
 * onto Planned, or use *Add to plan* / *Ask <engineer>*. Machines already on the board show their
 * column (a Planned one can still be asked about). Recorded in this app only — the office rings the engineer; nothing goes to Vantage.
 */
export function PlannerPmsInArea({ view }: PlannerPmsInAreaProps) {
  const [day, setDay] = useState<Day>('today');
  const { save, pending } = usePlannerSave();
  const panel = dayPanel(view, day);

  return (
    <section aria-labelledby="upcoming-heading" className="rounded-xl border border-line bg-muted/20">
      <header className="flex flex-wrap items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="upcoming-heading" className="text-[15px] font-semibold">
            PMs in area
          </h2>
          <p className="text-[12px] text-muted-foreground">
            Due PMs near engineers&apos; booked calls. Drag onto Planned, or use the buttons. Ring the engineer — nothing is sent from here.
          </p>
        </div>
        <div role="group" aria-label="Day" className="flex shrink-0 rounded-full border border-line bg-card p-0.5">
          {(['today', 'tomorrow'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={day === d}
              onClick={() => setDay(d)}
              className={cn(
                'rounded-full px-2.5 py-1 text-[12px] transition-colors',
                day === d ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {view.dayLabels[d]}
            </button>
          ))}
        </div>
      </header>
      {panel.empty !== null ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{panel.empty}</p>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {panel.engineers.map((e) => (
            <EngineerBlock key={e.key} engineer={e} save={save} pending={pending} />
          ))}
        </div>
      )}
    </section>
  );
}

interface ActionProps {
  save: (call: () => Promise<MapActionResult>) => void;
  pending: boolean;
}

function EngineerBlock({ engineer: e, save, pending }: { engineer: DayEngineer } & ActionProps) {
  const [open, setOpen] = useState(true);
  const headingId = `upcoming-eng-${e.key}`;
  const listId = useId();
  return (
    <section aria-labelledby={headingId} className="px-3 py-2">
      <h3 id={headingId} className="text-[13px] font-semibold">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted/60"
        >
          <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums">
            {e.calls.length} {e.calls.length === 1 ? 'call' : 'calls'}
          </span>
        </button>
      </h3>
      {open ? (
        <ol id={listId} className="mt-1 flex flex-col gap-0.5">
          {e.calls.map((c) => (
            <CallRow key={c.workUnitId} call={c} engineer={e} save={save} pending={pending} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function CallRow({ call: c, engineer, save, pending }: { call: UpcomingCallView; engineer: DayEngineer } & ActionProps) {
  // Collapsed to start; a click toggles it and it stays that way.
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const empty = c.nearby === 0;

  const meta = [c.category, c.reference, c.equipment].filter(Boolean).join(' · ');
  // Hover preview without moving anything: the machines in the line's tooltip.
  const preview = [meta, c.siteText, ...c.others.map((s) => s.line)].filter(Boolean).join('\n');
  return (
    <li id={c.anchor} className={cn('scroll-mt-24 rounded-md text-[13px]', expanded && !empty && 'bg-card ring-1 ring-line')}>
      <button
        type="button"
        aria-expanded={empty ? undefined : expanded}
        aria-controls={empty ? undefined : bodyId}
        disabled={empty}
        onClick={() => setExpanded((x) => !x)}
        title={preview || undefined}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90', empty && 'invisible')}
        />
        <span className={cn('min-w-0 flex-1 truncate', empty && 'text-muted-foreground')}>
          <span className="font-semibold tabular-nums">{c.time}</span> {c.customer}
          <span className="text-muted-foreground"> · {empty ? 'none' : c.nearby} nearby</span>
        </span>
        {c.started ? (
          <ToneBadge tone="ok" dot={false} className="shrink-0 px-1.5 py-0 text-[10px]">
            started
          </ToneBadge>
        ) : null}
      </button>
      {expanded && !empty ? (
        <div id={bodyId} className="px-1.5 pb-1.5">
          {c.customerLink || c.locationNote ? (
            <p className="truncate pl-5 text-[11px] text-muted-foreground">
              {c.customerLink ? (
                <Link href={c.customerLink} className="hover:underline">
                  Customer page
                </Link>
              ) : null}
              {c.customerLink && c.locationNote ? ' · ' : null}
              {c.locationNote ? <span className="italic">{c.locationNote}</span> : null}
            </p>
          ) : null}
          <ul aria-label={`PMs near ${c.customer} at ${c.time}`} className="mt-0.5 flex flex-col gap-0.5">
            {c.site.length > 0 && c.siteText ? <SiteGroup call={c} engineer={engineer} save={save} pending={pending} /> : null}
            {c.others.map((s) => (
              <MachineRow key={s.id} s={s} call={c} engineer={engineer} save={save} pending={pending} />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

/** The machines at the call's own site, folded into one line with Add all / Ask for all. */
function SiteGroup({ call: c, engineer, save, pending }: { call: UpcomingCallView; engineer: DayEngineer } & ActionProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const addIds = c.site.filter((s) => s.canAdd).map((s) => s.id);
  const askIds = c.site.filter((s) => s.canAsk).map((s) => s.id);
  const subject = c.siteText ?? c.customer;
  const draggable = addIds.length > 0 && !pending;
  return (
    <li>
      <div
        draggable={draggable}
        onDragStart={draggable ? (e) => startDrag(e, addIds, subject) : undefined}
        className={cn('flex min-w-0 items-center gap-1 rounded px-1 py-0.5', draggable && 'cursor-grab hover:bg-muted/60')}
      >
        <GripVertical aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground', !draggable && 'invisible')} />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium"
        >
          <span className="truncate">{c.siteText}</span>
          <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        </button>
        {addIds.length > 0 ? (
          <>
            <SmallButton label="Add all" aria={`Add all to plan: ${subject}`} disabled={pending} onClick={() => save(() => mapAddToPlanAction(addIds))} />
            {askIds.length > 0 ? (
              <SmallButton
                label="Ask for all"
                aria={`Ask ${engineer.name} for all: ${subject}`}
                primary
                disabled={pending}
                onClick={() => save(() => mapAskEngineerAction(askIds, c.workUnitId))}
              />
            ) : null}
          </>
        ) : (
          <span className="shrink-0 text-[11px] text-brand">All on board</span>
        )}
      </div>
      {open ? (
        <ul id={listId} aria-label={subject} className="ml-4 flex flex-col gap-0.5 border-l border-line pl-1">
          {c.site.map((s) => (
            <MachineRow key={s.id} s={s} call={c} engineer={engineer} save={save} pending={pending} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function MachineRow({
  s,
  call,
  engineer,
  save,
  pending,
}: { s: UpcomingSuggestionView; call: UpcomingCallView; engineer: DayEngineer } & ActionProps) {
  const who = `${s.customer}, ${s.machine}`;
  const draggable = s.canAdd && !pending;
  return (
    <li>
      <div
        draggable={draggable}
        onDragStart={draggable ? (e) => startDrag(e, [s.id], who) : undefined}
        title={`${s.machine}${s.whenInArea ? ' · when in area' : ''}`}
        className={cn(
          'flex min-w-0 items-center gap-1 rounded px-1 py-0.5',
          draggable && 'cursor-grab hover:bg-muted/60',
          s.whenInArea && 'text-foreground/70',
        )}
      >
        <GripVertical aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted-foreground', !draggable && 'invisible')} />
        {s.priority ? <Star role="img" aria-label="Priority" className="size-3 shrink-0 fill-current text-warn" /> : null}
        <span className={cn('min-w-0 flex-1 truncate', s.whenInArea && 'italic')}>{s.line}</span>
        {s.onBoard !== null ? <span className="shrink-0 text-[11px] text-brand">{s.onBoard}</span> : null}
        {s.canAdd ? (
          <SmallButton label="Add to plan" aria={`Add to plan: ${who}`} disabled={pending} onClick={() => save(() => mapAddToPlanAction([s.id]))} />
        ) : null}
        {s.canAsk ? (
          <SmallButton
            label={`Ask ${firstName(engineer.name)}`}
            aria={`Ask ${engineer.name}: ${who}`}
            primary
            disabled={pending}
            onClick={() => save(() => mapAskEngineerAction([s.id], call.workUnitId))}
          />
        ) : null}
      </div>
    </li>
  );
}

function SmallButton({
  label,
  aria,
  onClick,
  disabled,
  primary = false,
}: {
  label: string;
  /** Accessible name: says which machine(s). */
  aria: string;
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={primary ? 'default' : 'outline'}
      disabled={disabled}
      aria-label={aria}
      onClick={onClick}
      className={cn('h-6 shrink-0 px-1.5 text-[11px]', primary && 'bg-brand hover:bg-brand/90')}
    >
      {label}
    </Button>
  );
}
