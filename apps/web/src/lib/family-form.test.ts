import { describe, expect, it } from 'vitest';
import { SiteStockError } from '@mps/db/queries';
import { familyCarries, parseModels } from './family-fields';
import { familyErrorMessage, parseFamilyForm, parseYield } from './family-form';

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SiteStockError ? err.code : `not a SiteStockError: ${String(err)}`;
  }
  return undefined;
}

describe('parseModels', () => {
  it('splits on commas, semicolons and newlines, trimming and dropping blanks', () => {
    expect(parseModels(' bizhub C300i,bizhub C250i;\n\nbizhub C360i \r\n, ')).toEqual([
      'bizhub C300i',
      'bizhub C250i',
      'bizhub C360i',
    ]);
  });

  it('drops repeats, keeps first-seen order and squeezes inner spaces', () => {
    expect(parseModels('bizhub  C300i, bizhub 4050i, bizhub C300i')).toEqual(['bizhub C300i', 'bizhub 4050i']);
  });

  it('gives an empty list for nothing', () => {
    expect(parseModels('')).toEqual([]);
    expect(parseModels(' , ;\n')).toEqual([]);
  });
});

describe('parseYield', () => {
  it('reads blank as not known', () => {
    expect(parseYield('')).toBeNull();
    expect(parseYield('   ')).toBeNull();
  });

  it('reads whole pages, allowing thousands separators', () => {
    expect(parseYield('28000')).toBe(28000);
    expect(parseYield(' 28,000 ')).toBe(28000);
  });

  it('refuses zero, negatives, decimals and words', () => {
    for (const raw of ['0', '-5', '12.5', '1e4', 'lots']) expect(codeOf(() => parseYield(raw))).toBe('bad_value');
  });
});

describe('familyCarries', () => {
  it('lets a mono family carry black and waste only', () => {
    expect(familyCarries(false, 'black')).toBe(true);
    expect(familyCarries(false, 'waste')).toBe(true);
    expect(familyCarries(false, 'cyan')).toBe(false);
    expect(familyCarries(true, 'cyan')).toBe(true);
  });
});

describe('parseFamilyForm', () => {
  it('reads a new colour family with chips, typed models and yields', () => {
    const args = parseFamilyForm(
      form([
        ['name', ' C300i family '],
        ['kind', 'colour'],
        ['model', 'bizhub C300i'],
        ['model', 'bizhub C250i'],
        ['modelsText', 'bizhub C360i, bizhub C300i'],
        ['yield-black', '28000'],
        ['yield-cyan', '28000'],
        ['yield-magenta', ''],
        ['yield-yellow', '28000'],
        ['yield-waste', '125000'],
        ['notes', ' TN-328 '],
      ]),
    );
    expect(args).toEqual({
      name: 'C300i family',
      isColour: true,
      models: ['bizhub C300i', 'bizhub C250i', 'bizhub C360i'],
      ratedYield: { black: 28000, cyan: 28000, magenta: null, yellow: 28000, waste: 125000 },
      notes: 'TN-328',
      pmIntervalPages: null,
      partLives: { drumK: null, drumCmy: null, developerK: null, developerCmy: null, transferBelt: null, transferRoller: null, fuser: null },
    });
  });

  it('clears cyan, magenta and yellow for a mono family whatever was posted', () => {
    const args = parseFamilyForm(
      form([
        ['id', '7'],
        ['name', 'Mono'],
        ['kind', 'mono'],
        ['yield-black', '25000'],
        ['yield-cyan', 'junk'],
        ['yield-magenta', '9'],
      ]),
    );
    expect(args.id).toBe(7);
    expect(args.isColour).toBe(false);
    expect(args.ratedYield).toEqual({ black: 25000, cyan: null, magenta: null, yellow: null, waste: null });
  });

  it('refuses a crafted id and a bad yield', () => {
    expect(codeOf(() => parseFamilyForm(form([['id', 'x'], ['name', 'A']])))).toBe('not_found');
    expect(codeOf(() => parseFamilyForm(form([['name', 'A'], ['yield-black', '0']])))).toBe('bad_value');
  });
});

describe('PM interval', () => {
  it('blank PM interval = null (use global)', () => {
    expect(parseFamilyForm(form([['name', 'A'], ['pmInterval', '  ']])).pmIntervalPages).toBeNull();
    expect(parseFamilyForm(form([['name', 'A']])).pmIntervalPages).toBeNull();
  });

  it('120,000 → 120000', () => {
    expect(parseFamilyForm(form([['name', 'A'], ['pmInterval', '120,000']])).pmIntervalPages).toBe(120000);
  });

  it('refuses zero, decimals and words', () => {
    for (const raw of ['0', '-1', '1.5', 'often']) {
      expect(codeOf(() => parseFamilyForm(form([['name', 'A'], ['pmInterval', raw]])))).toBe('bad_value');
    }
  });
});

describe('familyErrorMessage', () => {
  it('turns a known code into its sentence and anything else into a fallback', () => {
    expect(familyErrorMessage('in_use')).toBe('Shelves still use this family. Delete them first; to make it mono, set their cyan, magenta and yellow to 0 first.');
    expect(familyErrorMessage('<script>')).toBe('The family was not saved. Refresh the page and try again.');
  });
});

describe('rated part lives', () => {
  const lives = (rows: [string, string][], kind = 'colour') =>
    parseFamilyForm(form([['name', 'A'], ['kind', kind], ...rows])).partLives;

  it('blank = null, digits and commas are whole pages', () => {
    expect(lives([['life-drumK', '100,000'], ['life-fuser', ' 200000 '], ['life-transferBelt', '']])).toEqual({
      drumK: 100000, drumCmy: null, developerK: null, developerCmy: null, transferBelt: null, transferRoller: null, fuser: 200000,
    });
  });

  it('clears the colour drum and developer lives of a mono family', () => {
    const l = lives([['life-drumK', '90000'], ['life-drumCmy', '50000'], ['life-developerCmy', '50000']], 'mono');
    expect(l).toMatchObject({ drumK: 90000, drumCmy: null, developerCmy: null });
  });

  it('refuses zero, decimals and words', () => {
    for (const raw of ['0', '1.5', 'lots', '-3']) {
      expect(codeOf(() => lives([['life-fuser', raw]]))).toBe('bad_value');
    }
  });
});
