import { cn } from 'cn';
import type { Tone } from '@/components/toner';

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  critical: 'bg-critical',
  muted: 'bg-muted-foreground/35',
};

/** Text colour for the same four tones, for status lines and stat values. */
export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  critical: 'text-critical',
  muted: 'text-muted-foreground',
};

export interface StatusDotProps {
  tone: Tone;
  /** Accessible text; omit when a visible label already says the same thing. */
  label?: string;
  className?: string;
}

/** The small coloured dot in front of each device row. */
export function StatusDot({ tone, label, className }: StatusDotProps) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('inline-block size-2 shrink-0 rounded-full', DOT[tone], className)}
    />
  );
}
