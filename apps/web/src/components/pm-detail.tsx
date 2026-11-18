import type { PmRow } from '@mps/db/queries';
import { cn } from 'cn';
import {
  clockSourceText,
  frequentText,
  lastVisitText,
  pagesText,
  pctText,
  reasonText,
  verdictText,
  visitActionText,
  visitCategories,
  visitLengthText,
  visitMeterText,
  visitPartsText,
  visitReferences,
} from '@/components/pm-status';
import { ToneBadge } from '@/components/tone-badge';
import { formatDate, formatNumber } from '@/lib/format';

const HEAD = 'px-5 py-2 text-left text-[11px] font-medium tracking-wider text-muted-foreground uppercase whitespace-nowrap';
const CELL = 'px-5 py-3 align-top text-[13px]';
/** Visits listed, newest first. */
export const PM_VISIT_ROWS = 10;

export interface PmDetailProps {
  row: PmRow;
  /** Settings behind the "Too short (<45 min)" and "12 months since last visit" wording. */
  qualifyingMinutes: number;
  timeCapMonths: number;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * The PM facts for one machine, shared by the device page's PM card and the `/pm` accordion row:
 * interval and where it came from, when the PM clock started and why, last counted visit, pages
 * since / % used / estimated due / time cap, and the last visits with the engineer's notes and how
 * each was judged. Nothing about toner, orders or yield. No hooks, so it renders on either side.
 */
export function PmDetail({ row, qualifyingMinutes, timeCapMonths, className }: PmDetailProps) {
  return (
    <div className={className}>
      <Summary row={row} timeCapMonths={timeCapMonths} />
      <VisitTable row={row} qualifyingMinutes={qualifyingMinutes} />
    </div>
  );
}

function Fact({ label, children, muted }: { label: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-[13px] tabular-nums', muted && 'text-muted-foreground')}>{children}</dd>
    </div>
  );
}

function Summary({ row, timeCapMonths }: { row: PmRow; timeCapMonths: number }) {
  const res = row.result;
  const visit = lastVisitText(res.lastQualifying);
  const reason = reasonText(res.reason, timeCapMonths, res.clockSource);
  const frequent = frequentText(res);
  const clockFrom = clockSourceText(res.clockSource);

  return (
    <div className="border-t border-line px-5 py-4">
      {reason || frequent || (res.status === 'booked' && res.bookedFor) ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
          {reason ? <span className="text-muted-foreground">{reason}</span> : null}
          {res.status === 'booked' && res.bookedFor ? (
            <span className="text-muted-foreground">PM booked in Vantage for {formatDate(res.bookedFor)}</span>
          ) : null}
          {frequent ? (
            <ToneBadge tone="warn" dot={false} className="px-2 py-0 text-[11px]">
              {frequent}
            </ToneBadge>
          ) : null}
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Interval">
          {formatNumber(row.intervalPages)} pages
          <span className="block text-[12px] text-muted-foreground">
            {row.intervalSource === 'family' ? `${row.family ?? 'Cartridge family'} interval` : 'Global interval'}
          </span>
        </Fact>
        <Fact label="PM clock from" muted={res.clockStart === null}>
          {formatDate(res.clockStart)}
          {clockFrom ? <span className="block text-[12px] text-muted-foreground">{clockFrom}</span> : null}
        </Fact>
        <Fact label="Last counted visit" muted={res.lastQualifying === null}>
          {visit.date}
          {visit.detail ? <span className="block text-[12px] text-muted-foreground">{visit.detail}</span> : null}
        </Fact>
        <Fact label="Pages since" muted={res.pagesSince === null}>
          {pagesText(res.pagesSince, res.pagesSinceIsLowerBound)}
        </Fact>
        <Fact label="Interval used" muted={res.pctUsed === null}>
          {pctText(res.pctUsed)}
        </Fact>
        <Fact label="Est. due" muted={res.estDueDate === null}>
          {formatDate(res.estDueDate)}
          {res.timeCapDate ? (
            <span className="block text-[12px] text-muted-foreground">Time cap {formatDate(res.timeCapDate)}</span>
          ) : null}
        </Fact>
      </dl>
    </div>
  );
}

function VisitTable({ row, qualifyingMinutes }: { row: PmRow; qualifyingMinutes: number }) {
  const visits = row.result.visits.slice(0, PM_VISIT_ROWS);
  if (visits.length === 0) {
    return <p className="border-t border-line px-5 py-3 text-[13px] text-muted-foreground">No visits on record.</p>;
  }
  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full">
        <thead>
          <tr>
            <th className={HEAD}>Date</th>
            <th className={HEAD}>Category</th>
            <th className={HEAD}>Length</th>
            <th className={cn(HEAD, 'text-right')}>Meter</th>
            <th className={HEAD}>Reference</th>
            <th className={HEAD}>Engineer notes</th>
            <th className={HEAD}>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {visits.map(({ visit, verdict, meter, pagesSincePrev }) => {
            const total = visitMeterText({ meter, pagesSincePrev });
            const counted = verdict === 'counted' || verdict === 'counted_pm' || verdict === 'counted_parts';
            const action = visitActionText(visit);
            const refs = visitReferences(visit).join(', ');
            const parts = visitPartsText(visit);
            return (
              <tr key={visit.day} className="border-t border-line/70">
                <td className={cn(CELL, 'whitespace-nowrap tabular-nums')}>{formatDate(visit.at)}</td>
                <td className={CELL}>{visitCategories(visit).join(', ') || <span className="text-muted-foreground">—</span>}</td>
                <td className={cn(CELL, 'whitespace-nowrap tabular-nums', visit.displayMinutes === null && 'text-muted-foreground')}>
                  {visitLengthText(visit)}
                </td>
                <td className={cn(CELL, 'whitespace-nowrap text-right tabular-nums', meter === null && 'text-muted-foreground')}>
                  {total.total}
                  {total.since ? <span className="block text-[11px] text-muted-foreground">{total.since}</span> : null}
                </td>
                <td className={cn(CELL, 'max-w-[240px] truncate font-mono text-[12px]')} title={refs}>
                  {refs || <span className="font-sans text-muted-foreground">—</span>}
                </td>
                <td className={cn(CELL, 'max-w-[360px]')}>
                  {action ? (
                    <span className="line-clamp-3 break-words" title={action}>
                      {action}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {parts ? (
                    <span className="mt-0.5 block text-[12px] text-muted-foreground" title={parts}>
                      Parts: {parts}
                    </span>
                  ) : null}
                </td>
                <td className={cn(CELL, 'whitespace-nowrap', !counted && 'text-muted-foreground')}>
                  {verdictText(verdict, qualifyingMinutes, visit.matchedKeywords)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
