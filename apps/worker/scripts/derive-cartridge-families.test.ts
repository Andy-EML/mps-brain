import { isColourModel } from '@mps/core';
import { describe, expect, it } from 'vitest';
import { familyName, groupModelsByPart, renderCsv } from './derive-cartridge-families';

const models = [
  'bizhub 450i',
  'bizhub 451i',
  'bizhub 550i',
  'bizhub 650i',
  'bizhub C250i',
  'bizhub C300i',
  'bizhub C360i',
  'bizhub 4750i',
];

describe('groupModelsByPart', () => {
  const lines = [
    { details: 'Konica Minolta TN-515 Toner 450i/451i', partNumber: 'ACV1150' },
    { details: 'Toner for 550i and 650i', partNumber: 'ACV1150' },
    { details: 'Black toner C250i, C300i, C360i', partNumber: 'AAV8150' },
    { details: 'Paper A4', partNumber: 'PAPER' },
    { details: 'bizhub 4750i unit', partNumber: null },
  ];

  it('groups models under the part whose line text names their number', () => {
    expect(groupModelsByPart(lines, models)).toEqual([
      { part: 'AAV8150', models: ['bizhub C250i', 'bizhub C300i', 'bizhub C360i'] },
      { part: 'ACV1150', models: ['bizhub 450i', 'bizhub 451i', 'bizhub 550i', 'bizhub 650i'] },
    ]);
  });

  it('merges parts that share a model into one family', () => {
    const groups = groupModelsByPart(
      [
        { details: 'toner 450i', partNumber: 'AAA1111' },
        { details: 'toner 450i 550i', partNumber: 'BBB2222' },
      ],
      ['bizhub 450i', 'bizhub 550i'],
    );
    expect(groups).toEqual([{ part: 'AAA1111, BBB2222', models: ['bizhub 450i', 'bizhub 550i'] }]);
  });

  it('keeps mono and colour models of the same number apart', () => {
    const groups = groupModelsByPart(
      [
        { details: 'toner 300i', partNumber: 'AAA1111' },
        { details: 'toner C300i', partNumber: 'BBB2222' },
      ],
      ['bizhub 300i', 'bizhub C300i'],
    );
    expect(groups).toEqual([
      { part: 'AAA1111', models: ['bizhub 300i'] },
      { part: 'BBB2222', models: ['bizhub C300i'] },
    ]);
  });

  it('lets a bare number claim a colour model only when no mono sibling exists', () => {
    expect(groupModelsByPart([{ details: 'toner 300i', partNumber: 'AAA1111' }], ['bizhub C300i'])).toEqual([
      { part: 'AAA1111', models: ['bizhub C300i'] },
    ]);
    expect(groupModelsByPart([{ details: 'toner 300i', partNumber: 'AAA1111' }], ['bizhub 300i', 'bizhub C300i'])).toEqual([
      { part: 'AAA1111', models: ['bizhub 300i'] },
    ]);
  });

  it('never puts bare-number shorthand of a colour line on a mono model (Ineo +300i, C750/751i)', () => {
    const groups = groupModelsByPart(
      [
        { details: 'Konica C250i / Develop +250i Black Toner', partNumber: 'AAV8150' },
        { details: 'Develop Ineo +300i Black Toner', partNumber: 'AAV8150' },
        { details: 'Konica Minolta C300i Black Toner', partNumber: 'AAV8150' },
        { details: 'Konica Minolta C750/751i Black Toner', partNumber: 'ACP8150' },
        { details: 'Konica Minolta C750i Black Toner', partNumber: 'ACP8150' },
      ],
      ['bizhub 300i', 'bizhub C250i', 'bizhub C300i', 'ineo+250i', 'ineo+300i', 'bizhub 751i', 'bizhub C750i', 'bizhub C751i'],
    );
    expect(groups).toEqual([
      { part: 'AAV8150', models: ['bizhub C250i', 'bizhub C300i', 'ineo+250i', 'ineo+300i'] },
      { part: 'ACP8150', models: ['bizhub C750i', 'bizhub C751i'] },
    ]);
  });

  it('maps a mono model from plain lines and keeps it in its own group', () => {
    const groups = groupModelsByPart(
      [
        { details: 'KM Toner Black for 751i', partNumber: 'ACYP050' },
        { details: 'Konica Minolta C751i Black Toner', partNumber: 'ACP8150' },
      ],
      ['bizhub 751i', 'bizhub C751i', 'bizhub C750i'],
    );
    expect(groups).toEqual([
      { part: 'ACP8150', models: ['bizhub C751i'] },
      { part: 'ACYP050', models: ['bizhub 751i'] },
    ]);
    for (const g of groups) expect(new Set(g.models.map((m) => isColourModel(m))).size).toBe(1);
  });

  it('recognises other KM part code shapes and shorthand model forms', () => {
    const groups = groupModelsByPart(
      [
        { details: 'Konica Minolta C3350i Black Toner', partNumber: 'AAJW150' },
        { details: 'Develop +3350i Cyan Toner', partNumber: 'AAJW450' },
        { details: 'Konica Minolta C3350/1i Magenta Toner', partNumber: 'AAJW350' },
        { details: 'Konica Minolta 4050i Black Toner', partNumber: 'ACTD050' },
        { details: 'Olivetti MF3303 Black Toner', partNumber: 'AAJW150/B1337' },
      ],
      ['bizhub C3350i', 'bizhub C3351i', 'ineo+3350i', 'ineo+3351', 'bizhub 4050i'],
    );
    expect(groups).toEqual([
      { part: 'AAJW150, AAJW350, AAJW450', models: ['bizhub C3350i', 'bizhub C3351i', 'ineo+3350i', 'ineo+3351'] },
      { part: 'ACTD050', models: ['bizhub 4050i'] },
    ]);
  });

  it('takes the part code from the details text when no part number is stored', () => {
    const groups = groupModelsByPart([{ details: 'ACV1150 toner for 450i', partNumber: null }], ['bizhub 450i']);
    expect(groups).toEqual([{ part: 'ACV1150', models: ['bizhub 450i'] }]);
  });

  it('matches whole tokens only (450i does not match 1450i) and ignores lines without a part code', () => {
    expect(groupModelsByPart([{ details: 'toner 1450i', partNumber: 'ACV1150' }], ['bizhub 450i'])).toEqual([]);
    expect(groupModelsByPart([{ details: 'toner 450i', partNumber: 'PAPER' }], ['bizhub 450i'])).toEqual([]);
  });
});

describe('renderCsv', () => {
  it('prints families, a blank line, then unmapped models', () => {
    const csv = renderCsv(
      [{ part: 'AAV8150', models: ['bizhub C250i', 'bizhub C300i'] }],
      [{ model: 'bizhub 4750i', devices: 3 }],
    );
    expect(csv).toBe(
      [
        'family,is_colour,parts,models',
        'C250i / C300i,true,AAV8150,bizhub C250i | bizhub C300i',
        '',
        'unmapped_model,devices',
        'bizhub 4750i,3',
      ].join('\n'),
    );
    expect(familyName(['ineo+ 300i'])).toBe('300i');
    expect(familyName(['bizhub C300i', 'ineo+300i', 'ineo+250i'])).toBe('C300i / 250i');
  });
});
