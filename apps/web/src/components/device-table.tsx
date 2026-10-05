import Link from 'next/link';
import type { DeviceRow } from '@mps/db/queries';
import { cn } from 'cn';
import { CopyText } from '@/components/copy-text';
import { SelectPageCheckbox, SelectRowCheckbox } from '@/components/device-selection';
import { StatusDot, TONE_TEXT } from '@/components/status-dot';
import { deviceStatusLabel } from '@/components/toner';
import { TonerBars } from '@/components/toner-bar';
import { deviceHref, type DeviceOriginKey } from '@/lib/device-origin';

export interface DeviceTableProps {
  rows: DeviceRow[];
  /** Fixed "now" so every row in one render agrees about how stale a device's meter reading is. */
  now?: Date;
  emptyMessage?: string;
  className?: string;
  /**
   * Adds a checkbox column for the devices list's bulk bar. The table must then sit inside a
   * `DeviceSelectionProvider`, which owns the selection.
   */
  selectable?: boolean;
  /** The section this table sits on, for the device page's breadcrumb and Back link. */
  from?: DeviceOriginKey;
  /** This list's own URL (path + query), so Back returns to the same filter, search and page. */
  back?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';

function customerName(row: DeviceRow): string {
  return row.vantageCustomerName ?? row.customerName ?? 'Unknown customer';
}

/** The link text, and the only identifier guaranteed to exist. */
function deviceSerial(row: DeviceRow): string {
  return row.serial ?? row.drmsId;
}

/**
 * The device table from the mockup: customer over serial, model over the status line, the four
 * DRMS toner channels as bars with their percentage underneath, and pages/month on the right.
 *
 * The customer leads because it is what an operator is looking for; the serial underneath is the
 * link to the device page. The device's display name (DRMS's equipment Name, e.g. "Hazell &
 * Jefferies Downstairs C450i") only appears when it says something the Model column doesn't — the
 * product name ("ineo+458_Ver42") is just the model, and printed the same thing twice in one row.
 */
export function DeviceTable({
  rows,
  now = new Date(),
  emptyMessage = 'No devices match this view.',
  className,
  selectable = false,
  from = 'devices',
  back,
}: DeviceTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-12 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[880px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            {selectable ? (
              <th scope="col" className="w-10 py-2.5 pr-0 pl-5">
                <SelectPageCheckbox />
              </th>
            ) : null}
            <th scope="col" className={cn(HEAD, 'w-[28%]')}>
              Device
            </th>
            <th scope="col" className={cn(HEAD, 'w-[22%]')}>
              Model
            </th>
            <th scope="col" className={cn(HEAD, 'w-[36%]')}>
              Toner
            </th>
            <th
              scope="col"
              className={cn(HEAD, 'w-[14%] text-right')}
              title="Needs meter history — filled in once the meter sync lands"
            >
              Pages / mo
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status = deviceStatusLabel(row, now);
            // The same `displayName` as the queue and device page. Printed only when it is DRMS's
            // equipment Name: the fallback (customer + model) would repeat this row's own columns.
            const showName = row.equipmentName !== null;
            return (
              <tr key={row.drmsId} className="border-b border-line align-top last:border-0">
                {selectable ? (
                  <td className="py-4 pr-0 pl-5">
                    <SelectRowCheckbox drmsId={row.drmsId} label={`${customerName(row)} ${deviceSerial(row)}`} />
                  </td>
                ) : null}
                <td className="px-5 py-4">
                  <div className="flex gap-2.5">
                    <StatusDot tone={status.tone} className="mt-[7px]" />
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-semibold">{customerName(row)}</div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Link
                          href={deviceHref(row.drmsId, from, back)}
                          className="truncate font-mono hover:text-brand hover:underline"
                        >
                          {deviceSerial(row)}
                        </Link>
                        {row.serial ? <CopyText text={row.serial} iconOnly /> : null}
                      </div>
                      {showName ? (
                        <div className="truncate text-[13px] text-muted-foreground">{row.displayName}</div>
                      ) : null}
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
