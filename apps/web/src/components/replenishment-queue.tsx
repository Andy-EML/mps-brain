'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { BellRing, Boxes, ChevronRight, Minus, Plus } from 'lucide-react';
import type { QueueDevice, QueueOrder, QueueProposal, QueueTab } from '@mps/db/queries';
import { cn } from 'cn';
import {
  approveAction,
  loadReviewDetail,
  rejectAction,
  resolveOrderAction,
  retryOrderAction,
} from '@/app/(app)/orders/actions';
import { CopyText } from '@/components/copy-text';
import {
  colourLabel,
  orderStatusLabel,
  orderStatusTone,
  sourceLabel,
  supersededText,
  triggerLabel,
} from '@/components/replenishment';
import { ReviewDetailPanel, Swatch, type DetailState } from '@/components/review-detail-panel';
import {
  MAX_QUANTITY,
  approveAllFields,
  clampQuantity,
  proposalGroups,
  reviewChips,
  topUpChips,
  topUpWhy,
} from '@/components/review-row';
import { ConsumablePill } from '@/components/shelf-pills';
import { ToneBadge } from '@/components/tone-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { deviceHref } from '@/lib/device-origin';
import { formatDate, formatDateTime, formatPercent, pluralise } from '@/lib/format';
import { hrefWith } from '@/lib/href';

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
  if (tab === 'review') {
    return (
      <ul className="divide-y divide-line">
        {devices.map((device) => (
          <ReviewRow key={device.drmsId} device={device} />
        ))}
      </ul>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {devices.map((device) => (
        <li key={device.drmsId} className="px-5 py-5">
          <DeviceHeading device={device} back={hrefWith('/orders', { tab })} />
          {tab === 'in-progress' ? <InProgress device={device} /> : null}
          {tab === 'ordered' ? <Ordered device={device} /> : null}
          {tab === 'rejected' ? <Rejected device={device} /> : null}
        </li>
      ))}
    </ul>
  );
}

type QueueShelf = NonNullable<QueueDevice['shelf']>;

/** `Site stock` beside a site name, or on an order or line that topped a shelf up. */
function SiteStockBadge() {
  return (
    <ToneBadge tone="muted" dot={false} className="gap-1 px-2 py-0.5 text-[12px]">
      <Boxes aria-hidden className="size-3" />
      Site stock
    </ToneBadge>
  );
}

/** `2 machines · C450i / C550i / C650i`. */
function shelfMeta(shelf: QueueShelf): string {
  return `${shelf.machines} ${pluralise(shelf.machines, 'machine')} · ${shelf.familyName}`;
}

/**
 * `back` is this tab's URL, so the device page's Back link returns to the same tab. A device that
 * tops up a site stock shelf is headed by the site (linked to the shelf), the device beneath it.
 */
function DeviceHeading({ device, back }: { device: QueueDevice; back: string }) {
  const where = [device.customerName, device.location].filter(Boolean).join(' · ');
  // The fallback display name already ends in the model; an equipment Name usually does not.
  const showModel = device.model !== null && !device.displayName.includes(device.model);
  const shelf = device.shelf;
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="min-w-0">
        {shelf ? (
          <p className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link href={`/site-stock/${shelf.id}`} className="text-[15px] font-medium text-brand hover:underline">
              {shelf.siteName}
            </Link>
            <SiteStockBadge />
            <span className="text-[13px] text-muted-foreground">{shelfMeta(shelf)}</span>
          </p>
        ) : null}
        <Link
          href={deviceHref(device.drmsId, 'orders', back)}
          className={cn('font-medium text-brand hover:underline', shelf ? 'text-[13px]' : 'text-[15px]')}
        >
          {device.displayName}
        </Link>
        {showModel ? <span className="ml-2 text-[13px] text-muted-foreground">{device.model}</span> : null}
        {where ? <p className="mt-0.5 text-[13px] text-muted-foreground">{where}</p> : null}
      </div>
      {device.serial ? <CopyText text={device.serial} className="text-xs text-muted-foreground" /> : null}
    </div>
  );
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

/**
 * One device on the Review tab as an accordion row: a one-line summary (name, where, a chip per
 * cartridge with the proposed colours emphasised, serial, Approve all) that opens onto the proposal
 * lines and the device detail. The detail is fetched on first open and kept; the proposal form stays mounted once opened, so
 * collapsing a row does not lose an edited quantity.
 */
function ReviewRow({ device }: { device: QueueDevice }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const panelId = `review-panel-${device.drmsId}`;
  const unlinked = device.vantageEquipmentId === null;
  const where = [device.customerName, device.location].filter(Boolean).join(' · ');
  const showModel = device.model !== null && !device.displayName.includes(device.model);
  const { topUp, own } = proposalGroups(device);
  // A row with top-up lines is headed by the site; without them (or with a dangling shelf) it is a normal row.
  const site = topUp.length > 0 ? device.shelf : null;
  // On a site row the device's own proposals add only their proposed chips, after the top-up's.
  const ownChips = site ? reviewChips({ ...device, proposals: own }).filter((c) => c.proposed) : reviewChips(device);

  function load() {
    setDetail({ status: 'loading' });
    loadReviewDetail(device.drmsId).then(
      (data) => setDetail({ status: 'ready', data }),
      () => setDetail({ status: 'error' }),
    );
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && detail === null) load();
  }

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          <ChevronRight
            aria-hidden
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          {site ? (
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[15px] font-medium">{site.siteName}</span>
                <SiteStockBadge />
              </span>
              <span className="block truncate text-[13px] text-muted-foreground">{shelfMeta(site)}</span>
              <span className="block truncate text-[13px] text-muted-foreground">{topUpWhy(topUp, device.displayName)}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <span className="text-[15px] font-medium">{device.displayName}</span>
                {showModel ? <span className="ml-2 text-[13px] text-muted-foreground">{device.model}</span> : null}
              </span>
              {where ? <span className="block truncate text-[13px] text-muted-foreground">{where}</span> : null}
            </span>
          )}
          <span className="flex shrink-0 flex-wrap items-center gap-1.5">
            {site
              ? topUpChips(topUp).map((chip) => (
                  <ConsumablePill key={`top-up-${chip.key}`} colour={chip.colour} text={chip.text} label={chip.label} />
                ))
              : null}
            {ownChips.map((chip) => (
              <span
                key={chip.key}
                title={chip.label}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs tabular-nums',
                  chip.proposed
                    ? 'border-brand bg-brand-soft font-medium text-foreground'
                    : 'border-line text-muted-foreground',
                )}
              >
                <Swatch colour={chip.colour} className="size-2.5" />
                <span aria-hidden>
                  {chip.letter}
                  {chip.levelText ? ` ${chip.levelText}` : ''}
                </span>
                {chip.alarm ? <BellRing aria-hidden className="size-3 text-warn" /> : null}
                <span className="sr-only">{chip.label}</span>
              </span>
            ))}
          </span>
        </button>
        {device.serial ? <CopyText text={device.serial} className="text-xs text-muted-foreground" /> : null}
        <form action={approveAction}>
          {approveAllFields(device.drmsId, device.proposals).map(([name, value], i) => (
            <input key={i} type="hidden" name={name} value={value} />
          ))}
          <ApproveAllButton unlinked={unlinked} count={device.proposals.length} name={site?.siteName ?? device.displayName} />
        </form>
      </div>
      <div id={panelId} hidden={!open} className="pt-3 pb-2 pl-7">
        {detail !== null ? (
          <>
            <ReviewForm
              drmsId={device.drmsId}
              proposals={device.proposals}
              unlinked={unlinked}
              deviceName={device.displayName}
              shelf={site}
            />
            <ReviewDetailPanel state={detail} proposals={device.proposals} onRetry={load} />
            <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              <Link href={deviceHref(device.drmsId, 'orders')} className="text-brand hover:underline">
                Open device page
              </Link>
              {site ? (
                <Link href={`/site-stock/${site.id}`} className="text-brand hover:underline">
                  Open site stock shelf
                </Link>
              ) : null}
            </p>
          </>
        ) : null}
      </div>
    </li>
  );
}

function ApproveAllButton({ unlinked, count, name }: { unlinked: boolean; count: number; name: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="sm"
      disabled={pending || unlinked}
      title={unlinked ? 'Not linked to Vantage equipment' : undefined}
      aria-label={`Approve all ${count} for ${name}`}
      className="bg-brand hover:bg-brand/90"
    >
      {pending ? 'Approving…' : 'Approve all'}
    </Button>
  );
}

export interface ReviewFormProps {
  drmsId: string;
  /** The device's `pending` proposals. */
  proposals: QueueProposal[];
  /** No current Vantage link: nothing can be approved, only rejected. */
  unlinked: boolean;
  /** Set on the device page, so a refused decision comes back there (see `decisionBackPath`). */
  back?: 'device';
  /** The machine the proposals are on, named in a top-up's reason; left out on the device page. */
  deviceName?: string;
  /**
   * The site stock shelf the device tops up, when it has top-up lines: they are listed first under
   * the site, the device's own proposals beneath. Still one form — both groups are this device's.
   */
  shelf?: QueueShelf | null;
}

/**
 * One device's pending proposals with a checkbox and quantity each, Approve selected and Reject
 * selected + reason. Used by the queue's Review tab and the device page's Replenishment card; both
 * post to the same actions, which revalidate both pages.
 */
export function ReviewForm({ drmsId, proposals, unlinked, back, deviceName, shelf }: ReviewFormProps) {
  const { topUp, own } = proposalGroups({ shelf: shelf ?? null, proposals });
  const rows = (list: QueueProposal[]) => (
    <div className="grid gap-2">
      {list.map((p) => (
        <ProposalRow key={p.id} proposal={p} deviceName={deviceName} />
      ))}
    </div>
  );
  return (
    <form action={approveAction}>
      <input type="hidden" name="drmsId" value={drmsId} />
      {back ? <input type="hidden" name="back" value={back} /> : null}
      {shelf && topUp.length > 0 ? (
        <div className="grid gap-4">
          <section aria-label={`Site stock top-up for ${shelf.siteName}`}>
            <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] font-medium">
              <span>Site stock top-up</span>
              <Link href={`/site-stock/${shelf.id}`} className="text-brand hover:underline">
                {shelf.siteName}
              </Link>
              <span className="font-normal text-muted-foreground">{shelfMeta(shelf)}</span>
            </h3>
            {rows(topUp)}
          </section>
          {own.length > 0 ? (
            <section aria-label={`Proposals for ${deviceName ?? 'this machine'}`}>
              <h3 className="mb-2 text-[13px] font-medium">This machine{deviceName ? ` · ${deviceName}` : ''}</h3>
              {rows(own)}
            </section>
          ) : null}
        </div>
      ) : (
        rows(proposals)
      )}
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

/** The reason's colour: red for a low level, amber for a DRMS alarm, plain for a site stock top-up. */
const TRIGGER_TEXT: Record<QueueProposal['trigger'], string> = {
  threshold: 'text-critical',
  alarm: 'text-warn',
  site_stock: 'text-muted-foreground',
};

function ProposalRow({ proposal: p, deviceName }: { proposal: QueueProposal; deviceName?: string }) {
  const [quantity, setQuantity] = useState(String(clampQuantity(p.quantity)));
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
          <span className={TRIGGER_TEXT[p.trigger]}>{triggerLabel(p, deviceName)}</span>
          {p.thresholdSource && p.trigger === 'threshold' ? <> · {sourceLabel(p.thresholdSource)}</> : null}
          {/* A top-up restocks the shelf: this machine's own level says nothing about it. */}
          {p.currentLevel !== null && p.trigger !== 'site_stock' ? <> · now {formatPercent(p.currentLevel)}</> : null}
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

/**
 * The mockup's − / 1 / + control. The number input is the value that is posted. Typing is free
 * (the field can be cleared and retyped) and is clamped to 1–20 on blur; the server still refuses
 * anything outside that range with `bad_quantity`.
 */
function Stepper({
  id,
  value: draft,
  onChange,
  label,
}: {
  id: number;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const value = clampQuantity(Number(draft === '' ? 1 : draft));
  const clamp = (n: number) => String(clampQuantity(n));
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
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onChange(clamp(value))}
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
        // Enter in a text field submits the form with its *first* button, which here is Approve:
        // typing a rejection reason and pressing Enter would place an order. Swallow it instead.
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
              <input type="hidden" name="drmsId" value={device.drmsId} />
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
              <input type="hidden" name="drmsId" value={device.drmsId} />
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
              <input type="hidden" name="drmsId" value={device.drmsId} />
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
      {proposals.some((p) => p.shelfId !== null) ? <SiteStockBadge /> : null}
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
      {device.orders.map((order) => {
        const proposals = proposalsOf(device, order);
        return (
          <div
            key={order.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line px-4 py-3"
          >
            <span className="font-mono text-sm">{order.vantageReference ?? '—'}</span>
            {proposals.some((p) => p.shelfId !== null) ? <SiteStockBadge /> : null}
            <span className="text-sm">{linesText(proposals)}</span>
            <span className="text-[13px] text-muted-foreground">
              {formatDate(order.submittedAt ?? order.createdAt)}
              {order.createdBy ? ` · approved by ${order.createdBy}` : ''}
            </span>
            {order.isOnHold ? <ToneBadge tone="warn">On hold in Vantage</ToneBadge> : null}
          </div>
        );
      })}
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
          {p.shelfId !== null ? <SiteStockBadge /> : null}
          <span className="text-[13px] text-muted-foreground">{triggerLabel(p, device.displayName)}</span>
          <span className="text-[13px] text-muted-foreground">
            {p.status === 'superseded'
              ? `${supersededText(p.note)} · ${formatDateTime(p.decidedAt)}`
              : `Rejected by ${p.decidedBy ?? 'unknown'} · ${formatDateTime(p.decidedAt)}`}
          </span>
          {p.status === 'rejected' && p.note ? <span className="text-[13px] italic">“{p.note}”</span> : null}
        </div>
      ))}
    </div>
  );
}
