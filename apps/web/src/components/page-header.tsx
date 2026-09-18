import type { ReactNode } from 'react';
import { cn } from 'cn';

export interface PageHeaderProps {
  title: string;
  /** The grey line under the title, e.g. "42 devices across 6 sites · synced 4 minutes ago". */
  subtitle?: ReactNode;
  /** Right-hand controls (search, primary button). */
  actions?: ReactNode;
  className?: string;
}

/** The page title block from the mockup: title + subtitle on the left, actions on the right. */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-6 flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
    </div>
  );
}
