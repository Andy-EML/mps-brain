import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from 'cn';
import { TONE_TEXT } from '@/components/status-dot';
import type { Tone } from '@/components/toner';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** The grey line under the number, e.g. "3 critical · 4 low". */
  sub?: ReactNode;
  /** Colours the number. `muted` (the default) leaves it in the normal text colour. */
  tone?: Tone;
  className?: string;
  /** Makes the whole card a link, e.g. the fleet overview's "Needs toner" tile pointing at `/orders`. */
  href?: string;
}

const CARD_CLASS = 'rounded-xl border border-line bg-card px-5 py-4';

/** One of the summary cards across the top of the fleet overview. */
export function StatCard({ label, value, sub, tone = 'muted', className, href }: StatCardProps) {
  const content = (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn('mt-2 text-[34px] leading-none font-semibold tabular', tone !== 'muted' && TONE_TEXT[tone])}>
        {value}
      </p>
      <p className="mt-3 text-[13px] text-muted-foreground">{sub ?? ' '}</p>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          CARD_CLASS,
          'block transition-colors hover:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
          className,
        )}
      >
        {content}
      </Link>
    );
  }

  return <div className={cn(CARD_CLASS, className)}>{content}</div>;
}
