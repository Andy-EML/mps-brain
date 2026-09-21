'use client';

import { useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import type { RegistrationRow, RegistrationTab } from '@mps/db/queries';
import { cn } from 'cn';
import {
  approveRegistrationsAction,
  rejectRegistrationsAction,
  retryRegistrationAction,
  unrejectRegistrationAction,
} from '@/app/(app)/registrations/actions';
import { customerMatchBadge, registrationStatusBadge } from '@/components/registrations';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDateTime, formatNumber, pluralise } from '@/lib/format';

export interface RegistrationQueueProps {
  tab: RegistrationTab;
  rows: RegistrationRow[];
  /** Set when a search narrowed the list, for the empty state. */
  search?: string;
}

const EMPTY: Record<RegistrationTab, string> = {
  awaiting: 'Nothing awaiting approval. The nightly scan adds newly connected machines that pass the rules.',
  waiting: 'No machine is waiting on a rule. Machines that fail a Vantage check (no match yet, no active contract…) appear here.',
  registered: 'Nothing has been registered from this queue yet.',
  failed: 'No failed registrations.',
  rejected: 'Nothing has been rejected.',
};

const HEAD = 'px-4 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const CELL = 'px-4 py-3.5 align-top';

/**
 * The body of `/registrations`. A client component only for the select-all box, the selection
 * count and the pending state of the buttons; every decision is a plain `<form>` posting to a
 * server action, so the page works the same after a refresh.
 */
export function RegistrationQueue({ tab, rows, search }: RegistrationQueueProps) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-12 text-center text-sm text-muted-foreground">
        {search ? `No machines match “${search}”.` : EMPTY[tab]}
      </p>
    );
  }
  if (tab === 'awaiting') return <AwaitingForm rows={rows} />;
  return (
    <Table
      head={COLUMNS[tab]}
      rows={rows.map((row) => (
        <tr key={row.id} className="border-b border-line last:border-0">
          <MachineCell row={row} />
          <CustomerCell row={row} />
          {tab === 'waiting' ? <WaitingCells row={row} /> : null}
          {tab === 'registered' ? <RegisteredCells row={row} /> : null}
          {tab === 'failed' ? <FailedCells row={row} /> : null}
          {tab === 'rejected' ? <RejectedCells row={row} /> : null}
        </tr>
      ))}
    />
  );
}

const COLUMNS: Record<Exclude<RegistrationTab, 'awaiting'>, string[]> = {
  waiting: ['Machine', 'Customer', 'Waiting for', 'Last checked'],
  registered: ['Machine', 'Customer', 'DRMS request', 'DRMS status after', 'Registered'],
  failed: ['Machine', 'Customer', 'What DRMS said', 'DRMS status after', 'Attempted', ''],
  rejected: ['Machine', 'Customer', 'Rejected', ''],
};

function Table({ head, rows, lead }: { head: string[]; rows: ReactNode; lead?: ReactNode }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            {lead}
            {head.map((h, i) => (
              <th key={`${h}-${i}`} scope="col" className={HEAD}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function MachineCell({ row }: { row: RegistrationRow }) {
  return (
    <td className={CELL}>
      <div className="text-[14px] font-medium">{row.deviceName ?? row.model ?? row.drmsId}</div>
      {row.model && row.model !== row.deviceName ? <div className="text-[13px] text-muted-foreground">{row.model}</div> : null}
      <Link href={`/devices/${row.drmsId}`} className="font-mono text-[12px] text-muted-foreground hover:text-brand hover:underline">
        {row.serial ?? row.drmsId}
      </Link>
    </td>
  );
}

/** Vantage's customer first (who the contract is with), then what DRMS holds and is sent. */
function CustomerCell({ row }: { row: RegistrationRow }) {
  const match = customerMatchBadge(row.customerMatch);
  return (
    <td className={CELL}>
      <div className="text-[14px]">{row.vantageCustomerName ?? 'No Vantage customer yet'}</div>
      <div className="text-[13px] text-muted-foreground">
        DRMS: {row.drmsCustomerName ?? '—'}
        {row.vantageEquipmentId !== null ? ` · Vantage equipment ${row.vantageEquipmentId}` : ''}
      </div>
      {match ? (
        <ToneBadge tone={match.tone} className="mt-1 text-[12px]">
          {match.label}
        </ToneBadge>
      ) : null}
    </td>
  );
}

function who(name: string | null, at: Date | null): string {
  return [name ? `by ${name}` : null, at ? formatDateTime(at) : null].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------- Awaiting approval */

function AwaitingForm({ rows }: { rows: RegistrationRow[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [ticked, setTicked] = useState(0);
  const decidable = rows.filter((r) => r.status === 'awaiting_approval');

  const boxes = () => Array.from(formRef.current?.querySelectorAll<HTMLInputElement>('input[name="id"]') ?? []);
  const recount = () => setTicked(boxes().filter((b) => b.checked).length);

  return (
    <form ref={formRef} action={approveRegistrationsAction} onChange={recount}>
      <input type="hidden" name="tab" value="awaiting" />
      <Table
        lead={
          <th scope="col" className="w-10 px-4 py-2.5">
            {decidable.length > 0 ? (
              <input
                type="checkbox"
                aria-label="Select every machine awaiting approval"
                checked={ticked > 0 && ticked === decidable.length}
                onChange={(e) => {
                  for (const b of boxes()) b.checked = e.target.checked;
                  recount();
                }}
                className="size-4 accent-brand"
              />
            ) : null}
          </th>
        }
        head={['Machine', 'Customer', 'Found', '']}
        rows={rows.map((row) => (
          <tr key={row.id} className="border-b border-line last:border-0">
            <td className="w-10 px-4 py-3.5 align-top">
              {row.status === 'awaiting_approval' ? (
                <input
                  type="checkbox"
                  name="id"
                  value={row.id}
                  aria-label={`Select ${row.serial ?? row.drmsId}`}
                  className="mt-1 size-4 accent-brand"
                />
              ) : null}
            </td>
            <MachineCell row={row} />
            <CustomerCell row={row} />
            <td className={cn(CELL, 'text-[13px] whitespace-nowrap text-muted-foreground')}>{formatDateTime(row.createdAt)}</td>
            <td className={cn(CELL, 'text-right')}>
              {row.status === 'approved' ? (
                <div>
                  <ToneBadge tone={registrationStatusBadge('approved').tone}>{registrationStatusBadge('approved').label}</ToneBadge>
                  <div className="mt-1 text-[12px] text-muted-foreground">
                    {row.isRetry ? `Retry ${who(row.retryRequestedBy, row.retryRequestedAt)}` : `Approved ${who(row.decidedBy, row.decidedAt)}`}
                  </div>
                  {row.error ? <div className="mt-1 text-[12px] text-warn">{row.error}</div> : null}
                </div>
              ) : (
                <RowButtons id={row.id} serial={row.serial ?? row.drmsId} />
              )}
            </td>
          </tr>
        ))}
      />
      {decidable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3.5">
          <BulkButtons ticked={ticked} />
        </div>
      ) : null}
    </form>
  );
}

/** A row's own buttons post `only=<id>`, so they act on that row whatever else is ticked. */
function RowButtons({ id, serial }: { id: number; serial: string }) {
  const { pending } = useFormStatus();
  return (
    <div className="flex justify-end gap-2">
      <Button type="submit" size="sm" name="only" value={id} disabled={pending} className="bg-brand hover:bg-brand/90" aria-label={`Approve ${serial}`}>
        Approve
      </Button>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        name="only"
        value={id}
        formAction={rejectRegistrationsAction}
        disabled={pending}
        aria-label={`Reject ${serial}`}
      >
        Reject
      </Button>
    </div>
  );
}

function BulkButtons({ ticked }: { ticked: number }) {
  const { pending, action } = useFormStatus();
  const rejecting = pending && action === rejectRegistrationsAction;
  const count = `${formatNumber(ticked)} ${pluralise(ticked, 'machine')}`;
  return (
    <>
      <Button
        type="submit"
        disabled={pending || ticked === 0}
        className="bg-brand hover:bg-brand/90"
        onClick={(e) => {
          // A real write to DRMS follows, so a bulk approval says how many first.
          if (!window.confirm(`Register ${count} in DRMS? They are sent one at a time, a minute or two apart.`)) e.preventDefault();
        }}
      >
        {pending && !rejecting ? 'Approving…' : `Approve selected${ticked > 0 ? ` (${formatNumber(ticked)})` : ''}`}
      </Button>
      <Button type="submit" variant="outline" formAction={rejectRegistrationsAction} disabled={pending || ticked === 0}>
        {rejecting ? 'Rejecting…' : 'Reject selected'}
      </Button>
      <Input
        name="note"
        maxLength={500}
        // Enter in a text field submits with the form's first button — Approve. Swallow it.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
        placeholder="Reason for rejecting (optional)"
        aria-label="Reason for rejecting"
        className="h-8 w-72 max-w-full"
      />
    </>
  );
}

/* ------------------------------------------------------------ Other tabs */

function WaitingCells({ row }: { row: RegistrationRow }) {
  return (
    <>
      <td className={cn(CELL, 'text-[14px] text-warn')}>{row.reason ?? '—'}</td>
      <td className={cn(CELL, 'text-[13px] whitespace-nowrap text-muted-foreground')}>{formatDateTime(row.checkedAt)}</td>
    </>
  );
}

function RegisteredCells({ row }: { row: RegistrationRow }) {
  return (
    <>
      <td className={cn(CELL, 'font-mono text-[12px] text-muted-foreground')}>{row.requestId ?? '—'}</td>
      <td className={cn(CELL, 'text-[14px]')}>{row.drmsStatusAfter ?? '—'}</td>
      <td className={cn(CELL, 'text-[13px] text-muted-foreground')}>
        <div className="whitespace-nowrap">{formatDateTime(row.finishedAt)}</div>
        <div>{row.isRetry ? `Retry ${who(row.retryRequestedBy, null)}` : `Approved ${who(row.decidedBy, null)}`}</div>
      </td>
    </>
  );
}

function FailedCells({ row }: { row: RegistrationRow }) {
  return (
    <>
      <td className={cn(CELL, 'max-w-[360px] text-[13px] text-critical')}>{row.error ?? '—'}</td>
      <td className={cn(CELL, 'text-[14px]')}>{row.drmsStatusAfter ?? '—'}</td>
      <td className={cn(CELL, 'text-[13px] whitespace-nowrap text-muted-foreground')}>{formatDateTime(row.finishedAt ?? row.submittedAt)}</td>
      <td className={cn(CELL, 'text-right')}>
        <form action={retryRegistrationAction}>
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="tab" value="failed" />
          <PendingButton label="Retry" pendingLabel="Queueing…" />
        </form>
      </td>
    </>
  );
}

function RejectedCells({ row }: { row: RegistrationRow }) {
  return (
    <>
      <td className={cn(CELL, 'text-[13px] text-muted-foreground')}>
        <div>{who(row.decidedBy, row.decidedAt)}</div>
        {row.note ? <div className="text-foreground italic">“{row.note}”</div> : null}
      </td>
      <td className={cn(CELL, 'text-right')}>
        <form action={unrejectRegistrationAction}>
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="tab" value="rejected" />
          <PendingButton label="Back to approval" pendingLabel="Saving…" variant="outline" />
        </form>
      </td>
    </>
  );
}

function PendingButton({ label, pendingLabel, variant = 'default' }: { label: string; pendingLabel: string; variant?: 'default' | 'outline' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending} className={variant === 'default' ? 'bg-brand hover:bg-brand/90' : undefined}>
      {pending ? pendingLabel : label}
    </Button>
  );
}
