import Link from 'next/link';
import { Check } from 'lucide-react';
import type { AlertRow } from '@mps/db/queries';
import { cn } from 'cn';
import { acknowledgeAlertAction } from '@/app/(app)/alerts/actions';
import { ToneBadge } from '@/components/tone-badge';
import type { Tone } from '@/components/toner';
import { formatDateTime, formatGap, formatRelative } from '@/lib/format';

export interface AlertTableProps {
  rows: AlertRow[];
  /** Fixed "now" so every row in one render agrees about how stale a device is. */
  now?: Date;
  emptyMessage?: string;
  className?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const CELL = 'px-5 py-3.5 align-top';
const ACTION =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] whitespace-nowrap transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

/**
 * `offline` is the only type the worker opens today, and it is a misnomer kept for the stored
 * value: it means DRMS collected no meter reading, not that the device is unreachable. Anything
 * else (a service code, say) still has to render as something a person can read, so unknown types
 * fall through to the raw type.
 */
function alertTitle(type: string): string {
  return type === 'offline' ? 'No meter reading' : type;
}

function alertTone(row: AlertRow): Tone {
  if (row.clearedAt) return 'muted';
  return row.type === 'offline' ? 'critical' : 'warn';
}

function deviceLabel(row: AlertRow): string {
  return row.deviceName ?? row.serial ?? row.drmsId;
}

/**
 * The alerts table. A server component throughout: Acknowledge is a plain `<form>` posting to a
 * server action, so it needs no JavaScript and its feedback is the row moving to another tab.
 */
export function AlertTable({ rows, now = new Date(), emptyMessage = 'No alerts in this view.', className }: AlertTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-12 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[960px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={cn(HEAD, 'w-[24%]')}>
              Device
            </th>
            <th scope="col" className={cn(HEAD, 'w-[20%]')}>
              Customer
            </th>
            <th scope="col" className={cn(HEAD, 'w-[28%]')}>
              Alert
            </th>
            <th scope="col" className={cn(HEAD, 'w-[16%]')}>
              Detected
            </th>
            <th scope="col" className={cn(HEAD, 'w-[12%] text-right')}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // What the alert is actually about: the last counter report. Alerts opened before that
            // column was populated fall back to when the alert itself was raised.
            const since = row.lastSeenReportAt ?? row.firstDetectedAt;
            return (
              <tr key={row.id} className="border-b border-line last:border-b-0">
                <td className={CELL}>
                  <Link href={`/devices/${row.drmsId}`} className="text-sm font-medium text-brand hover:underline">
                    {deviceLabel(row)}
                  </Link>
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{row.serial ?? row.drmsId}</span>
                </td>

                <td className={cn(CELL, 'text-sm')}>{row.customerName ?? <span className="text-muted-foreground">—</span>}</td>

                <td className={CELL}>
                  <ToneBadge tone={alertTone(row)}>{alertTitle(row.type)}</ToneBadge>
                  {/* "No meter reading since" is what an `offline` alert means. A different alert
                      type would be about something else, so it only gets its badge and its dates. */}
                  {row.type === 'offline' ? (
                    <p className="mt-2 text-[13px]">
                      No meter reading since {formatDateTime(since)}
                      <span className="text-muted-foreground"> · {formatGap(since, now)}</span>
                    </p>
                  ) : null}
                  {row.clearedAt ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Cleared {formatDateTime(row.clearedAt)} — a meter reading arrived
                    </p>
                  ) : null}
                </td>

                <td className={cn(CELL, 'text-sm text-muted-foreground')}>
                  <span className="block">{formatDateTime(row.firstDetectedAt)}</span>
                  <span className="mt-0.5 block text-xs">{formatRelative(row.firstDetectedAt, now)}</span>
                </td>

                <td className={cn(CELL, 'text-right')}>
                  {row.acknowledgedAt ? (
                    <span className="block text-xs text-muted-foreground">
                      Acknowledged {formatRelative(row.acknowledgedAt, now)}
                      {row.acknowledgedByName ? (
                        <>
                          <br />
                          by {row.acknowledgedByName}
                        </>
                      ) : null}
                    </span>
                  ) : row.clearedAt ? (
                    <span className="block text-xs text-muted-foreground">Never acknowledged</span>
                  ) : (
                    <form action={acknowledgeAlertAction} className="flex justify-end">
                      <input type="hidden" name="alertId" value={row.id} />
                      <input type="hidden" name="drmsId" value={row.drmsId} />
                      <button type="submit" className={ACTION} title="Record that you have seen this alert">
                        <Check aria-hidden className="size-3.5" />
                        Acknowledge
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
