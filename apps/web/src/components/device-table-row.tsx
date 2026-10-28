'use client';

import { useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import type { DeviceRow } from '@mps/db/queries';
import { cn } from 'cn';
import { loadReviewDetail } from '@/app/(app)/orders/actions';
import { CopyText } from '@/components/copy-text';
import { SelectRowCheckbox } from '@/components/device-selection';
import { ReviewDetailPanel, type DetailState } from '@/components/review-detail-panel';
import { StatusDot, TONE_TEXT } from '@/components/status-dot';
import { deviceStatusLabel } from '@/components/toner';
import { TonerBars } from '@/components/toner-bar';

export interface DeviceTableRowProps {
  row: DeviceRow;
  now: Date;
  /** The device page, with this list's origin and Back URL (`deviceHref`). */
  href: string;
  selectable: boolean;
  /** Columns in the table, for the detail row's `colSpan`. */
  columns: number;
}

/** Anything in a row that does its own thing on click, so the row must not also navigate. */
const OWN_CLICK = 'a, button, input, select, textarea, label, [data-no-row-nav]';

function customerName(row: DeviceRow): string {
  return row.vantageCustomerName ?? row.customerName ?? 'Unknown customer';
}

/** The link text, and the only identifier guaranteed to exist. */
function deviceSerial(row: DeviceRow): string {
  return row.serial ?? row.drmsId;
}

/**
 * One device in `DeviceTable`, plus the detail row that opens under it.
 *
 * A click anywhere on the row opens the device page, except on its own controls (checkbox, copy
 * button, the serial link, the expand button) and when the click ended a text selection. Ctrl or
 * Cmd + click opens it in a new tab, as a link would. From the keyboard the serial is the link, so
 * the row itself takes no focus.
 *
 * The chevron at the right edge opens the same detail panel as a Toner orders Review row (toner
 * levels, recent sales orders, 30-day alarms, pages since each colour last went out), fetched with
 * `loadReviewDetail` on first open and kept for the life of the page.
 */
export function DeviceTableRow({ row, now, href, selectable, columns }: DeviceTableRowProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const panelId = `device-detail-${row.drmsId}`;
  const status = deviceStatusLabel(row, now);
  // The same `displayName` as the queue and device page. Printed only when it is DRMS's equipment
  // Name: the fallback (customer + model) would repeat this row's own columns.
  const showName = row.equipmentName !== null;
  const label = `${customerName(row)} ${deviceSerial(row)}`;

  function load() {
    setDetail({ status: 'loading' });
    loadReviewDetail(row.drmsId).then(
      (data) => setDetail({ status: 'ready', data }),
      () => setDetail({ status: 'error' }),
    );
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && detail === null) load();
  }

  function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
    if ((e.target as Element).closest(OWN_CLICK)) return;
    if (window.getSelection()?.toString()) return;
    if (e.ctrlKey || e.metaKey) window.open(href, '_blank', 'noopener');
    else router.push(href);
  }

  return (
    <>
      <tr
        onClick={onRowClick}
        className={cn(
          'cursor-pointer align-top transition-colors last:border-0 hover:bg-muted/40',
          !open && 'border-b border-line',
        )}
      >
        {selectable ? (
          <td data-no-row-nav className="cursor-default py-4 pr-0 pl-5">
            <SelectRowCheckbox drmsId={row.drmsId} label={label} />
          </td>
        ) : null}
        <td className="px-5 py-4">
          <div className="flex gap-2.5">
            <StatusDot tone={status.tone} className="mt-[7px]" />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold">{customerName(row)}</div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                <Link href={href} className="truncate font-mono hover:text-brand hover:underline">
                  {deviceSerial(row)}
                </Link>
                {row.serial ? <CopyText text={row.serial} iconOnly /> : null}
              </div>
              {showName ? <div className="truncate text-[13px] text-muted-foreground">{row.displayName}</div> : null}
            </div>
          </div>
        </td>
        <td className="px-5 py-4">
          <div className="truncate text-[15px]">{row.model ?? '—'}</div>
          <div className={cn('truncate text-[13px]', TONE_TEXT[status.tone])}>{status.text}</div>
        </td>
        <td className="px-5 py-4">
          <TonerBars row={row} />
        </td>
        <td className="px-5 py-4 text-right text-[15px] text-muted-foreground tabular">—</td>
        <td data-no-row-nav className="cursor-default py-3 pr-4 pl-0 text-right">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={`${open ? 'Hide' : 'Show'} details for ${label}`}
            title={open ? 'Hide details' : 'Show details'}
            onClick={toggle}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/50"
          >
            <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
          </button>
        </td>
      </tr>
      {/* Unmounted when closed, so the table's last visible row keeps `last:border-0`; the loaded
          detail lives in this component's state, not the row, so reopening does not refetch. */}
      {open && detail !== null ? (
        <tr id={panelId} className="border-b border-line last:border-0">
          <td colSpan={columns} className={cn('pr-5 pb-5', selectable ? 'pl-15' : 'pl-10')}>
            <ReviewDetailPanel state={detail} onRetry={load} />
            <p className="mt-4 text-[13px]">
              <Link href={href} className="text-brand hover:underline">
                Open device
              </Link>
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
