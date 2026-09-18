import { cn } from 'cn';
import { TONE_TEXT } from '@/components/status-dot';
import { type Tone, type TonerState, tonerState } from '@/components/toner';
import { formatPercent } from '@/lib/format';

const STATE_TONE: Record<TonerState, Tone> = {
  ok: 'muted',
  low: 'warn',
  critical: 'critical',
  unknown: 'muted',
};

const STATE_LABEL: Record<TonerState, string> = {
  ok: 'OK',
  low: 'Low — under 20%',
  critical: 'Critical — under 5%',
  unknown: 'Not reported',
};

export interface TonerTileProps {
  label: string;
  /** Tailwind background class for the fill and the swatch, e.g. `bg-toner-cyan`. */
  fillClassName: string;
  level: number | null;
  className?: string;
}

/**
 * One cartridge tile on the device page: swatch + name on the left, the percentage on the right,
 * a bar under them and the state label beneath.
 *
 * The mockup also carries an "approx. N days left" line here. That needs usage history (how fast
 * this device burns toner), which arrives with the meter sync in a later sub-project, so the tile
 * keeps the line's height and says what is missing rather than inventing a number.
 */
export function TonerTile({ label, fillClassName, level, className }: TonerTileProps) {
  const state = tonerState(level);
  const known = state !== 'unknown';
  // A 1% cartridge still has to be visible, so the fill never renders narrower than a nub.
  const width = known ? Math.min(100, Math.max(2, level!)) : 0;
  const tone = STATE_TONE[state];

  return (
    <div className={cn('rounded-lg border border-line bg-page/60 px-4 py-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
          <span aria-hidden className={cn('size-2.5 shrink-0 rounded-[3px]', fillClassName)} />
          <span className="truncate">{label}</span>
        </span>
        <span className={cn('text-[22px] leading-none font-semibold tabular', known && TONE_TEXT[tone])}>
          {formatPercent(level)}
        </span>
      </div>

      <div
        role="img"
        aria-label={known ? `${label} ${Math.round(level!)} percent` : `${label} level not reported`}
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-line"
      >
        {known ? <div className={cn('h-full rounded-full', fillClassName)} style={{ width: `${width}%` }} /> : null}
      </div>

      <p className={cn('mt-2.5 text-[13px]', TONE_TEXT[tone])}>{STATE_LABEL[state]}</p>
      {/* Space held for the mockup's days-left forecast; see the note on this component. */}
      <p className="mt-0.5 text-[12px] text-muted-foreground/70">Days left — needs usage history</p>
    </div>
  );
}
