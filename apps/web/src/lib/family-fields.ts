import type { ReplenishColour } from '@mps/core';

/**
 * The cartridge-family dialog's field helpers that the browser needs too (no database imports, so
 * the client bundle can use them). `family-form.ts` builds the server-side parse on top of them.
 */

/** A pasted or typed list of models: split, trimmed, blanks and repeats dropped, order kept. */
export function parseModels(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\r\n]+/)) {
    const model = part.trim().replace(/\s+/g, ' ');
    if (model !== '') seen.add(model);
  }
  return [...seen];
}

/** A consumable's name in the families page and dialog. */
export const CONSUMABLE_LABELS: Record<ReplenishColour, string> = {
  black: 'Black',
  cyan: 'Cyan',
  magenta: 'Magenta',
  yellow: 'Yellow',
  waste: 'Waste toner',
};

const CMY: readonly ReplenishColour[] = ['cyan', 'magenta', 'yellow'];

/** Whether a mono family carries this consumable: black and waste only. */
export function familyCarries(isColour: boolean, colour: ReplenishColour): boolean {
  return isColour || !CMY.includes(colour);
}
