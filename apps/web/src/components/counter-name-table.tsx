import { cn } from 'cn';
import { CounterCategorySelect } from '@/components/counter-category-select';
import { formatDate, formatNumber } from '@/lib/format';

export interface CounterNameRow {
  name: string;
  category: string | null;
  sampleValue: number | null;
  firstSeen: Date;
}

export interface CounterNameTableProps {
  rows: CounterNameRow[];
  emptyMessage?: string;
  className?: string;
}

const HEAD = 'px-5 py-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase';
const CELL = 'px-5 py-2.5 align-middle';

/**
 * Every counter name DRMS has reported, with what it is for. The category is what makes a name
 * mean something downstream: `meter` names are the ones billing reads, `supply` names are the
 * toner levels the fleet pages band, `other` is everything deliberately parked.
 */
export function CounterNameTable({ rows, emptyMessage = 'No counter names yet.', className }: CounterNameTableProps) {
  if (rows.length === 0) {
    return <p className={cn('px-5 py-12 text-center text-sm text-muted-foreground', className)}>{emptyMessage}</p>;
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={cn(HEAD, 'w-[42%]')}>
              Counter name
            </th>
            <th scope="col" className={cn(HEAD, 'w-[18%] text-right')}>
              Sample value
            </th>
            <th scope="col" className={cn(HEAD, 'w-[22%]')}>
              First seen
            </th>
            <th scope="col" className={cn(HEAD, 'w-[18%] text-right')}>
              Category
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-line last:border-b-0">
              <td className={cn(CELL, 'font-mono text-[13px] break-all')}>{row.name}</td>
              <td className={cn(CELL, 'text-right text-[14px] tabular')}>{formatNumber(row.sampleValue)}</td>
              <td className={cn(CELL, 'text-[14px]')}>{formatDate(row.firstSeen)}</td>
              <td className={cn(CELL, 'text-right')}>
                <CounterCategorySelect name={row.name} value={row.category} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
