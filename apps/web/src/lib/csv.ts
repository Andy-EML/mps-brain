// Built from its code point so the source never holds an invisible character.
const BOM = String.fromCharCode(0xfeff);

/**
 * CSV for download. The BOM makes Excel read the file as UTF-8 (customer names have accents and
 * curly quotes); CRLF is what RFC 4180 and Excel expect. A field is quoted only when it has to be:
 * it holds a comma, a double quote or a line break, and quotes inside are doubled. Text that a
 * spreadsheet would read as a formula is prefixed with an apostrophe.
 */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(field).join(','));
  return `${BOM}${lines.map((line) => `${line}\r\n`).join('')}`;
}

function field(value: string | number | null): string {
  if (value === null) return '';
  // Excel and friends run a cell starting with = + - @ (or a tab/CR before one) as a formula, so
  // text from Vantage or DRMS is defused with a leading apostrophe. Numbers are ours and stay as
  // they are, negative ones included.
  const s = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
