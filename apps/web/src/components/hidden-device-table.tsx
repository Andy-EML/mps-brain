import Link from 'next/link';
import type { HiddenDeviceRow } from '@mps/db/queries';
import { cn } from 'cn';
import { unhideFromListAction } from '@/app/(app)/devices/actions';
import { SubmitButton } from '@/components/hide-device';
import { deviceHref } from '@/lib/device-origin';
import { formatDate } from '@/lib/format';

export interface HiddenDeviceTableProps {
  rows: HiddenDeviceRow[];
  /** The tab's own search and page, posted with Unhide so the action can come back to them. */
  search?: string;
  page: number;
  /** The tab's URL, for the device page's Back link. */
  back: string;
  emptyMessage: string;
  className?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';

/**
 * The devices list's *Hidden* tab: each hidden device with who hid it, when and why, and an
 * *Unhide* button. No toner bars — a hidden device is one nobody is watching — and no selection,
 * since unhiding is a one-at-a-time decision.
 */
export function HiddenDeviceTable({ rows, search, page, back, emptyMessage, className }: HiddenDeviceTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-12 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={cn(HEAD, 'w-[34%]')}>
              Device
            </th>
            <th scope="col" className={cn(HEAD, 'w-[22%]')}>
              Hidden
            </th>
            <th scope="col" className={cn(HEAD, 'w-[32%]')}>
              Reason
            </th>
            <th scope="col" className="w-[12%] py-2.5 pr-5">
              <span className="sr-only">Unhide</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.drmsId} className="border-b border-line/70 last:border-0">
              <td className="px-5 py-3 align-top">
                <Link
                  href={deviceHref(row.drmsId, 'devices', back)}
                  className="text-sm font-medium text-brand hover:underline"
                >
                  {row.customerName ?? row.displayName}
                </Link>
                <p className="text-[13px] text-muted-foreground">
                  {[row.equipmentName, row.model, row.serial].filter(Boolean).join(' · ') || row.drmsId}
                </p>
              </td>
              <td className="px-5 py-3 align-top text-[13px]">
                {formatDate(row.hiddenAt)}
                <span className="block text-muted-foreground">{row.hiddenBy ? `by ${row.hiddenBy}` : 'by unknown'}</span>
              </td>
              <td className="px-5 py-3 align-top text-[13px] break-words">
                {row.reason ?? <span className="text-muted-foreground">No reason given</span>}
              </td>
              <td className="py-3 pr-5 text-right align-top">
                <form action={unhideFromListAction}>
                  <input type="hidden" name="drmsId" value={row.drmsId} />
                  {search ? <input type="hidden" name="search" value={search} /> : null}
                  <input type="hidden" name="page" value={page} />
                  <SubmitButton label="Unhide" pendingLabel="Unhiding…" variant="outline" size="sm" />
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
