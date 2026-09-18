import type { ReactNode } from 'react';
import { cn } from 'cn';
import { StatusDot } from '@/components/status-dot';
import type { Tone } from '@/components/toner';

const BADGE: Record<Tone, string> = {
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/10 text-warn',
  critical: 'bg-critical/10 text-critical',
  muted: 'bg-muted text-muted-foreground',
};

export interface ToneBadgeProps {
  tone: Tone;
  children: ReactNode;
  /** Draws the small coloured dot in front of the label, as the mockup's title badge does. */
  dot?: boolean;
  className?: string;
}

/** The soft status pill beside the device title ("Toner critical", "Offline · 3h"). */
export function ToneBadge({ tone, children, dot = true, className }: ToneBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-medium whitespace-nowrap',
        BADGE[tone],
        className,
      )}
    >
      {dot ? <StatusDot tone={tone} /> : null}
      {children}
    </span>
  );
}
