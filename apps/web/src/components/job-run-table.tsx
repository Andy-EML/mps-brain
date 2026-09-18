import { cn } from 'cn';
import { formatDuration, runTone, statLines } from '@/components/admin-jobs';
import { ToneBadge } from '@/components/tone-badge';
import { formatDateTime, formatRelative } from '@/lib/format';

export interface JobRunRow {
  id: number;
  job: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  stats: unknown;
  errorSample: string | null;
}

export interface JobRunTableProps {
  rows: JobRunRow[];
  now?: Date;
  emptyMessage?: string;
  className?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const CELL = 'px-5 py-3.5 align-top';

/** The `sync_runs` history. A server component — nothing here is interactive. */
export function JobRunTable({
  rows,
  now = new Date(),
  emptyMessage = 'No job has run yet.',
  className,
}: JobRunTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-12 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[900px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={cn(HEAD, 'w-[16%]')}>
              Job
            </th>
            <th scope="col" className={cn(HEAD, 'w-[20%]')}>
              Started
            </th>
            <th scope="col" className={cn(HEAD, 'w-[12%]')}>
              Took
            </th>
            <th scope="col" className={cn(HEAD, 'w-[14%]')}>
              Status
            </th>
            <th scope="col" className={cn(HEAD, 'w-[38%]')}>
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const duration = row.finishedAt ? formatDuration(row.finishedAt.getTime() - row.startedAt.getTime()) : null;
            const stats = statLines(row.stats);
            return (
              <tr key={row.id} className="border-b border-line last:border-b-0">
                <td className={cn(CELL, 'font-mono text-[13px] whitespace-nowrap')}>{row.job}</td>
                <td className={CELL}>
                  <span className="block text-[14px] whitespace-nowrap">{formatDateTime(row.startedAt)}</span>
                  <span className="block text-xs text-muted-foreground">{formatRelative(row.startedAt, now)}</span>
                </td>
                <td className={cn(CELL, 'text-[14px] tabular')}>
                  {duration ?? <span className="text-muted-foreground">still running</span>}
                </td>
                <td className={CELL}>
                  <ToneBadge tone={runTone(row.status)} className="capitalize">
                    {row.status}
                  </ToneBadge>
                </td>
                <td className={CELL}>
                  {row.errorSample ? (
                    <p className="mb-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs break-words text-destructive">
                      {row.errorSample}
                    </p>
                  ) : null}
                  {stats.length > 0 ? (
                    <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      {stats.map((line) => (
                        <div key={line.label} className="flex gap-1.5">
                          <dt>{line.label}</dt>
                          <dd className="font-medium text-foreground tabular">{line.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : row.errorSample ? null : (
                    <span className="text-xs text-muted-foreground">—</span>
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
