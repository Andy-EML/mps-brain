// Built from its code point so the source never holds an invisible character.
const BOM = String.fromCharCode(0xfeff);

/**
 * CSV for download. The BOM makes Excel read the file as UTF-8 (customer names have accents and
 * curly quotes); CRLF is what RFC 4180 and Excel expect. A field is quoted only when it has to be:
 * it holds a comma, a double quote or a line break, and quotes inside are doubled.
 */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(field).join(','));
  return `${BOM}${lines.map((line) => `${line}\r\n`).join('')}`;
}

function field(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
