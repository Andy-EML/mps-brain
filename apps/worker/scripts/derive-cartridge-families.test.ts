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
  });
});
