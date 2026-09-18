import type { DeviceRow } from '@mps/db/queries';
import { cn } from 'cn';
import { StatusDot, TONE_TEXT } from '@/components/status-dot';
import { deviceStatusLabel } from '@/components/toner';
import { TonerBars } from '@/components/toner-bar';

export interface DeviceTableProps {
  rows: DeviceRow[];
  /** Fixed "now" so every row in one render agrees about how long a device has been offline. */
  now?: Date;
  emptyMessage?: string;
  className?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';

function deviceName(row: DeviceRow): string {
  return row.name ?? row.serial ?? row.drmsId;
}

function customerName(row: DeviceRow): string {
  return row.vantageCustomerName ?? row.customerName ?? 'Unknown customer';
}

/**
 * The device table from the mockup: device over customer, model over the status line, the four
 * DRMS toner channels as bars with their percentage underneath, and pages/month on the right.
 */
export function DeviceTable({ rows, now = new Date(), emptyMessage = 'No devices match this view.', className }: DeviceTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-12 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[880px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
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
            return (
              <tr key={row.drmsId} className="border-b border-line align-top last:border-0">
                <td className="px-5 py-4">
                  <div className="flex gap-2.5">
                    <StatusDot tone={status.tone} className="mt-[7px]" />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-[15px] font-medium">{deviceName(row)}</span>
                        {row.serial ? (
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{row.serial}</span>
                        ) : null}
                      </div>
                      <div className="truncate text-[13px] text-muted-foreground">{customerName(row)}</div>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-4">
                  <div className="truncate text-[15px]">{row.model ?? '—'}</div>
                  <div className={cn('truncate text-[13px]', TONE_TEXT[status.tone])}>{status.text}</div>
                </td>
                <td className="px-5 py-4">
                  <TonerBars toner={row.toner} />
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
