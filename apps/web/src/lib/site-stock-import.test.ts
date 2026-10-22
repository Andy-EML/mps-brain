import { describe, expect, it } from 'vitest';
import type { ImportRow } from '@mps/core';
import {
  MAX_IMPORT_BYTES,
  decodeImportRows,
  encodeImportRows,
  importResultMessage,
  importResultParam,
  parseImportResult,
  uploadProblem,
} from './site-stock-import';

const counts = (black: number, cyan = 0, magenta = 0, yellow = 0, waste = 0) => ({ black, cyan, magenta, yellow, waste });

const ROWS: ImportRow[] = [
  { line: 2, vantageCustomerId: 101, family: 'bizhub C551i', holding: counts(1, 1, 1, 1, 1), used: counts(0) },
  { line: 4, vantageCustomerId: 7, family: 'Mono "A4"', holding: counts(20, 0, 0, 0, 2), used: counts(3, 0, 0, 0, 1) },
];

describe('uploadProblem', () => {
  const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'text/csv' });

  it('accepts a non-empty .csv within the limit, any case', () => {
    expect(uploadProblem(file('site-stock.csv', 10))).toBeNull();
    expect(uploadProblem(file('SITE-STOCK.CSV', MAX_IMPORT_BYTES))).toBeNull();
  });

  it('rejects no file, an empty one, a string field, the wrong type and an oversized one', () => {
    expect(uploadProblem(null)).toMatch(/Choose a CSV/);
    expect(uploadProblem('site-stock.csv')).toMatch(/Choose a CSV/);
    expect(uploadProblem(file('site-stock.csv', 0))).toMatch(/Choose a CSV/);
    expect(uploadProblem(file('site-stock.xlsx', 10))).toMatch(/not a \.csv/);
    expect(uploadProblem(file('site-stock.csv', MAX_IMPORT_BYTES + 1))).toMatch(/over 1 MB/);
  });
});

describe('encodeImportRows / decodeImportRows', () => {
  it('round-trips', () => {
    expect(decodeImportRows(encodeImportRows(ROWS))).toEqual(ROWS);
  });

  it('rejects anything that is not what the encoder writes', () => {
    const good = JSON.parse(encodeImportRows(ROWS)) as unknown[][];
    const tamper = (i: number, value: unknown) => {
      const copy = good.map((r) => [...r]);
      copy[0]![i] = value;
      return JSON.stringify(copy);
    };
    expect(decodeImportRows(null)).toBeNull();
    expect(decodeImportRows('')).toBeNull();
    expect(decodeImportRows('not json')).toBeNull();
    expect(decodeImportRows('[]')).toBeNull();
    expect(decodeImportRows('{"rows":[]}')).toBeNull();
    expect(decodeImportRows(JSON.stringify([good[0]!.slice(0, 12)]))).toBeNull(); // too short
    expect(decodeImportRows(tamper(0, 1))).toBeNull(); // line 1 is the header
    expect(decodeImportRows(tamper(1, 0))).toBeNull(); // customer id
    expect(decodeImportRows(tamper(1, '101'))).toBeNull(); // a string, not a number
    expect(decodeImportRows(tamper(2, ' '))).toBeNull(); // blank family
    expect(decodeImportRows(tamper(2, 5))).toBeNull(); // family not text
    expect(decodeImportRows(tamper(3, 21))).toBeNull(); // holding over the max
    expect(decodeImportRows(tamper(3, 1.5))).toBeNull(); // holding not whole
    expect(decodeImportRows(tamper(8, -1))).toBeNull(); // used below 0
    expect(decodeImportRows(tamper(8, 1000))).toBeNull(); // used over 999
    expect(decodeImportRows(tamper(8, 999))).not.toBeNull();
    expect(decodeImportRows(tamper(12, null))).toBeNull(); // used missing
  });
});

describe('import result banner', () => {
  it('round-trips through ?imported=', () => {
    const result = { created: 2, updated: 1, unchanged: 14 };
    expect(importResultParam(result)).toBe('2-1-14');
    expect(parseImportResult(importResultParam(result))).toEqual(result);
  });

  it('ignores anything it did not write', () => {
    expect(parseImportResult(undefined)).toBeNull();
    expect(parseImportResult('')).toBeNull();
    expect(parseImportResult('1-2')).toBeNull();
    expect(parseImportResult('1-2-x')).toBeNull();
    expect(parseImportResult('1-2-3<script>')).toBeNull();
    expect(parseImportResult('1234567-0-0')).toBeNull();
  });

  it('says what happened', () => {
    expect(importResultMessage({ created: 1, updated: 2, unchanged: 14 })).toBe('Import applied: 1 shelf created, 2 updated, 14 unchanged.');
    expect(importResultMessage({ created: 3, updated: 0, unchanged: 0 })).toBe('Import applied: 3 shelves created, 0 updated, 0 unchanged.');
    expect(importResultMessage({ created: 0, updated: 0, unchanged: 9 })).toBe('Import applied: nothing needed changing.');
  });
});
