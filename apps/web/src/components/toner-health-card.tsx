import { cn } from 'cn';
import { formatNumber, pluralise } from '@/lib/format';

export interface TonerHealthCardProps {
  ok: number;
  low: number;
  critical: number;
  total: number;
  /** How many devices those cartridges came from, for the sub-line. */
  devicesWithCounters?: number;
  className?: string;
}

const SEGMENTS = [
  { key: 'ok', bar: 'bg-ok', dot: 'bg-ok', label: (n: string) => `${n} healthy` },
  { key: 'low', bar: 'bg-warn', dot: 'bg-warn', label: (n: string) => `${n} low (under 20%)` },
  { key: 'critical', bar: 'bg-critical', dot: 'bg-critical', label: (n: string) => `${n} critical (under 5%)` },
] as const;

/** The "Fleet toner health" strip: one stacked bar over a legend, exactly as in the mockup. */
export function TonerHealthCard({ ok, low, critical, total, devicesWithCounters, className }: TonerHealthCardProps) {
  const counts = { ok, low, critical };

  return (
    <section className={cn('rounded-xl border border-line bg-card px-5 py-5', className)}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-8">
        <div className="lg:w-56 lg:shrink-0">
          <h2 className="text-[15px] font-medium">Fleet toner health</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {total === 0
              ? 'No cartridge readings yet'
              : `${formatNumber(total)} ${pluralise(total, 'cartridge')} tracked${
                  devicesWithCounters
                    ? ` across ${formatNumber(devicesWithCounters)} ${pluralise(devicesWithCounters, 'device')}`
                    : ''
                }`}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="flex h-2 w-full overflow-hidden rounded-full bg-line"
            role="img"
            aria-label={
              total === 0
                ? 'No cartridge readings yet'
                : `${ok} healthy, ${low} low, ${critical} critical out of ${total} cartridges`
            }
          >
            {total > 0
              ? SEGMENTS.map((segment) =>
                  counts[segment.key] > 0 ? (
                    <div
                      key={segment.key}
                      className={segment.bar}
                      style={{ width: `${(counts[segment.key] / total) * 100}%` }}
                    />
                  ) : null,
                )
              : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1.5">
            {SEGMENTS.map((segment) => (
              <span key={segment.key} className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <span aria-hidden className={cn('size-2 rounded-full', segment.dot)} />
                {segment.label(formatNumber(counts[segment.key]))}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
