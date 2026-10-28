import type { DeviceRow } from '@mps/db/queries';
import { cn } from 'cn';
import { SelectPageCheckbox } from '@/components/device-selection';
import { DeviceTableRow } from '@/components/device-table-row';
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

/**
 * The device table from the mockup: customer over serial, model over the status line, the four
 * DRMS toner channels as bars with their percentage underneath, and pages/month on the right.
 *
 * The customer leads because it is what an operator is looking for. The device's display name
 * (DRMS's equipment Name, e.g. "Hazell & Jefferies Downstairs C450i") only appears when it says
 * something the Model column doesn't — the product name ("ineo+458_Ver42") is just the model, and
 * printed the same thing twice in one row.
 *
 * The whole row opens the device page (the serial underneath is the link the keyboard reaches),
 * and a chevron at the right edge opens the device's detail panel under it — see `DeviceTableRow`.
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

  const columns = (selectable ? 1 : 0) + 5;
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
            <th scope="col" className="w-12 py-2.5 pr-4 pl-0">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <DeviceTableRow
              key={row.drmsId}
              row={row}
              now={now}
              href={deviceHref(row.drmsId, from, back)}
              selectable={selectable}
              columns={columns}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
