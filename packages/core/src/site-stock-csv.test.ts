import { describe, expect, it } from 'vitest';
import { SITE_STOCK_CSV_HEADERS, parseCsv, validateImport } from './site-stock-csv';

const H = SITE_STOCK_CSV_HEADERS.join(',');
const row = (over: Record<string, string> = {}) =>
  SITE_STOCK_CSV_HEADERS.map((h) => over[h] ?? (h === 'vantage_customer_id' ? '7' : h === 'family' ? 'C458' : '')).join(',');
const run = (...lines: string[]) => validateImport(parseCsv([H, ...lines].join('\r\n')));

describe('parseCsv', () => {
  it('round-trips toCsv output: BOM, CRLF, quoted comma, doubled quote, formula guard', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""",\'=x\r\n';
    expect(parseCsv(text)).toEqual([['a', 'b', 'c'], ['x, y', 'say "hi"', '=x']]);
  });
  it('keeps an apostrophe that is not a formula guard and handles LF, embedded newlines, blank tail', () => {
    expect(parseCsv("a,'b\n\"l1\nl2\",c\n\n\n")).toEqual([['a', "'b"], ['l1\nl2', 'c']]);
  });
});

describe('validateImport', () => {
  it('parses a good row, blank counts as 0', () => {
    const r = run(row({ hold_black: '3', used_cyan: '2' }));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      line: 2,
      vantageCustomerId: 7,
      family: 'C458',
      holding: { black: 3, cyan: 0, magenta: 0, yellow: 0, waste: 0 },
      used: { black: 0, cyan: 2, magenta: 0, yellow: 0, waste: 0 },
    });
  });
  it('rejects non-numbers, out of range and negatives, naming the column', () => {
    expect(run(row({ hold_black: 'abc' })).errors[0]).toEqual({ line: 2, message: expect.stringContaining('hold_black must be a whole number') });
    expect(run(row({ hold_cyan: '25' })).errors[0]!.message).toContain('0 to 20');
    expect(run(row({ hold_cyan: '-1' })).errors[0]!.message).toContain('hold_cyan');
    expect(run(row({ used_waste: '-1' })).errors[0]!.message).toContain('used_waste');
  });
  it('caps used at 999', () => {
    expect(run(row({ used_black: '999' })).errors).toEqual([]);
    expect(run(row({ used_black: '1000' })).errors[0]!.message).toContain('used_black must be 0 to 999');
    expect(run(row({ used_cyan: '99999999999' })).errors[0]!.message).toContain('used_cyan must be 0 to 999');
  });
  it('rejects a bad customer id and an empty family', () => {
    expect(run(row({ vantage_customer_id: '0' })).errors).toHaveLength(1);
    expect(run(row({ family: ' ' })).errors).toHaveLength(1);
  });
  it('gives one file-level error when a required column is missing', () => {
    const r = validateImport(parseCsv(H.replace('family,', '') + '\r\n7,x'));
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([{ line: 1, message: expect.stringContaining('family') }]);
  });
  it('flags the second of a duplicate customer and family', () => {
    const r = run(row(), row());
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual([{ line: 3, message: expect.stringContaining('Duplicate') }]);
  });
  it('reads columns in any order and ignores extras', () => {
    const r = validateImport(parseCsv('extra,family,hold_waste,hold_yellow,hold_magenta,hold_cyan,hold_black,vantage_customer_id\r\nz,F1,1,2,3,4,5,9'));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ vantageCustomerId: 9, family: 'F1', holding: { black: 5, cyan: 4, magenta: 3, yellow: 2, waste: 1 } });
  });
});
