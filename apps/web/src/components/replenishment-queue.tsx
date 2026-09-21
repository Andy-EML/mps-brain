'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Minus, Plus } from 'lucide-react';
import type { QueueDevice, QueueOrder, QueueProposal, QueueTab } from '@mps/db/queries';
import { cn } from 'cn';
import { approveAction, rejectAction, resolveOrderAction, retryOrderAction } from '@/app/(app)/orders/actions';
import { colourLabel, orderStatusLabel, orderStatusTone, sourceLabel, triggerLabel } from '@/components/replenishment';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate, formatDateTime, formatPercent } from '@/lib/format';

/** Mirrors `MAX_ORDER_QUANTITY` in `@mps/db` (not imported: that module is server-side). */
const MAX_QUANTITY = 20;

export interface ReplenishmentQueueProps {
  tab: QueueTab;
  devices: QueueDevice[];
}

const EMPTY: Record<QueueTab, string> = {
  review: 'Nothing to review — every device is above its threshold or already on order.',
  'in-progress': 'No orders in progress. Approved orders appear here until Vantage confirms them.',
  ordered: 'No orders have reached Vantage in the last 90 days.',
  rejected: 'Nothing has been rejected in the last 30 days.',
};

/**
 * The body of `/orders`: one card per device, whose contents depend on the tab. A client
 * component only for the quantity steppers and the pending state of the buttons; every decision
 * is a plain `<form>` posting to a server action, so the page works the same after a refresh.
 */
export function ReplenishmentQueue({ tab, devices }: ReplenishmentQueueProps) {
  if (devices.length === 0) {
    return <p className="px-5 py-12 text-center text-sm text-muted-foreground">{EMPTY[tab]}</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {devices.map((device) => (
        <li key={device.drmsId} className="px-5 py-5">
          <DeviceHeading device={device} />
          {tab === 'review' ? <ReviewForm device={device} /> : null}
          {tab === 'in-progress' ? <InProgress device={device} /> : null}
          {tab === 'ordered' ? <Ordered device={device} /> : null}
          {tab === 'rejected' ? <Rejected device={device} /> : null}
        </li>
      ))}
    </ul>
  );
}

function DeviceHeading({ device }: { device: QueueDevice }) {
  const where = [device.customerName, device.location].filter(Boolean).join(' · ');
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        <Link href={`/devices/${device.drmsId}`} className="text-[15px] font-medium text-brand hover:underline">
          {device.name ?? device.model ?? device.drmsId}
        </Link>
        {device.model && device.model !== device.name ? (
          <span className="ml-2 text-[13px] text-muted-foreground">{device.model}</span>
        ) : null}
        {where ? <p className="mt-0.5 text-[13px] text-muted-foreground">{where}</p> : null}
      </div>
      {device.serial ? <span className="font-mono text-xs text-muted-foreground">{device.serial}</span> : null}
    </div>
  );
}

const SWATCH: Record<QueueProposal['colour'], string> = {
  black: 'bg-toner-black',
  cyan: 'bg-toner-cyan',
  magenta: 'bg-toner-magenta',
  yellow: 'bg-toner-yellow',
  waste: 'bg-toner-waste',
};

/** The small square from the mockup's cartridge list. */
function Swatch({ colour }: { colour: QueueProposal['colour'] }) {
  return <span aria-hidden className={cn('size-3 shrink-0 rounded-[3px]', SWATCH[colour])} />;
}

/** What is already known about orders for this colour: an open one outranks the last one. */
function orderContext(p: QueueProposal): { text: string; open: boolean } | null {
  if (p.openOrder) {
    const ref = p.openOrder.reference ?? 'without a reference';
    return { text: `Open order ${ref}${p.openOrder.orderDate ? ` · ${formatDate(p.openOrder.orderDate)}` : ''}`, open: true };
  }
  if (p.lastOrder) {
    const ref = p.lastOrder.reference ?? '—';
    return { text: `Last: ${ref}${p.lastOrder.orderDate ? ` · ${formatDate(p.lastOrder.orderDate)}` : ''}`, open: false };
  }
  return null;
}

/* ---------------------------------------------------------------- Review */

function ReviewForm({ device }: { device: QueueDevice }) {
  const unlinked = device.vantageEquipmentId === null;
  return (
    <form action={approveAction}>
      <input type="hidden" name="drmsId" value={device.drmsId} />
      <div className="grid gap-2">
        {device.proposals.map((p) => (
          <ProposalRow key={p.id} proposal={p} />
        ))}
      </div>
      {unlinked ? (
        <p className="mt-3 text-[13px] text-critical">
          Not linked to Vantage equipment, so nothing can be ordered for it. Link it, or reject these proposals.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ReviewButtons unlinked={unlinked} />
      </div>
    </form>
  );
}

function ProposalRow({ proposal: p }: { proposal: QueueProposal }) {
  const [quantity, setQuantity] = useState(Math.min(Math.max(p.quantity, 1), MAX_QUANTITY));
  const context = orderContext(p);
  const checkboxId = `proposal-${p.id}`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line px-4 py-3">
      <input
        id={checkboxId}
        type="checkbox"
        name="proposalId"
        value={p.id}
        defaultChecked
        className="size-4 shrink-0 accent-brand"
      />
      <Swatch colour={p.colour} />
      <label htmlFor={checkboxId} className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{colourLabel(p.colour)}</span>
        <span className="block text-[13px] text-muted-foreground">
          <span className={p.trigger === 'alarm' ? 'text-warn' : 'text-critical'}>{triggerLabel(p)}</span>
          {p.thresholdSource && p.trigger === 'threshold' ? <> · {sourceLabel(p.thresholdSource)}</> : null}
          {p.currentLevel !== null ? <> · now {formatPercent(p.currentLevel)}</> : null}
        </span>
        {context ? (
          <span className={cn('block text-[13px]', context.open ? 'text-warn' : 'text-muted-foreground')}>
            {context.text}
          </span>
        ) : null}
      </label>
      <Stepper id={p.id} value={quantity} onChange={setQuantity} label={colourLabel(p.colour)} />
    </div>
  );
}

/** The mockup's − / 1 / + control. The number input is the value that is posted. */
function Stepper({
  id,
  value,
  onChange,
  label,
}: {
  id: number;
  value: number;
  onChange: (n: number) => void;
  label: string;
}) {
  const clamp = (n: number) => Math.min(MAX_QUANTITY, Math.max(1, Math.round(n)));
  const stepClass =
    'flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label={`One fewer ${label}`}
        className={stepClass}
        disabled={value <= 1}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Minus className="size-3.5" />
      </button>
      <input
        type="number"
        name={`qty-${id}`}
        aria-label={`${label} quantity`}
        min={1}
        max={MAX_QUANTITY}
        step={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
        className="h-7 w-10 [appearance:textfield] bg-transparent text-center text-sm tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label={`One more ${label}`}
        className={stepClass}
        disabled={value >= MAX_QUANTITY}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

/** Inside the form so `useFormStatus` can see it submitting. */
function ReviewButtons({ unlinked }: { unlinked: boolean }) {
  const { pending, action } = useFormStatus();
  const rejecting = pending && action === rejectAction;
  return (
    <>
      <Button type="submit" disabled={pending || unlinked} className="bg-brand hover:bg-brand/90">
        {pending && !rejecting ? 'Approving…' : 'Approve selected'}
      </Button>
      <Button type="submit" variant="outline" formAction={rejectAction} disabled={pending}>
        {rejecting ? 'Rejecting…' : 'Reject selected'}
      </Button>
      <Input
        name="note"
        maxLength={500}
        placeholder="Reason for rejecting (optional)"
        aria-label="Reason for rejecting"
        className="h-8 w-72 max-w-full"
      />
    </>
  );
}

/* ------------------------------------------------------------ In progress */

function proposalsOf(device: QueueDevice, order: QueueOrder): QueueProposal[] {
  return device.proposals.filter((p) => p.orderId === order.id);
}

/** `Black ×2 · Cyan ×1`. */
function linesText(proposals: QueueProposal[]): string {
  return proposals.map((p) => `${colourLabel(p.colour)} ×${p.quantity}`).join(' · ') || '—';
}

function InProgress({ device }: { device: QueueDevice }) {
  return (
    <div className="grid gap-2">
      {device.orders.map((order) => (
        <InProgressOrder key={order.id} device={device} order={order} />
      ))}
    </div>
  );
}

function InProgressOrder({ device, order }: { device: QueueDevice; order: QueueOrder }) {
  const proposals = proposalsOf(device, order);
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <OrderLine order={order} proposals={proposals} />

      {order.status === 'failed' ? (
        <div className="mt-2">
          {order.error ? <p className="text-[13px] text-critical">{order.error}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <form action={retryOrderAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <PendingButton label="Retry" pendingLabel="Queueing…" />
            </form>
            <form action={rejectAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="drmsId" value={device.drmsId} />
              <input type="hidden" name="back" value="in-progress" />
              {proposals
                .filter((p) => p.status === 'failed')
                .map((p) => (
                  <input key={p.id} type="hidden" name="proposalId" value={p.id} />
                ))}
              <PendingButton label="Reject" pendingLabel="Rejecting…" variant="outline" />
              <Input
                name="note"
                maxLength={500}
                placeholder="Reason (optional)"
                aria-label="Reason for rejecting"
                className="h-8 w-56 max-w-full"
              />
            </form>
          </div>
        </div>
      ) : null}

      {order.status === 'uncertain' ? (
        <div className="mt-2">
          <p className="text-[13px] text-critical">
            Vantage did not answer — check whether this order exists in Vantage.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <form action={resolveOrderAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="outcome" value="ordered" />
              <Input
                name="reference"
                required
                maxLength={100}
                placeholder="Vantage order reference"
                aria-label="Vantage order reference"
                className="h-8 w-48 font-mono"
              />
              <PendingButton label="It exists" pendingLabel="Saving…" />
            </form>
            <form action={resolveOrderAction}>
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="outcome" value="failed" />
              <PendingButton label="It does not" pendingLabel="Saving…" variant="outline" />
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OrderLine({ order, proposals }: { order: QueueOrder; proposals: QueueProposal[] }) {
  const by = order.createdBy ? ` by ${order.createdBy}` : '';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <ToneBadge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</ToneBadge>
      <span className="text-sm">{linesText(proposals)}</span>
      <span className="text-[13px] text-muted-foreground">
        Approved {formatDateTime(order.createdAt)}
        {by}
      </span>
    </div>
  );
}

function PendingButton({
  label,
  pendingLabel,
  variant = 'default',
}: {
  label: string;
  pendingLabel: string;
  variant?: 'default' | 'outline';
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending}
      className={variant === 'default' ? 'bg-brand hover:bg-brand/90' : undefined}
    >
      {pending ? pendingLabel : label}
    </Button>
  );
}

/* ---------------------------------------------------------------- Ordered */

function Ordered({ device }: { device: QueueDevice }) {
  return (
    <div className="grid gap-2">
      {device.orders.map((order) => (
        <div
          key={order.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line px-4 py-3"
        >
          <span className="font-mono text-sm">{order.vantageReference ?? '—'}</span>
          <span className="text-sm">{linesText(proposalsOf(device, order))}</span>
          <span className="text-[13px] text-muted-foreground">
            {formatDate(order.submittedAt ?? order.createdAt)}
            {order.createdBy ? ` · approved by ${order.createdBy}` : ''}
          </span>
          {order.isOnHold ? <ToneBadge tone="warn">On hold in Vantage</ToneBadge> : null}
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- Rejected */

function Rejected({ device }: { device: QueueDevice }) {
  return (
    <div className="grid gap-2">
      {device.proposals.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line px-4 py-3">
          <Swatch colour={p.colour} />
          <span className="text-sm font-medium">{colourLabel(p.colour)}</span>
          <span className="text-[13px] text-muted-foreground">{triggerLabel(p)}</span>
          <span className="text-[13px] text-muted-foreground">
            {p.status === 'superseded'
              ? `Superseded: level recovered · ${formatDateTime(p.decidedAt)}`
              : `Rejected by ${p.decidedBy ?? 'unknown'} · ${formatDateTime(p.decidedAt)}`}
          </span>
          {p.status === 'rejected' && p.note ? <span className="text-[13px] italic">“{p.note}”</span> : null}
        </div>
      ))}
    </div>
  );
}
