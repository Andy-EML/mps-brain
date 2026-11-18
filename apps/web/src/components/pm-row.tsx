'use client';

import { useState, type MouseEvent } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
// Types only from @mps/db: its values would pull the database client into the browser bundle.
import type { DismissReason, PmRow as PmRowData } from '@mps/db/queries';
import { cn } from 'cn';
import { dismissPmAction, markPmBookedAction, undoPmActionAction } from '@/app/(app)/pm/actions';
import { PmDetail } from '@/components/pm-detail';
import {
  DEFAULT_SNOOZE_OPTION,
  DISMISS_REASONS,
  SNOOZE_OPTIONS,
  actionByText,
  actionText,
  dismissReasonLabel,
  lastVisitText,
  pagesText,
  pctText,
  reasonText,
  statusLabel,
  statusTone,
} from '@/components/pm-status';
import { CopyText } from '@/components/copy-text';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { deviceHref } from '@/lib/device-origin';
import { formatDate } from '@/lib/format';

const CELL = 'px-4 py-3 align-top text-[13px]';
const FIELD_LABEL = 'mb-1 block text-[12px] text-muted-foreground';
/** Anything in the row that does its own thing on click, so the row must not also toggle. */
const OWN_CLICK = 'a, button, input, select, textarea, label';

export interface PmRowProps {
  /** The machine; `result.visits` may be trimmed to the ones the detail shows. */
  row: PmRowData;
  /** The list URL this row is on (tab, filters, page): forms post it back, the device link returns to it. */
  back: string;
  /** Open on first render — the row an action just came back to (`?open=`). */
  initiallyOpen: boolean;
  /** An action on this row was refused: the sentence to show in it. */
  error: string | null;
  /** Today in London as `yyyy-mm-dd`: the serviced date's default and latest allowed value. */
  today: string;
  qualifyingMinutes: number;
  timeCapMonths: number;
  /** Columns in the collapsed row, for the panel's colSpan. */
  columns: number;
}

/**
 * One machine on `/pm` as an accordion row, like the replenishment Review tab: a one-line summary
 * (customer, serial, model, status and reason, pages since / %, last counted visit, est. due) that
 * opens onto the PM detail, the Mark booked / Dismiss / Undo forms and an "Open device" link.
 * Clicking anywhere on the summary toggles it; the chevron button is the keyboard way in. The
 * panel renders on first open and stays mounted, so collapsing keeps a half-filled form.
 */
export function PmRow({ row: r, back, initiallyOpen, error, today, qualifyingMinutes, timeCapMonths, columns }: PmRowProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const [rendered, setRendered] = useState(initiallyOpen);
  const panelId = `pm-panel-${r.vantageEquipmentId}`;
  const res = r.result;
  const visit = lastVisitText(res.lastQualifying);
  const reason = reasonText(res.reason, timeCapMonths, res.clockSource);
  const customer = r.customerName ?? 'Unknown customer';

  function toggle() {
    setOpen((o) => !o);
    setRendered(true);
  }

  function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
    if ((e.target as Element).closest(OWN_CLICK)) return;
    if (window.getSelection()?.toString()) return;
    toggle();
  }

  return (
    <>
      <tr
        onClick={onRowClick}
        className={cn('cursor-pointer border-b border-line/70 transition-colors hover:bg-muted/40', open && 'border-b-0 bg-muted/30')}
      >
        <td className={cn(CELL, 'max-w-[260px]')}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={toggle}
            className="-mx-1 flex items-start gap-2 rounded-md px-1 text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          >
            <ChevronRight
              aria-hidden
              className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
            />
            <span className="min-w-0 break-words">{customer}</span>
          </button>
          {r.town ? <span className="mt-0.5 ml-6 block text-[12px] font-normal text-muted-foreground">{r.town}</span> : null}
        </td>
        <td className={cn(CELL, 'font-mono text-[12px] whitespace-nowrap')}>
          {r.serial ? (
            <span className="inline-flex items-center gap-1">
              {r.serial}
              <CopyText text={r.serial} iconOnly ariaLabel="Copy serial number" />
            </span>
          ) : (
            '—'
          )}
          {r.drmsEquipmentId ? null : <span className="block font-sans text-[11px] text-muted-foreground">Not linked</span>}
        </td>
        <td className={CELL}>{r.model ?? '—'}</td>
        <td className={CELL}>
          <span className="flex flex-wrap items-center gap-1.5">
            {r.bookedOverdue ? (
              <ToneBadge tone="critical" className="px-2 py-0.5 text-[12px]">
                Booked — no visit seen
              </ToneBadge>
            ) : null}
            <ToneBadge tone={statusTone(res.status)} className="px-2 py-0.5 text-[12px]">
              {statusLabel(res.status)}
            </ToneBadge>
          </span>
          {reason ? <span className="mt-1 block text-[12px] text-muted-foreground">{reason}</span> : null}
          {res.status === 'booked' && res.bookedFor ? (
            <span className="mt-1 block text-[12px] text-muted-foreground">In Vantage for {formatDate(res.bookedFor)}</span>
          ) : null}
          {r.action ? <span className="mt-1 block text-[12px] text-muted-foreground">{actionText(r.action)}</span> : null}
        </td>
        <td className={cn(CELL, 'text-right tabular-nums whitespace-nowrap')}>
          <span className={cn(res.pagesSince === null && 'text-muted-foreground')}>
            {pagesText(res.pagesSince, res.pagesSinceIsLowerBound)}
          </span>
          <span className="block text-[12px] text-muted-foreground">{pctText(res.pctUsed)}</span>
        </td>
        <td className={cn(CELL, 'whitespace-nowrap')}>
          {visit.date}
          {visit.detail ? <span className="block text-[12px] text-muted-foreground">{visit.detail}</span> : null}
        </td>
        <td className={cn(CELL, 'whitespace-nowrap tabular-nums')}>
          {formatDate(res.estDueDate)}
          {res.timeCapDate ? (
            <span className="block text-[12px] text-muted-foreground">Time cap {formatDate(res.timeCapDate)}</span>
          ) : null}
        </td>
      </tr>
      <tr id={panelId} hidden={!open} className="border-b border-line/70 bg-muted/30">
        <td colSpan={columns} className="px-4 pt-1 pb-4">
          {rendered ? (
            <Panel row={r} back={back} error={error} today={today} qualifyingMinutes={qualifyingMinutes} timeCapMonths={timeCapMonths} />
          ) : null}
        </td>
      </tr>
    </>
  );
}

function Panel({
  row: r,
  back,
  error,
  today,
  qualifyingMinutes,
  timeCapMonths,
}: Pick<PmRowProps, 'row' | 'back' | 'error' | 'today' | 'qualifyingMinutes' | 'timeCapMonths'>) {
  return (
    <div className="ml-6 overflow-hidden rounded-lg border border-line bg-card">
      {error ? (
        <p role="alert" className="border-b border-line bg-destructive/10 px-5 py-2.5 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {r.action ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[13px]">
          <p>
            {actionText(r.action)}
            <span className="ml-2 text-muted-foreground">{actionByText(r.action)}</span>
          </p>
          <form action={undoPmActionAction}>
            <input type="hidden" name="actionId" value={r.action.id} />
            <input type="hidden" name="vantageEquipmentId" value={r.vantageEquipmentId} />
            <input type="hidden" name="return" value={back} />
            <SubmitButton variant="outline" pendingText="Undoing…">
              Undo
            </SubmitButton>
          </form>
        </div>
      ) : null}
      <PmDetail
        row={r}
        qualifyingMinutes={qualifyingMinutes}
        timeCapMonths={timeCapMonths}
        className={cn(!error && !r.action && '[&>div:first-child]:border-t-0')}
      />
      <div className="grid gap-4 border-t border-line px-5 py-4 lg:grid-cols-2">
        <BookedForm vantageEquipmentId={r.vantageEquipmentId} back={back} />
        <DismissForm vantageEquipmentId={r.vantageEquipmentId} back={back} today={today} />
      </div>
      <p className="border-t border-line px-5 py-3 text-[13px]">
        {r.drmsEquipmentId ? (
          <Link href={deviceHref(r.drmsEquipmentId, 'pm', back)} className="text-brand hover:underline">
            Open device
          </Link>
        ) : (
          <span className="text-muted-foreground">Not linked to a DRMS device, so there is no device page.</span>
        )}
      </p>
    </div>
  );
}

function BookedForm({ vantageEquipmentId, back }: { vantageEquipmentId: number; back: string }) {
  const dateId = `pm-booked-for-${vantageEquipmentId}`;
  const refId = `pm-booked-ref-${vantageEquipmentId}`;
  return (
    <form action={markPmBookedAction} className="rounded-lg border border-line p-4">
      <h3 className="mb-1 text-[13px] font-medium">Mark booked</h3>
      <p className="mb-3 text-[12px] text-muted-foreground">
        Recorded here only. Moves to Booked until a PM or a long enough field visit shows up in Vantage.
      </p>
      <input type="hidden" name="vantageEquipmentId" value={vantageEquipmentId} />
      <input type="hidden" name="return" value={back} />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={dateId} className={FIELD_LABEL}>
            Booked for (optional)
          </label>
          <Input id={dateId} type="date" name="bookedFor" className="h-9 w-40" />
        </div>
        <div>
          <label htmlFor={refId} className={FIELD_LABEL}>
            Vantage job reference (optional)
          </label>
          <Input id={refId} name="reference" maxLength={100} placeholder="W123456" className="h-9 w-44" />
        </div>
        <SubmitButton pendingText="Saving…">Mark booked</SubmitButton>
      </div>
    </form>
  );
}

function DismissForm({ vantageEquipmentId, back, today }: { vantageEquipmentId: number; back: string; today: string }) {
  const [reason, setReason] = useState<DismissReason>('not_now');
  const serviced = reason === 'serviced_outside';
  const noteId = `pm-dismiss-note-${vantageEquipmentId}`;
  const servicedId = `pm-dismiss-serviced-${vantageEquipmentId}`;
  return (
    <form action={dismissPmAction} className="rounded-lg border border-line p-4">
      <h3 className="mb-1 text-[13px] font-medium">Dismiss</h3>
      <p className="mb-3 text-[12px] text-muted-foreground">
        {serviced
          ? 'Restarts the PM clock from the service date, as if a counted visit happened then.'
          : 'Snoozed machines sit in Dismissed, then come back to the list.'}
      </p>
      <input type="hidden" name="vantageEquipmentId" value={vantageEquipmentId} />
      <input type="hidden" name="return" value={back} />
      <fieldset className="mb-3">
        <legend className={FIELD_LABEL}>Reason</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {DISMISS_REASONS.map((value) => (
            <label key={value} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="radio"
                name="reason"
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
                className="accent-brand"
              />
              {dismissReasonLabel(value)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        {serviced ? (
          <div>
            <label htmlFor={servicedId} className={FIELD_LABEL}>
              Serviced on
            </label>
            <Input id={servicedId} type="date" name="servicedOn" defaultValue={today} max={today} required className="h-9 w-40" />
          </div>
        ) : (
          <fieldset>
            <legend className={FIELD_LABEL}>Snooze for</legend>
            <div className="flex h-9 items-center gap-3">
              {SNOOZE_OPTIONS.map((days) => (
                <label key={days} className="flex items-center gap-1.5 text-[13px]">
                  <input type="radio" name="snoozeDays" value={days} defaultChecked={days === DEFAULT_SNOOZE_OPTION} className="accent-brand" />
                  {days} days
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="min-w-48 flex-1">
          <label htmlFor={noteId} className={FIELD_LABEL}>
            {reason === 'other' ? 'Note (required)' : 'Note (optional)'}
          </label>
          <Input id={noteId} name="note" maxLength={500} required={reason === 'other'} className="h-9" />
        </div>
        <SubmitButton variant="outline" pendingText="Saving…">
          Dismiss
        </SubmitButton>
      </div>
    </form>
  );
}

function SubmitButton({
  children,
  pendingText,
  variant = 'default',
}: {
  children: React.ReactNode;
  pendingText: string;
  variant?: 'default' | 'outline';
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="sm"
      variant={variant}
      disabled={pending}
      className={cn('h-9 px-3', variant === 'default' && 'bg-brand hover:bg-brand/90')}
    >
      {pending ? pendingText : children}
    </Button>
  );
}
