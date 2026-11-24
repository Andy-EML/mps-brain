'use client';

import { useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Ellipsis, Star } from 'lucide-react';
// Types only from @mps/db: its values would pull the database client into the browser bundle.
import type { BoardCard, BoardColumn } from '@mps/db/queries';
import { cn } from 'cn';
import { bookCardAction, moveCardAction, removeCardAction, togglePriorityPlannerAction } from '@/app/(app)/pm/planner/actions';
import { statusLabel, statusTone } from '@/components/pm-status';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { machineActionLabel } from '@/lib/format';

const FIELD_LABEL = 'mb-1 block text-[12px] text-muted-foreground';

export interface PlannerCardProps {
  card: BoardCard;
  /** The planner URL the forms post back as `return`. */
  back: string;
  /** `reasonBadgeText(card)`, worked out on the server. */
  badge: string | null;
  /** The customer's page, or null when the card has no customer. */
  customerLink: string | null;
  /** The device page (opened from the planner), or null when the machine has no DRMS device. */
  deviceLink: string | null;
  /** An action on this card was refused: the sentence to show on it. */
  error: string | null;
}

type Panel = 'book' | 'note' | null;

/**
 * One machine on the planner board: customer, serial / model, PM status, months overdue (red), the
 * Priority star, the reason badge and note, a *Move to…* menu and *Remove*. When-in-area machines are
 * drawn muted (dashed). *Booked…* opens the Mark-booked form inside the card (Booked is derived from
 * the booking it records); *Note…* edits the note on To plan / Asked cards. Menu items submit hidden
 * forms that stay in the card, so closing the menu never unmounts a pending action.
 */
export function PlannerCard({ card: c, back, badge, customerLink, deviceLink, error }: PlannerCardProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const moveForms = useRef<Partial<Record<'to_plan' | 'asked' | 'done', HTMLFormElement | null>>>({});
  const removeForm = useRef<HTMLFormElement>(null);
  const id = c.vantageEquipmentId;
  const booked = c.column === 'booked';
  const canNote = c.column === 'to_plan' || c.column === 'asked';
  const customer = c.customerName ?? 'Unknown customer';
  const machine = [c.model, c.serial].filter(Boolean).join(' · ') || 'Unknown machine';

  const move = (to: 'to_plan' | 'asked' | 'done') => moveForms.current[to]?.requestSubmit();

  return (
    <li
      id={`card-${id}`}
      className={cn(
        'scroll-mt-24 rounded-lg border bg-card p-3 text-[13px] shadow-xs',
        c.whenInArea ? 'border-dashed border-line bg-muted/30' : 'border-line',
        c.leftDue !== null && 'border-warn/50',
      )}
    >
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <p className={cn('font-medium break-words', c.whenInArea && 'text-foreground/80')}>
            {customerLink ? (
              <Link href={customerLink} className="hover:underline">
                {customer}
              </Link>
            ) : (
              customer
            )}
          </p>
          {c.town ? <p className="text-[12px] text-muted-foreground">{c.town}</p> : null}
          <p className="mt-0.5 text-[12px] break-words text-muted-foreground">
            {deviceLink ? (
              <Link href={deviceLink} className="text-brand hover:underline">
                {machine}
              </Link>
            ) : (
              machine
            )}
          </p>
        </div>
        <form action={togglePriorityPlannerAction}>
          <CardFields id={id} back={back} />
          <input type="hidden" name="on" value={c.priority ? 'false' : 'true'} />
          <StarButton pressed={c.priority} label={machineActionLabel('Priority', c.customerName, c.serial)} />
        </form>
        {(['to_plan', 'asked', 'done'] as const).map((to) => (
          <form
            key={to}
            ref={(el) => {
              moveForms.current[to] = el;
            }}
            action={moveCardAction}
            hidden
          >
            <CardFields id={id} back={back} />
            <input type="hidden" name="to" value={to} />
          </form>
        ))}
        <form ref={removeForm} action={removeCardAction} hidden>
          <CardFields id={id} back={back} />
        </form>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`Move ${customer} to…`}
            title="Move to…"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none"
          >
            <Ellipsis aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Move to…</DropdownMenuLabel>
              <MoveItem label="To plan" current={c.column} to="to_plan" disabled={booked} onMove={move} />
              <MoveItem label="Asked engineer" current={c.column} to="asked" disabled={booked} onMove={move} />
              <DropdownMenuItem onClick={() => setPanel('book')} className="text-[13px]">
                {booked ? 'Booked — change booking…' : 'Booked…'}
              </DropdownMenuItem>
              <MoveItem label="Done" current={c.column} to="done" onMove={move} />
            </DropdownMenuGroup>
            {booked ? (
              <p className="px-1.5 py-1 text-[12px] text-muted-foreground">
                Booked follows the booking: undo it on PM due to move the card back.
              </p>
            ) : null}
            <DropdownMenuSeparator />
            {canNote ? (
              <DropdownMenuItem onClick={() => setPanel('note')} className="text-[13px]">
                {c.note ? 'Edit note…' : 'Add note…'}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem variant="destructive" onClick={() => removeForm.current?.requestSubmit()} className="text-[13px]">
              Remove from plan
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {c.status ? (
          <ToneBadge tone={statusTone(c.status)} className="px-2 py-0.5 text-[12px]">
            {statusLabel(c.status)}
          </ToneBadge>
        ) : null}
        {c.overdueMonths !== null && c.overdueMonths >= 1 ? (
          <span className="text-[12px] font-medium text-critical">overdue {c.overdueMonths}m</span>
        ) : null}
        {c.whenInArea ? (
          <ToneBadge tone="muted" dot={false} className="px-2 py-0.5 text-[12px]">
            When in area
          </ToneBadge>
        ) : null}
        {c.district ? <span className="text-[12px] text-muted-foreground">{c.district}</span> : null}
      </div>

      {badge ? (
        <p className="mt-2">
          <ToneBadge tone={c.leftDue !== null || c.askedStale ? 'warn' : 'muted'} dot={false} className="px-2 py-0.5 text-[12px] whitespace-normal">
            {badge}
          </ToneBadge>
        </p>
      ) : null}
      {/* The card's own reason when the badge is saying something else (it left the due set, or a stale ask). */}
      {c.reason && badge !== c.reason ? <p className="mt-1.5 text-[12px] text-muted-foreground">{c.reason}</p> : null}
      {c.note ? <p className="mt-1.5 text-[12px] break-words whitespace-pre-line">{c.note}</p> : null}

      {error ? (
        <p role="alert" className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      {c.leftDue !== null ? (
        <form action={removeCardAction} className="mt-2">
          <CardFields id={id} back={back} />
          <SubmitButton variant="outline" pendingText="Removing…" ariaLabel={machineActionLabel('Remove', c.customerName, c.serial)}>
            Remove
          </SubmitButton>
        </form>
      ) : null}

      {panel === 'book' ? <BookForm id={id} back={back} onCancel={() => setPanel(null)} /> : null}
      {panel === 'note' && canNote ? (
        <NoteForm id={id} back={back} column={c.column as 'to_plan' | 'asked'} note={c.note} onCancel={() => setPanel(null)} />
      ) : null}
    </li>
  );
}

function MoveItem({
  label,
  to,
  current,
  disabled = false,
  onMove,
}: {
  label: string;
  to: 'to_plan' | 'asked' | 'done';
  current: BoardColumn;
  disabled?: boolean;
  onMove: (to: 'to_plan' | 'asked' | 'done') => void;
}) {
  const here = current === to;
  return (
    <DropdownMenuItem disabled={here || disabled} onClick={() => onMove(to)} className="text-[13px]">
      {label}
      {here ? <span className="ml-auto text-[11px] text-muted-foreground">here</span> : null}
    </DropdownMenuItem>
  );
}

/** Hidden fields every card form posts: the machine and the planner URL to come back to. */
function CardFields({ id, back }: { id: number; back: string }) {
  return (
    <>
      <input type="hidden" name="vantageEquipmentId" value={id} />
      <input type="hidden" name="return" value={back} />
    </>
  );
}

/** The Mark-booked form (same fields as on PM due), inside the card. */
function BookForm({ id, back, onCancel }: { id: number; back: string; onCancel: () => void }) {
  const uid = useId();
  return (
    <form action={bookCardAction} className="mt-3 rounded-md border border-line p-3" aria-label="Mark booked">
      <p className="mb-2 text-[12px] text-muted-foreground">Recorded here only — book the PM in Vantage.</p>
      <CardFields id={id} back={back} />
      <div className="grid gap-2">
        <div>
          <label htmlFor={`${uid}-date`} className={FIELD_LABEL}>
            Booked for (optional)
          </label>
          <Input id={`${uid}-date`} type="date" name="bookedFor" className="h-9" autoFocus />
        </div>
        <div>
          <label htmlFor={`${uid}-ref`} className={FIELD_LABEL}>
            Vantage job reference (optional)
          </label>
          <Input id={`${uid}-ref`} name="reference" maxLength={100} placeholder="W123456" className="h-9" />
        </div>
        <div className="flex gap-2">
          <SubmitButton pendingText="Saving…">Mark booked</SubmitButton>
          <Button type="button" size="sm" variant="ghost" className="h-9" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The card's note (To plan / Asked cards): posts a move to the column it is already in, with the note. */
function NoteForm({
  id,
  back,
  column,
  note,
  onCancel,
}: {
  id: number;
  back: string;
  column: 'to_plan' | 'asked';
  note: string | null;
  onCancel: () => void;
}) {
  const uid = useId();
  return (
    <form action={moveCardAction} className="mt-3 rounded-md border border-line p-3" aria-label="Card note">
      <CardFields id={id} back={back} />
      <input type="hidden" name="to" value={column} />
      <label htmlFor={`${uid}-note`} className={FIELD_LABEL}>
        Note (leave blank to clear)
      </label>
      <textarea
        id={`${uid}-note`}
        name="note"
        maxLength={500}
        rows={3}
        defaultValue={note ?? ''}
        autoFocus
        className="w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-[13px] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      />
      <div className="mt-2 flex gap-2">
        <SubmitButton pendingText="Saving…">Save note</SubmitButton>
        <Button type="button" size="sm" variant="ghost" className="h-9" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function StarButton({ pressed, label }: { pressed: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-pressed={pressed}
      aria-label={label}
      title={pressed ? 'Priority — click to clear' : 'Mark as priority'}
      disabled={pending}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none',
        pressed ? 'text-warn' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Star aria-hidden className={cn('size-4', pressed && 'fill-current')} />
    </button>
  );
}

function SubmitButton({
  children,
  pendingText,
  variant = 'default',
  ariaLabel,
}: {
  children: React.ReactNode;
  pendingText: string;
  variant?: 'default' | 'outline';
  ariaLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="sm"
      variant={variant}
      aria-label={ariaLabel}
      disabled={pending}
      className={cn('h-9 px-3', variant === 'default' && 'bg-brand hover:bg-brand/90')}
    >
      {pending ? pendingText : children}
    </Button>
  );
}
