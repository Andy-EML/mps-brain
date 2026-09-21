import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

const BOM = String.fromCharCode(0xfeff);

describe('toCsv', () => {
  it('starts with a UTF-8 BOM and separates lines with CRLF', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['1', 2],
        ['3', 4],
      ],
    );
    expect(csv).toBe(BOM + 'a,b\r\n1,2\r\n3,4\r\n');
  });

  it('writes null as an empty field', () => {
    expect(toCsv(['a', 'b', 'c'], [[null, 'x', null]])).toBe(BOM + 'a,b,c\r\n,x,\r\n');
  });

  it('quotes fields with commas, quotes or line breaks, doubling the quotes', () => {
    const csv = toCsv(['name'], [['Smith, J'], ['6" tray'], ['line1\nline2'], ['cr\rhere']]);
    expect(csv).toBe(BOM + 'name\r\n"Smith, J"\r\n"6"" tray"\r\n"line1\nline2"\r\n"cr\rhere"\r\n');
  });

  it('quotes headers too', () => {
    expect(toCsv(['Last contact, UK'], [])).toBe(BOM + '"Last contact, UK"\r\n');
  });

  it('keeps non-ASCII text as is', () => {
    expect(toCsv(['c'], [['Café “Ltd”']])).toBe(BOM + 'c\r\nCafé “Ltd”\r\n');
  });
});
