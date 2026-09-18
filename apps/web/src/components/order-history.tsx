import { ORDER_COLOURS } from '@mps/core';
import type { DeviceOrderRow, DeviceOrders } from '@mps/db/queries';
import { cn } from 'cn';
import { ColourChips, colourLabel, lineText } from '@/components/colour-chip';
import { orderStatus } from '@/components/device-detail';
import { ToneBadge } from '@/components/tone-badge';
import { formatDate, formatNumber } from '@/lib/format';

/**
 * The "Consumable orders" card body: a per-colour headline ("when did black last go out, and is it
 * still open?") over the most recent orders.
 *
 * Every line prints its `Details` verbatim — that text is filled in even for the generic `MISC`
 * part used for machines another reseller supplies, and is the only thing that makes those lines
 * readable.
 */

const HEAD = 'px-5 py-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';

const SWATCH: Record<string, string> = {
  black: 'bg-toner-black',
  cyan: 'bg-toner-cyan',
  magenta: 'bg-toner-magenta',
  yellow: 'bg-toner-yellow',
};

/** One row of the headline: the last time this colour went out, or an em dash. */
function ColourSummaryRow({
  colour,
  entry,
}: {
  colour: string;
  entry: DeviceOrders['lastByColour'][keyof DeviceOrders['lastByColour']];
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-page/60 px-3 py-2">
      {colour === 'waste' ? (
        <span aria-hidden className="size-[13px] shrink-0 rounded-full border-[3px] border-toner-waste" />
      ) : (
        <span aria-hidden className={cn('size-[13px] shrink-0 rounded-full', SWATCH[colour])} />
      )}
      <span className="w-[54px] shrink-0 text-[13px] font-medium">{colourLabel(colour)}</span>
      {entry ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
          <span className="tabular whitespace-nowrap">{formatDate(entry.orderDate)}</span>
          {entry.quantity != null && entry.quantity > 1 ? (
            <span className="text-muted-foreground">×{formatNumber(entry.quantity)}</span>
          ) : null}
          <span className="truncate font-mono text-[12px] text-muted-foreground">{entry.reference ?? '—'}</span>
          {entry.orderOpen ? (
            <ToneBadge tone="warn" dot={false} className="px-2 py-0 text-[11px]">
              Open
            </ToneBadge>
          ) : null}
        </span>
      ) : (
        <span className="text-[13px] text-muted-foreground/60">—</span>
      )}
    </div>
  );
}

function OrderRow({ order }: { order: DeviceOrderRow }) {
  const status = orderStatus(order);
  return (
    <tr className="border-t border-line/70 align-top">
      <td className="px-5 py-3 text-[13px] whitespace-nowrap tabular">{formatDate(order.orderDate)}</td>
      <td className="px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[13px]">{order.reference ?? `#${order.vantageId}`}</span>
          <ColourChips lines={order.lines} />
          {order.createdByMps ? (
            <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
              raised here
            </span>
          ) : null}
        </div>
        {order.lines.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {order.lines.map((line) => (
              <li key={line.vantageId} className="text-[13px] text-muted-foreground">
                <span className={cn('text-foreground', line.returnedDate && 'line-through')}>
                  {lineText(line)}
                </span>
                <span className="ml-2 text-[12px]">
                  {[
                    line.itemPartNumber,
                    line.quantity != null && line.quantity > 1 ? `×${formatNumber(line.quantity)}` : null,
                    line.returnedDate ? `returned ${formatDate(line.returnedDate)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[13px] text-muted-foreground">No lines on this order.</p>
        )}
      </td>
      <td className="px-5 py-3 text-[13px] whitespace-nowrap text-muted-foreground">{order.typeName ?? '—'}</td>
      <td className="px-5 py-3 text-right">
        <ToneBadge tone={status.tone} dot={false} className="text-[12px]">
          {status.text}
        </ToneBadge>
      </td>
    </tr>
  );
}

export interface OrderHistoryProps {
  orders: DeviceOrderRow[];
  lastByColour: DeviceOrders['lastByColour'];
  /** Shown instead of the table when there is nothing to list. */
  emptyMessage?: string;
  className?: string;
}

export function OrderHistory({ orders, lastByColour, emptyMessage, className }: OrderHistoryProps) {
  if (orders.length === 0) {
    return (
      <p className={cn('px-5 py-10 text-center text-sm text-muted-foreground', className)}>
        {emptyMessage ?? 'No Vantage sales orders reference this device.'}
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="grid gap-2 px-5 py-4 sm:grid-cols-2 xl:grid-cols-3">
        {ORDER_COLOURS.map((colour) => (
          <ColourSummaryRow key={colour} colour={colour} entry={lastByColour[colour]} />
        ))}
      </div>

      <div className="w-full overflow-x-auto border-t border-line">
        <table className="w-full min-w-[620px] border-collapse text-left">
          <thead>
            <tr>
              <th scope="col" className={HEAD}>
                Date
              </th>
              <th scope="col" className={HEAD}>
                Order
              </th>
              <th scope="col" className={HEAD}>
                Type
              </th>
              <th scope="col" className={cn(HEAD, 'text-right')}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <OrderRow key={order.vantageId} order={order} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
