import { describe, expect, it } from 'vitest';
import { colourLabel, lineChips, lineText, type ChipLine } from './colour-chip';

const line = (over: Partial<ChipLine> = {}): ChipLine => ({
  vantageId: 1,
  details: 'Xerox B310 Black Toner',
  itemDescription: 'Miscellaneous',
  itemPartNumber: 'MISC',
  quantity: 1,
  colour: 'black',
  returnedDate: null,
  ...over,
});

describe('colourLabel', () => {
  it('names every colour the summary shows', () => {
    expect(colourLabel('black')).toBe('Black');
    expect(colourLabel('cyan')).toBe('Cyan');
    expect(colourLabel('magenta')).toBe('Magenta');
    expect(colourLabel('yellow')).toBe('Yellow');
    expect(colourLabel('waste')).toBe('Waste');
  });

  it('calls anything it cannot place "Unknown"', () => {
    expect(colourLabel('unknown')).toBe('Unknown');
    expect(colourLabel(null)).toBe('Unknown');
    expect(colourLabel('chartreuse')).toBe('Unknown');
  });
});

describe('lineText', () => {
  it('prefers Details, because it is the only readable label on a MISC line', () => {
    expect(lineText(line())).toBe('Xerox B310 Black Toner');
  });

  it('falls back to the item description, then the part number, then a placeholder', () => {
    expect(lineText(line({ details: null }))).toBe('Miscellaneous');
    expect(lineText(line({ details: '  ', itemDescription: null }))).toBe('MISC');
    expect(lineText(line({ details: null, itemDescription: null, itemPartNumber: null }))).toBe('Unnamed line');
  });
});

describe('lineChips', () => {
  it('keeps line order — a black+magenta order reads left to right as it was ordered', () => {
    const chips = lineChips([
      line({ vantageId: 10, colour: 'black' }),
      line({ vantageId: 11, colour: 'magenta', details: 'Olivetti MF304 Magenta Toner' }),
    ]);
    expect(chips.map((c) => c.colour)).toEqual(['black', 'magenta']);
    expect(chips.map((c) => c.key)).toEqual([10, 11]);
  });

  it('shows the quantity only when more than one went out', () => {
    const [one, two] = lineChips([line({ vantageId: 1, quantity: 1 }), line({ vantageId: 2, quantity: 2 })]);
    expect(one?.quantityLabel).toBeNull();
    expect(two?.quantityLabel).toBe('2');
  });

  it('labels each chip for screen readers and carries the full line text as its title', () => {
    const [chip] = lineChips([line({ quantity: 2 })]);
    expect(chip?.label).toBe('Black ×2');
    expect(chip?.title).toBe('Xerox B310 Black Toner');

    const [single] = lineChips([line({ quantity: 1 })]);
    expect(single?.label).toBe('Black');
  });

  it('marks waste hollow so it does not read as black, and unknown with a question mark', () => {
    const [waste] = lineChips([line({ colour: 'waste', details: 'Konica Minolta C3351i Waste Toner' })]);
    expect(waste).toMatchObject({ hollow: true, unknown: false, quantityLabel: null });

    const [unknown] = lineChips([line({ colour: 'unknown', details: 'Callout charge' })]);
    expect(unknown).toMatchObject({ unknown: true, hollow: true, label: 'Unknown' });
    expect(unknown?.title).toBe('Callout charge');
  });

  it('flags a returned line in its label rather than hiding it', () => {
    const [chip] = lineChips([line({ returnedDate: new Date('2026-08-01T00:00:00Z') })]);
    expect(chip?.returned).toBe(true);
    expect(chip?.label).toBe('Black (returned)');
  });

  it('handles an order with no lines', () => {
    expect(lineChips([])).toEqual([]);
  });
});
