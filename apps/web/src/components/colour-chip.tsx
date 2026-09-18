import { cn } from 'cn';

/**
 * The small toner chips beside a sales-order reference, and the pure helpers that build them.
 *
 * Colour is never the only signal: every chip carries the line's full text as its `title` and a
 * screen-reader label ("Black ×2"), and a line whose colour could not be worked out is shown as a
 * grey outline chip marked `?` rather than dropped.
 */

export interface ChipLine {
  vantageId: number;
  details: string | null;
  itemDescription: string | null;
  itemPartNumber: string | null;
  quantity: number | null;
  colour: string | null;
  returnedDate: Date | null;
}

const COLOUR_LABELS: Record<string, string> = {
  black: 'Black',
  cyan: 'Cyan',
  magenta: 'Magenta',
  yellow: 'Yellow',
  waste: 'Waste',
};

/** `black` -> `Black`. Anything unrecognised (including null) is `Unknown`. */
export function colourLabel(colour: string | null | undefined): string {
  return (colour != null && COLOUR_LABELS[colour]) || 'Unknown';
}

/**
 * What to print for a line. `Details` wins: it is filled in even for `MISC` parts — the machines
 * another reseller supplies — and is the only thing that makes those lines readable.
 */
export function lineText(line: ChipLine): string {
  for (const candidate of [line.details, line.itemDescription, line.itemPartNumber]) {
    if (candidate != null && candidate.trim() !== '') return candidate.trim();
  }
  return 'Unnamed line';
}

export interface Chip {
  key: number;
  colour: string | null;
  /** The quantity, only when more than one went out — `●2`. */
  quantityLabel: string | null;
  /** The screen-reader label, e.g. `Black ×2`, `Waste (returned)`. */
  label: string;
  /** The line's full text, shown on hover. */
  title: string;
  /** Waste and unknown draw a ring rather than a filled dot, so neither reads as black. */
  hollow: boolean;
  unknown: boolean;
  returned: boolean;
}

/** One chip per line, in line order. */
export function lineChips(lines: readonly ChipLine[]): Chip[] {
  return lines.map((line) => {
    const known = line.colour != null && line.colour in COLOUR_LABELS;
    const quantity = line.quantity ?? 1;
    const returned = line.returnedDate !== null;
    const name = colourLabel(line.colour);
    return {
      key: line.vantageId,
      colour: known ? line.colour : null,
      quantityLabel: quantity > 1 ? String(quantity) : null,
      label: `${name}${quantity > 1 ? ` ×${quantity}` : ''}${returned ? ' (returned)' : ''}`,
      title: lineText(line),
      hollow: !known || line.colour === 'waste',
      unknown: !known,
      returned,
    };
  });
}

const DOT: Record<string, string> = {
  black: 'bg-toner-black',
  cyan: 'bg-toner-cyan',
  magenta: 'bg-toner-magenta',
  yellow: 'bg-toner-yellow',
};

function Dot({ chip }: { chip: Chip }) {
  if (chip.unknown) {
    return (
      <span
        aria-hidden
        className="flex size-[13px] items-center justify-center rounded-full border border-toner-waste text-[9px] leading-none font-semibold text-muted-foreground"
      >
        ?
      </span>
    );
  }
  if (chip.hollow) {
    // Waste: a ring in the waste grey, so a full bottle never looks like a black cartridge.
    return <span aria-hidden className="size-[13px] rounded-full border-[3px] border-toner-waste" />;
  }
  return <span aria-hidden className={cn('size-[13px] rounded-full', chip.colour ? DOT[chip.colour] : '')} />;
}

export function ColourChip({ chip }: { chip: Chip }) {
  return (
    <span
      title={chip.title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-line bg-page/70 px-1.5 py-0.5',
        chip.returned && 'opacity-50',
      )}
    >
      <Dot chip={chip} />
      {chip.quantityLabel ? (
        <span aria-hidden className="text-[11px] leading-none font-medium tabular">
          {chip.quantityLabel}
        </span>
      ) : null}
      <span className="sr-only">{chip.label}</span>
    </span>
  );
}

/** The chip row for one order: one chip per line, in line order. */
export function ColourChips({ lines, className }: { lines: readonly ChipLine[]; className?: string }) {
  const chips = lineChips(lines);
  if (chips.length === 0) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {chips.map((chip) => (
        <ColourChip key={chip.key} chip={chip} />
      ))}
    </span>
  );
}
