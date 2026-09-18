import Link from 'next/link';
import { EyeOff, RotateCcw, Unlink } from 'lucide-react';
import type { IssueRow } from '@mps/db/queries';
import { cn } from 'cn';
import { setIssueStatusAction, unlinkDeviceAction } from '@/app/(app)/issues/actions';
import { LinkPicker } from '@/components/link-picker';
import { ToneBadge } from '@/components/tone-badge';
import { canLink, canUnlink, issueDetailLines, issueTone, issueTypeTitle } from '@/components/issue-queue';
import { formatDate, formatRelative } from '@/lib/format';

export interface IssueTableProps {
  rows: IssueRow[];
  /** Fixed "now" so every row in one render agrees about how long ago an issue was last seen. */
  now?: Date;
  emptyMessage?: string;
  className?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const CELL = 'px-5 py-3.5 align-top';
const ACTION =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px] whitespace-nowrap transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

function deviceLabel(row: IssueRow): string {
  return row.drmsName ?? row.drmsSerial ?? row.drmsId ?? 'Unknown device';
}

function StatusPill({ status }: { status: string }) {
  if (status === 'open') return null;
  return (
    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground capitalize">
      {status}
    </span>
  );
}

/**
 * The link-issues queue table. A server component: the only interactive part that needs the client
 * is `LinkPicker`; Ignore, Reopen and Unlink are plain forms posting to server actions, so they
 * work without JavaScript and give their feedback by the row moving out of the view.
 */
export function IssueTable({ rows, now = new Date(), emptyMessage = 'No issues match this view.', className }: IssueTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-12 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[1040px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={cn(HEAD, 'w-[22%]')}>
              Issue
            </th>
            <th scope="col" className={cn(HEAD, 'w-[20%]')}>
              DRMS device
            </th>
            <th scope="col" className={cn(HEAD, 'w-[20%]')}>
              Vantage record
            </th>
            <th scope="col" className={cn(HEAD, 'w-[16%]')}>
              Seen
            </th>
            <th scope="col" className={cn(HEAD, 'w-[22%] text-right')}>
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const details = issueDetailLines(row.details);
            return (
              <tr key={row.id} className="border-b border-line last:border-b-0">
                <td className={CELL}>
                  <ToneBadge tone={issueTone(row.type)}>{issueTypeTitle(row.type)}</ToneBadge>
                  <StatusPill status={row.status} />
                  {details.length > 0 ? (
                    <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                      {details.map((line) => (
                        <div key={line.label} className="flex gap-1.5">
                          <dt className="shrink-0">{line.label}:</dt>
                          <dd className="min-w-0 break-words text-foreground/80">
                            {line.href ? (
                              <Link href={line.href} className="text-brand hover:underline">
                                {line.value}
                              </Link>
                            ) : (
                              line.value
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </td>

                <td className={CELL}>
                  {row.drmsId ? (
                    <>
                      <Link href={`/devices/${row.drmsId}`} className="text-sm font-medium text-brand hover:underline">
                        {deviceLabel(row)}
                      </Link>
                      <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                        {row.drmsSerial ?? row.drmsId}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">— no DRMS device</span>
                  )}
                </td>

                <td className={CELL}>
                  {row.vantageId !== null ? (
                    <>
                      <span className="block text-sm font-medium">{row.vantageSerial ?? `Vantage ${row.vantageId}`}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {row.vantageCustomerName ?? 'Unknown customer'} · Vantage {row.vantageId}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">— no Vantage record</span>
                  )}
                  {row.linkedVantageId !== null && row.linkedVantageId !== row.vantageId ? (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Currently linked to Vantage {row.linkedVantageId}
                    </span>
                  ) : null}
                </td>

                <td className={cn(CELL, 'text-sm text-muted-foreground')}>
                  <span className="block">Last {formatRelative(row.lastSeen, now)}</span>
                  <span className="mt-0.5 block text-xs">First seen {formatDate(row.firstSeen)}</span>
                </td>

                <td className={cn(CELL, 'text-right')}>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {row.drmsId !== null && canLink(row) ? (
                      <LinkPicker
                        drmsId={row.drmsId}
                        deviceLabel={deviceLabel(row)}
                        defaultQuery={row.drmsSerial ?? undefined}
                      />
                    ) : null}

                    {row.drmsId !== null && canUnlink(row) ? (
                      <form action={unlinkDeviceAction}>
                        <input type="hidden" name="drmsId" value={row.drmsId} />
                        <button type="submit" className={ACTION} title="Close this device's link">
                          <Unlink aria-hidden className="size-3.5" />
                          Unlink
                        </button>
                      </form>
                    ) : null}

                    <form action={setIssueStatusAction}>
                      <input type="hidden" name="issueId" value={row.id} />
                      <input type="hidden" name="status" value={row.status === 'open' ? 'ignored' : 'open'} />
                      {row.status === 'open' ? (
                        <button type="submit" className={ACTION} title="Hide this issue from the open queue">
                          <EyeOff aria-hidden className="size-3.5" />
                          Ignore
                        </button>
                      ) : (
                        <button type="submit" className={ACTION} title="Put this issue back in the open queue">
                          <RotateCcw aria-hidden className="size-3.5" />
                          Reopen
                        </button>
                      )}
                    </form>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
