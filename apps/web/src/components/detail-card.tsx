import type { ReactNode } from 'react';
import { cn } from 'cn';

export interface DetailCardProps {
  title: string;
  /** A small link or note on the right of the heading. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A right-column card: a heading and a label/value list ("Links", "Record"). */
export function DetailCard({ title, action, children, className }: DetailCardProps) {
  return (
    <section className={cn('rounded-xl border border-line bg-card px-5 py-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {action}
      </div>
      <dl className="mt-3">{children}</dl>
    </section>
  );
}

export interface DetailRowProps {
  label: string;
  children: ReactNode;
  /** Renders the value in the mono face — ids, serials, CSRC codes. */
  mono?: boolean;
}

/** One label/value line. The value falls back to an em dash when it is empty. */
export function DetailRow({ label, children, mono }: DetailRowProps) {
  const empty = children == null || children === '' || children === false;
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/70 py-2 last:border-0">
      <dt className="shrink-0 text-[13px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right text-[13px]',
          // Ids are worth reading in full — a truncated UUID or CSRC id is useless — so mono
          // values wrap instead of being cut off. Prose values still truncate.
          mono && !empty ? 'font-mono text-[12px] break-all' : 'truncate',
          empty && 'text-muted-foreground/60',
        )}
      >
        {empty ? '—' : children}
      </dd>
    </div>
  );
}
