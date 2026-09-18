import { cn } from 'cn';
import type { CounterHistoryRow } from '@/components/device-detail';
import { formatDateTime, formatNumber } from '@/lib/format';

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const CELL = 'px-5 py-3 text-[14px] tabular';

function Delta({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground/60">—</span>;
  if (value === 0) return <span className="text-muted-foreground">0</span>;
  return (
    <span className={value > 0 ? 'text-ok' : 'text-warn'}>
      {value > 0 ? '+' : '−'}
      {formatNumber(Math.abs(value))}
    </span>
  );
}

export interface CounterTableProps {
  rows: CounterHistoryRow[];
  emptyMessage?: string;
  className?: string;
}

/**
 * The counter-history table: one row per snapshot, newest first, with each meter's change since
 * the snapshot before it. A negative delta means the meter went backwards — a replaced engine or
 * a reset counter — so it is drawn in amber rather than treated as a saving.
 */
export function CounterTable({ rows, emptyMessage = 'No counter history yet.', className }: CounterTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-10 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[660px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={HEAD}>
              Read
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Black
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Δ
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Colour
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Δ
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Scan
            </th>
            <th scope="col" className={cn(HEAD, 'text-right')}>
              Δ
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.at.getTime()} className="border-b border-line last:border-0">
              <td className={cn(CELL, 'whitespace-nowrap')}>{formatDateTime(row.at)}</td>
              <td className={cn(CELL, 'text-right')}>{formatNumber(row.black)}</td>
              <td className={cn(CELL, 'text-right')}>
                <Delta value={row.deltas.black} />
              </td>
              <td className={cn(CELL, 'text-right')}>{formatNumber(row.colour)}</td>
              <td className={cn(CELL, 'text-right')}>
                <Delta value={row.deltas.colour} />
              </td>
              <td className={cn(CELL, 'text-right')}>{formatNumber(row.scan)}</td>
              <td className={cn(CELL, 'text-right')}>
                <Delta value={row.deltas.scan} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
