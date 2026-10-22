import { MAX_HOLDING, REPLENISH_COLOURS, type ImportRow, type ShelfConsumableCounts } from '@mps/core';

/**
 * The site stock CSV import's plumbing between its two steps. *Preview* parses and validates the
 * upload; the validated rows travel to *Apply* in a hidden field, which is user-editable, so Apply
 * decodes it defensively here (and `applyImport` validates again against the database). After
 * Apply, the result comes back to `/site-stock` as `?imported=<created>-<updated>-<unchanged>`.
 *
 * Pure.
 */

/** The upload limit; `next.config.ts` raises the server-action body limit above it. */
export const MAX_IMPORT_BYTES = 1024 * 1024;

/** More rows than any fleet has sites × families; a payload past this is not one we produced. */
const MAX_ROWS = 20_000;
const MAX_FAMILY_LENGTH = 200;

/** Why the upload cannot be read, or `null` when it is a non-empty `.csv` within the limit. */
export function uploadProblem(file: FormDataEntryValue | null): string | null {
  if (file === null || typeof file === 'string' || file.size === 0) return 'Choose a CSV file to import.';
  if (!/\.csv$/i.test(file.name)) return 'That is not a .csv file. Export from this page, edit it, and save it as CSV.';
  if (file.size > MAX_IMPORT_BYTES) return 'That file is over 1 MB, which is far more than a site stock export. Check it is the right file.';
  return null;
}

/** Positional, so the hidden field stays about the size of the CSV: line, customer, family, 5 holdings, 5 used. */
type EncodedRow = [number, number, string, ...number[]];

export function encodeImportRows(rows: ImportRow[]): string {
  return JSON.stringify(
    rows.map((r): EncodedRow => [
      r.line,
      r.vantageCustomerId,
      r.family,
      ...REPLENISH_COLOURS.map((c) => r.holding[c]),
      ...REPLENISH_COLOURS.map((c) => r.used[c]),
    ]),
  );
}

const isWhole = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

/** The rows from the hidden field, or `null` when it is not exactly what `encodeImportRows` writes. */
export function decodeImportRows(text: FormDataEntryValue | null): ImportRow[] | null {
  if (typeof text !== 'string' || text === '') return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_ROWS) return null;

  const width = 3 + REPLENISH_COLOURS.length * 2;
  const rows: ImportRow[] = [];
  for (const item of data as unknown[]) {
    if (!Array.isArray(item) || item.length !== width) return null;
    const [line, vantageCustomerId, family, ...counts] = item as unknown[];
    if (!isWhole(line, 2) || !isWhole(vantageCustomerId, 1)) return null;
    if (typeof family !== 'string' || family.trim() === '' || family.length > MAX_FAMILY_LENGTH) return null;
    const holding = {} as ShelfConsumableCounts;
    const used = {} as ShelfConsumableCounts;
    for (const [i, c] of REPLENISH_COLOURS.entries()) {
      const h = counts[i];
      const u = counts[REPLENISH_COLOURS.length + i];
      if (!isWhole(h, 0, MAX_HOLDING) || !isWhole(u, 0)) return null;
      holding[c] = h;
      used[c] = u;
    }
    rows.push({ line, vantageCustomerId, family, holding, used });
  }
  return rows;
}

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
}

/** `?imported=` for `/site-stock`. */
export function importResultParam(result: ImportResult): string {
  return `${result.created}-${result.updated}-${result.unchanged}`;
}

/** `?imported=` back to counts; `null` for anything we did not write, so a crafted link shows nothing. */
export function parseImportResult(value: string | undefined): ImportResult | null {
  const m = value === undefined ? null : /^(\d{1,6})-(\d{1,6})-(\d{1,6})$/.exec(value);
  return m ? { created: Number(m[1]), updated: Number(m[2]), unchanged: Number(m[3]) } : null;
}

const count = (n: number, singular: string, plural: string) => `${n.toLocaleString('en-GB')} ${n === 1 ? singular : plural}`;

/** The banner sentence, e.g. `Import applied: 1 shelf created, 2 updated, 14 unchanged.` */
export function importResultMessage(result: ImportResult): string {
  if (result.created === 0 && result.updated === 0) return 'Import applied: nothing needed changing.';
  return `Import applied: ${count(result.created, 'shelf', 'shelves')} created, ${result.updated.toLocaleString('en-GB')} updated, ${result.unchanged.toLocaleString('en-GB')} unchanged.`;
}
