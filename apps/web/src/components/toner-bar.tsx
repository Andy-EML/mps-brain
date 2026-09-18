import { cn } from 'cn';
import { TONE_TEXT } from '@/components/status-dot';
import { TONER_CHANNELS, type TonerState, tonerState } from '@/components/toner';
import type { DeviceRow } from '@mps/db/queries';

const PCT_TEXT: Record<TonerState, string> = {
  ok: 'text-muted-foreground',
  low: TONE_TEXT.warn,
  critical: TONE_TEXT.critical,
  unknown: 'text-muted-foreground/60',
};

export interface TonerBarProps {
  /** 0-100, or null when the device has no reading for this channel. */
  level: number | null;
  /** Tailwind background class for the fill, e.g. `bg-toner-cyan`. */
  fillClassName: string;
  /** Channel name, used for the accessible label ("Cyan 61%"). */
  label: string;
  className?: string;
}

/** One cartridge: a track with a coloured fill and the percentage underneath, as in the mockup. */
export function TonerBar({ level, fillClassName, label, className }: TonerBarProps) {
  const state = tonerState(level);
  const known = state !== 'unknown';
  // A 1% cartridge still has to be visible, so the fill never renders narrower than a nub.
  const width = known ? Math.min(100, Math.max(2, level!)) : 0;

  return (
    <div className={cn('min-w-0', className)}>
      <div
        role="img"
        aria-label={known ? `${label} ${Math.round(level!)}%` : `${label} level unknown`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-line"
      >
        {known ? <div className={cn('h-full rounded-full', fillClassName)} style={{ width: `${width}%` }} /> : null}
      </div>
      <div className={cn('mt-1.5 text-xs tabular', PCT_TEXT[state])} aria-hidden>
        {known ? `${Math.round(level!)}%` : '—'}
      </div>
    </div>
  );
}

/** The four DRMS channels for one device. Waste is deliberately absent — DRMS doesn't report it. */
export function TonerBars({ toner, className }: { toner: DeviceRow['toner']; className?: string }) {
  return (
    <div className={cn('grid grid-cols-4 gap-3', className)}>
      {TONER_CHANNELS.map((channel) => (
        <TonerBar key={channel.key} level={toner[channel.key]} fillClassName={channel.className} label={channel.label} />
      ))}
    </div>
  );
}

/** The Cyan / Magenta / Yellow / Black key above the table. */
export function TonerLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {TONER_CHANNELS.map((channel) => (
        <span key={channel.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn('size-2 rounded-[3px]', channel.className)} />
          {channel.label}
        </span>
      ))}
    </div>
  );
}
