import type { ReplenishColour } from '@mps/core';
import { cn } from 'cn';
import { CONSUMABLE_LETTERS, shelfPills, type PillState, type ShelfPill } from '@/components/shelf';

/** The pill fill per consumable, from the toner tokens; yellow takes dark text to stay legible. */
const FILL: Record<ReplenishColour, string> = {
  black: 'bg-toner-black text-white',
  cyan: 'bg-toner-cyan text-white',
  magenta: 'bg-toner-magenta text-white',
  yellow: 'bg-toner-yellow text-foreground',
  waste: 'bg-toner-waste text-white',
};

/** Red ring = that consumable's last spare has gone in; not held = an outline only. */
const STATE: Record<PillState, string> = {
  full: 'ring-2 ring-critical ring-offset-1 ring-offset-card',
  holding: '',
  not_held: 'bg-transparent text-muted-foreground border border-line',
};

/**
 * One consumable as a small coloured pill: `K 3/3` (used / held) on the list, or just the letter
 * on the shelf page. Colour is never the only signal: the letter is printed and the full sentence
 * is the title and the screen-reader text.
 */
export function ConsumablePill({
  colour,
  text,
  label,
  state = 'holding',
  className,
}: {
  colour: ReplenishColour;
  text?: string;
  label: string;
  state?: PillState;
  className?: string;
}) {
  return (
    <span
      title={label}
      className={cn(
        'inline-flex min-w-9 items-center justify-center rounded-full px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap tabular',
        FILL[colour],
        STATE[state],
        className,
      )}
    >
      <span aria-hidden>{text ?? CONSUMABLE_LETTERS[colour]}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The list's used / held pills for one shelf. */
export function ShelfPills({ shelf, className }: { shelf: Parameters<typeof shelfPills>[0]; className?: string }) {
  const pills: ShelfPill[] = shelfPills(shelf);
  if (pills.length === 0) return <span className="text-[13px] text-muted-foreground">Nothing held yet</span>;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      {pills.map((p) => (
        <ConsumablePill key={p.colour} colour={p.colour} text={p.text} label={p.label} state={p.state} />
      ))}
    </span>
  );
}
