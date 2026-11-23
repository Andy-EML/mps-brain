'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { BellRing, Boxes, ChevronRight, Minus, Plus } from 'lucide-react';
import type { QueueDevice, QueueOrder, QueueProposal, QueueTab } from '@mps/db/queries';
import { cn } from 'cn';
import {
  approveAction,
  deleteOrderAction,
  loadReviewDetail,
  markOrderedAction,
  rejectAction,
  returnToReviewAction,
} from '@/app/(app)/orders/actions';
import { CopyText } from '@/components/copy-text';
import {
  colourLabel,
  compactProposalText,
  orderProgress,
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
import { shelfHref } from '@/components/shelf';
import { ConsumablePill } from '@/components/shelf-pills';
import { ToneBadge } from '@/components/tone-badge';
import { ProposalYieldNote } from '@/components/yield-note';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { deviceHref, devicePageHref } from '@/lib/device-origin';
import { formatDate, formatDateTime, formatPercent, pluralise } from '@/lib/format';

export interface ReplenishmentQueueProps {
  tab: QueueTab;
  devices: QueueDevice[];
  /**
   * This list's own URL (tab, page, sort, rows): the device links return to it and every decision
   * form posts it, so a refused decision comes back to the same tab, page and sort.
   */
  back: string;
}

const EMPTY: Record<QueueTab, string> = {
  review: 'Nothing to review — every device is above its threshold or already on order.',
  'on-site': 'Nothing held — every pending order shows a fitted cartridge or enough pages since the last one.',
  'in-progress': 'No orders in progress. Approved orders wait here until you raise them in Vantage and the sales order turns up.',
  ordered: 'No orders have reached Vantage in the last 90 days.',
  rejected: 'Nothing has been rejected in the last 30 days.',
};

/**
 * The body of `/orders`: one card per device, whose contents depend on the tab. A client
 * component only for the quantity steppers and the pending state of the buttons; every decision
 * is a plain `<form>` posting to a server action, so the page works the same after a refresh.
 */
export function ReplenishmentQueue({ tab, devices, back }: ReplenishmentQueueProps) {
  if (devices.length === 0) {
    return <p className="px-5 py-12 text-center text-sm text-muted-foreground">{EMPTY[tab]}</p>;
  }
  // Probably on site holds pending proposals back from Review; they are decided the same way.
  if (tab === 'review' || tab === 'on-site') {
    return (
      <ul className="divide-y divide-line">
        {devices.map((device) => (
          <ReviewRow key={device.drmsId} device={device} back={back} />
        ))}
      </ul>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {devices.map((device) => (
        <li key={device.drmsId} className="px-5 py-5">
          <DeviceHeading device={device} back={back} />
          {tab === 'in-progress' ? <InProgress device={device} back={back} /> : null}
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
            <Link href={shelfHref(shelf.id, back)} className="text-[15px] font-medium text-brand hover:underline">
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
function ReviewRow({ device, back }: { device: QueueDevice; back: string }) {
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
          <input type="hidden" name="back" value={back} />
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
              back={back}
              deviceName={device.displayName}
              shelf={site}
            />
            <ReviewDetailPanel state={detail} proposals={device.proposals} onRetry={load} />
            <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              <Link href={deviceHref(device.drmsId, 'orders', back)} className="text-brand hover:underline">
                Open device page
              </Link>
              {site ? (
                <Link href={shelfHref(site.id, back)} className="text-brand hover:underline">
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
  /**
   * Where a refused decision comes back to (see `decisionBackPath`): `device` on the device page,
   * the queue's own URL (tab, page, sort) on `/orders`.
   */
  back?: string;
  /**
   * With `back=device`: the device page's own `from` / `back`, posted as `deviceFrom` / `deviceBack`
   * so a refused decision lands on the device page with its Back link intact.
   */
  deviceOrigin?: { from?: string; back?: string };
  /** The machine the proposals are on, named in a top-up's reason; left out on the device page. */
  deviceName?: string;
  /**
   * The site stock shelf the device tops up, when it has top-up lines: they are listed first under
   * the site, the device's own proposals beneath. Still one form — both groups are this device's.
   */
  shelf?: QueueShelf | null;
  /**
   * The narrow layout for the device page's right-hand column: each line stacks colour and level,
   * then the reason, then the last order, with the quantity stepper on its own line, so the text is
   * not squeezed between the checkbox and the stepper. The `/orders` Review tab keeps the wide row.
   */
  compact?: boolean;
}

/**
 * One device's pending proposals with a checkbox and quantity each, Approve selected and Reject
 * selected + reason. Used by the queue's Review tab and the device page's Replenishment card; both
 * post to the same actions, which revalidate both pages.
 */
export function ReviewForm({ drmsId, proposals, unlinked, back, deviceOrigin, deviceName, shelf, compact = false }: ReviewFormProps) {
  const { topUp, own } = proposalGroups({ shelf: shelf ?? null, proposals });
  // The shelf link comes back to the page this form is on: the device page, or the queue's view.
  const shelfBack = back === 'device' ? devicePageHref(drmsId, deviceOrigin) : back;
  const rows = (list: QueueProposal[]) => (
    <div className="grid gap-2">
      {list.map((p) =>
        compact ? (
          <CompactProposalRow key={p.id} proposal={p} deviceName={deviceName} />
        ) : (
          <ProposalRow key={p.id} proposal={p} deviceName={deviceName} />
        ),
      )}
    </div>
  );
  return (
    <form action={approveAction}>
      <input type="hidden" name="drmsId" value={drmsId} />
      {back ? <input type="hidden" name="back" value={back} /> : null}
      {deviceOrigin?.from ? <input type="hidden" name="deviceFrom" value={deviceOrigin.from} /> : null}
      {deviceOrigin?.back ? <input type="hidden" name="deviceBack" value={deviceOrigin.back} /> : null}
      {shelf && topUp.length > 0 ? (
        <div className="grid gap-4">
          <section aria-label={`Site stock top-up for ${shelf.siteName}`}>
            <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] font-medium">
              <span>Site stock top-up</span>
              <Link href={shelfHref(shelf.id, shelfBack)} className="text-brand hover:underline">
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
        <ReviewButtons unlinked={unlinked} compact={compact} />
      </div>
    </form>
  );
}

/**
 * The reason's colour: red for a low level, amber for a DRMS alarm, plain for a restock — a site
 * stock top-up, or a spare used (the machine already has a fresh cartridge; this replaces the spare).
 */
const TRIGGER_TEXT: Record<QueueProposal['trigger'], string> = {
  threshold: 'text-critical',
  alarm: 'text-warn',
  site_stock: 'text-muted-foreground',
  spare_used: 'text-muted-foreground',
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
        <ProposalYieldNote proposalId={p.id} className="mt-0.5" />
        {p.holdDetail ? <span className="mt-0.5 block text-[12px] text-muted-foreground">{p.holdDetail}</span> : null}
      </label>
      <Stepper id={p.id} value={quantity} onChange={setQuantity} label={colourLabel(p.colour)} />
    </div>
  );
}

/**
 * A proposal line for a narrow column (see `ReviewForm`'s `compact`): checkbox, then a text column
 * that takes the full remaining width — colour and level, the reason in muted text, the last order —
 * and the stepper right-aligned on its own line beneath, so nothing wraps a word at a time.
 */
function CompactProposalRow({ proposal: p, deviceName }: { proposal: QueueProposal; deviceName?: string }) {
  const [quantity, setQuantity] = useState(String(clampQuantity(p.quantity)));
  const context = orderContext(p);
  const text = compactProposalText(p, deviceName);
  const checkboxId = `proposal-${p.id}`;
  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <input
          id={checkboxId}
          type="checkbox"
          name="proposalId"
          value={p.id}
          defaultChecked
          className="mt-0.5 size-4 shrink-0 accent-brand"
        />
        <label htmlFor={checkboxId} className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <Swatch colour={p.colour} />
            <span className="text-sm font-medium">{colourLabel(p.colour)}</span>
            {text.level !== null ? <span className="text-sm tabular-nums">{text.level}</span> : null}
            {text.tag ? <span className={cn('text-[12px]', TRIGGER_TEXT[p.trigger])}>{text.tag}</span> : null}
          </span>
          {text.detail ? (
            <span className="mt-0.5 block text-[12px] break-words text-muted-foreground">{text.detail}</span>
          ) : null}
          {context ? (
            <span className={cn('block text-[12px] break-words', context.open ? 'text-warn' : 'text-muted-foreground')}>
              {context.text}
            </span>
          ) : null}
          <ProposalYieldNote proposalId={p.id} className="mt-0.5" />
          {p.holdDetail ? (
            <span className="mt-0.5 block text-[12px] break-words text-muted-foreground">{p.holdDetail}</span>
          ) : null}
        </label>
      </div>
      <div className="mt-1.5 flex justify-end">
        <Stepper id={p.id} value={quantity} onChange={setQuantity} label={colourLabel(p.colour)} />
      </div>
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
function ReviewButtons({ unlinked, compact = false }: { unlinked: boolean; compact?: boolean }) {
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
        // typing a rejection reason and pressing Enter would approve the selection. Swallow it instead.
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
        placeholder="Reason for rejecting (optional)"
        aria-label="Reason for rejecting"
        // In a narrow column the reason gets its own full-width line rather than a stub beside the buttons.
        className={cn('h-8 max-w-full', compact ? 'w-full' : 'w-72')}
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

function InProgress({ device, back }: { device: QueueDevice; back: string }) {
  return (
    <div className="grid gap-2">
      {device.orders.map((order) => (
        <InProgressOrder key={order.id} device={device} order={order} back={back} />
      ))}
    </div>
  );
}

function InProgressOrder({ device, order, back }: { device: QueueDevice; order: QueueOrder; back: string }) {
  const proposals = proposalsOf(device, order);
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <OrderLine order={order} proposals={proposals} />
      {proposals
        .filter((p) => p.status === 'approved')
        .map((p) => (
          <ProposalYieldNote key={p.id} proposalId={p.id} prefix={colourLabel(p.colour)} className="mt-1" />
        ))}

      {order.status === 'queued' ? <QueuedOrderActions device={device} order={order} proposals={proposals} back={back} /> : null}
    </div>
  );
}

/**
 * What a person can do with a `queued` order that the watcher has not matched (all, or the rest of it):
 * say it has been raised by hand in Vantage, take the approval back, or delete it. *Delete* opens a dialog first; the other two
 * either need a reference typed or put everything back as it was, so one click is safe.
 */
function QueuedOrderActions({
  device,
  order,
  proposals,
  back,
}: {
  device: QueueDevice;
  order: QueueOrder;
  proposals: QueueProposal[];
  back: string;
}) {
  const fields = <OrderFields device={device} order={order} back={back} />;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <form action={markOrderedAction} className="flex flex-wrap items-center gap-2">
        {fields}
        <Input
          name="reference"
          required
          maxLength={100}
          placeholder="Vantage order reference"
          aria-label="Vantage order reference"
          className="h-8 w-48 font-mono"
        />
        <PendingButton label="Mark ordered" pendingLabel="Saving…" />
      </form>
      <form action={returnToReviewAction}>
        {fields}
        <PendingButton label="Back to review" pendingLabel="Moving…" variant="outline" />
      </form>
      <DeleteOrderDialog device={device} order={order} proposals={proposals} back={back} />
    </div>
  );
}

/** The hidden fields every queued-order form posts; a refusal comes back to the same In progress page. */
function OrderFields({ device, order, back }: { device: QueueDevice; order: QueueOrder; back: string }) {
  return (
    <>
      <input type="hidden" name="orderId" value={order.id} />
      <input type="hidden" name="drmsId" value={device.drmsId} />
      <input type="hidden" name="back" value={back} />
    </>
  );
}

/** *Delete…*, confirmed first, because it sits beside two buttons that do something else entirely. */
function DeleteOrderDialog({
  device,
  order,
  proposals,
  back,
}: {
  device: QueueDevice;
  order: QueueOrder;
  proposals: QueueProposal[];
  back: string;
}) {
  const reasonId = `delete-order-reason-${order.id}`;
  // A colour rejected before a retry is still on the order, but this does not touch it.
  const approved = proposals.filter((p) => p.status === 'approved');
  const topUp = approved.some((p) => p.shelfId !== null);
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" className="text-destructive hover:text-destructive" />}>Delete…</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form action={deleteOrderAction} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Delete this order for {device.displayName}?</DialogTitle>
            <DialogDescription>
              {linesText(approved)} will move to the Rejected tab and will not be proposed again for a while.
              {topUp ? ' The quantities go back on the site stock shelf.' : ''}{' '}
              {proposals.some((p) => p.status === 'ordered') ? 'Colours already matched in Vantage stay ordered. ' : ''}
              Nothing is sent to Vantage, so an order already raised there stays open.
            </DialogDescription>
          </DialogHeader>
          <OrderFields device={device} order={order} back={back} />
          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>Reason (optional)</Label>
            <Input id={reasonId} name="note" maxLength={500} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <PendingButton label="Delete order" pendingLabel="Deleting…" variant="destructive" />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OrderLine({ order, proposals }: { order: QueueOrder; proposals: QueueProposal[] }) {
  const by = order.createdBy ? ` by ${order.createdBy}` : '';
  // A partly matched order: some colours are already in Vantage, the rest are still waiting for theirs.
  const progress = orderProgress(proposals);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <ToneBadge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</ToneBadge>
      {proposals.some((p) => p.shelfId !== null) ? <SiteStockBadge /> : null}
      <span className="text-sm">{linesText(proposals)}</span>
      <span className="text-[13px] text-muted-foreground">
        Approved {formatDateTime(order.createdAt)}
        {by}
      </span>
      {progress ? (
        <p className="basis-full text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">In Vantage:</span> {progress.inVantage}
          {' · '}
          <span className="font-medium text-foreground">Waiting:</span> {progress.waiting}
        </p>
      ) : null}
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
  variant?: 'default' | 'outline' | 'destructive';
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
