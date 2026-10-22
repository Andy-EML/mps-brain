/**
 * Site stock CSV import: parsing (RFC 4180, plus undoing the formula guard the app's CSV writer
 * adds) and row validation. Pure — no I/O.
 */
import { REPLENISH_COLOURS } from './replenishment';
import { MAX_HOLDING, MAX_USED, type ShelfConsumableCounts } from './site-stock';

export const SITE_STOCK_CSV_HEADERS = [
  'vantage_customer_id',
  'site_name',
  'customer_reference',
  'postcode',
  'family',
  'machines',
  'hold_black',
  'hold_cyan',
  'hold_magenta',
  'hold_yellow',
  'hold_waste',
  'used_black',
  'used_cyan',
  'used_magenta',
  'used_yellow',
  'used_waste',
] as const;

export interface ImportRow {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  vantageCustomerId: number;
  family: string;
  holding: ShelfConsumableCounts;
  used: ShelfConsumableCounts;
}

export interface ImportError {
  line: number;
  message: string;
}

const BOM = String.fromCharCode(0xfeff);

/** The writer prefixes text starting with = + - @ tab CR with an apostrophe; take it off again. */
function unguard(value: string): string {
  return value.startsWith("'") && /^[=+\-@\t\r]/.test(value.slice(1)) ? value.slice(1) : value;
}

export function parseCsv(text: string): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(unguard(field));
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  while (rows.length > 0 && rows[rows.length - 1]!.every((f) => f.trim() === '')) rows.pop();
  return rows;
}

const REQUIRED = ['vantage_customer_id', 'family', ...REPLENISH_COLOURS.map((c) => `hold_${c}`)];

export function validateImport(rows: string[][]): { rows: ImportRow[]; errors: ImportError[] } {
  const out: ImportRow[] = [];
  const errors: ImportError[] = [];
  const header = rows[0];
  if (!header) return { rows: out, errors: [{ line: 1, message: 'The file is empty' }] };

  const col = new Map<string, number>();
  header.forEach((name, idx) => {
    const key = name.trim().toLowerCase();
    if (!col.has(key)) col.set(key, idx);
  });
  const missing = REQUIRED.filter((name) => !col.has(name));
  if (missing.length > 0) {
    return { rows: out, errors: [{ line: 1, message: `Missing column: ${missing.join(', ')}` }] };
  }

  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.every((c) => c.trim() === '')) continue;
    const line = r + 1;
    const cell = (name: string) => (cells[col.get(name) ?? -1] ?? '').trim();
    const problems: string[] = [];

    const idText = cell('vantage_customer_id');
    const vantageCustomerId = Number(idText);
    if (!/^\d+$/.test(idText) || !Number.isSafeInteger(vantageCustomerId) || vantageCustomerId < 1) {
      problems.push('vantage_customer_id must be a positive whole number');
    }
    const family = cell('family');
    if (family === '') problems.push('family is required');

    const holding = {} as ShelfConsumableCounts;
    const used = {} as ShelfConsumableCounts;
    for (const prefix of ['hold', 'used'] as const) {
      for (const colour of REPLENISH_COLOURS) {
        const name = `${prefix}_${colour}`;
        const text = cell(name);
        let n = 0;
        if (text !== '') {
          if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
            problems.push(`${name} must be a whole number`);
            continue;
          }
          n = Number(text);
        }
        if (prefix === 'hold' && (n < 0 || n > MAX_HOLDING)) {
          problems.push(`${name} must be 0 to ${MAX_HOLDING}`);
          continue;
        }
        if (prefix === 'used' && (n < 0 || n > MAX_USED)) {
          problems.push(`${name} must be 0 to ${MAX_USED}`);
          continue;
        }
        (prefix === 'hold' ? holding : used)[colour] = n;
      }
    }

    if (problems.length === 0) {
      const key = `${vantageCustomerId}\u0000${family.toLowerCase()}`;
      if (seen.has(key)) problems.push('Duplicate customer and family');
      seen.add(key);
    }
    if (problems.length > 0) {
      errors.push({ line, message: problems.join('; ') });
      continue;
    }
    out.push({ line, vantageCustomerId, family, holding, used });
  }
  return { rows: out, errors };
}
