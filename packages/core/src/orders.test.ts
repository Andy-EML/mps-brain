import { describe, expect, it } from 'vitest';
import { classifyOrderLine, ORDER_COLOURS } from './orders';

describe('classifyOrderLine with device context', () => {
  it('classifies a colourless toner line as black when the device is mono', () => {
    // Real mono descriptions from live data (2026-09-25): no colour word, but clearly toner.
    expect(
      classifyOrderLine({ details: 'Konica Minolta 300i Toner - TN330A' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'black', source: 'mono-device' });
    expect(
      classifyOrderLine(
        { details: 'TNP90 Konica Minolta bizhub 4750i/4050i Toner' },
        { deviceIsColour: false },
      ),
    ).toEqual({ colour: 'black', source: 'mono-device' });
    expect(
      classifyOrderLine({ details: 'Konica Minolta 4700i Toner' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'black', source: 'mono-device' });
  });

  it('also matches a KM toner part number with no "toner" word, from the item description', () => {
    expect(
      classifyOrderLine({ itemDescription: 'TN330A' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'black', source: 'mono-device' });
  });

  it('leaves a colour device with no colour word as unknown', () => {
    expect(
      classifyOrderLine({ details: 'Konica Minolta 300i Toner - TN330A' }, { deviceIsColour: true }),
    ).toEqual({ colour: 'unknown', source: 'none' });
  });

  it('leaves a mono device line as unknown when it is not toner-shaped', () => {
    expect(classifyOrderLine({ details: 'SK-704 Staples Cartridge' }, { deviceIsColour: false })).toEqual({
      colour: 'unknown',
      source: 'none',
    });
    expect(
      classifyOrderLine({ details: 'Staples - SH10 (SK-602)' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'unknown', source: 'none' });
    expect(classifyOrderLine({ details: 'misc' }, { deviceIsColour: false })).toEqual({
      colour: 'unknown',
      source: 'none',
    });
  });

  it('never overrides a colour or waste already found in the text', () => {
    // Waste toner box on a mono device must stay waste, not become black.
    expect(
      classifyOrderLine({ itemDescription: 'Waste toner bottle' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'waste', source: 'item' });
    // A colour word already resolves the line before the mono fallback is ever considered.
    expect(
      classifyOrderLine({ details: 'Cyan Toner' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'cyan', source: 'details' });
  });

  it('does not guess drum, imaging unit or developer parts as toner', () => {
    expect(
      classifyOrderLine({ details: 'Drum unit DR-512' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'unknown', source: 'none' });
    expect(
      classifyOrderLine({ details: 'Imaging Unit IU-313' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'unknown', source: 'none' });
    expect(
      classifyOrderLine({ details: 'Developer unit DV-512' }, { deviceIsColour: false }),
    ).toEqual({ colour: 'unknown', source: 'none' });
  });

  it('leaves behaviour unchanged when no context is given, even for a toner-shaped line', () => {
    expect(classifyOrderLine({ details: 'Konica Minolta 4700i Toner' })).toEqual({
      colour: 'unknown',
      source: 'none',
    });
  });

  it('leaves behaviour unchanged when deviceIsColour is null or undefined (unknown device)', () => {
    expect(
      classifyOrderLine({ details: 'Konica Minolta 4700i Toner' }, { deviceIsColour: null }),
    ).toEqual({ colour: 'unknown', source: 'none' });
    expect(
      classifyOrderLine({ details: 'Konica Minolta 4700i Toner' }, { deviceIsColour: undefined }),
    ).toEqual({ colour: 'unknown', source: 'none' });
  });
});

describe('classifyOrderLine', () => {
  it('reads the colour out of the real Details strings', () => {
    // The four examples confirmed against live Vantage data on 2026-09-18.
    expect(classifyOrderLine({ details: 'Xerox B310 Black Toner', partNumber: 'MISC' })).toEqual({
      colour: 'black',
      source: 'details',
    });
    expect(classifyOrderLine({ details: 'Olivetti MF304 Magenta Toner', partNumber: 'B1168' })).toEqual({
      colour: 'magenta',
      source: 'details',
    });
    expect(classifyOrderLine({ details: 'Konica Minolta C3351i Waste Toner', partNumber: 'MIN90014' })).toEqual({
      colour: 'waste',
      source: 'details',
    });
    expect(
      classifyOrderLine({ details: 'Konica Minolta C3351i Black Toner - CMYK', partNumber: 'MISC' }),
    ).toEqual({ colour: 'black', source: 'details' });
  });

  it('matches Details before the item description', () => {
    expect(
      classifyOrderLine({ details: 'Cyan Toner', itemDescription: 'Yellow Toner Cartridge' }),
    ).toEqual({ colour: 'cyan', source: 'details' });
  });

  it('falls back to the item description when Details is empty or has no colour', () => {
    expect(classifyOrderLine({ details: '', itemDescription: 'bizhub Yellow Toner' })).toEqual({
      colour: 'yellow',
      source: 'item',
    });
    expect(classifyOrderLine({ details: 'Toner cartridge', itemDescription: 'TN328C Cyan' })).toEqual({
      colour: 'cyan',
      source: 'item',
    });
    expect(classifyOrderLine({ itemDescription: 'Waste toner bottle' })).toEqual({
      colour: 'waste',
      source: 'item',
    });
  });

  it('gives up rather than guessing', () => {
    expect(classifyOrderLine({ details: 'Callout charge', itemDescription: 'Engineer visit' })).toEqual({
      colour: 'unknown',
      source: 'none',
    });
    expect(classifyOrderLine({})).toEqual({ colour: 'unknown', source: 'none' });
    expect(classifyOrderLine({ details: null, itemDescription: null, partNumber: null })).toEqual({
      colour: 'unknown',
      source: 'none',
    });
  });

  it('lets waste win over a colour that appears alongside it', () => {
    expect(classifyOrderLine({ details: 'Black Waste Toner Box' }).colour).toBe('waste');
    expect(classifyOrderLine({ details: 'Waste unit (CMY)' }).colour).toBe('waste');
  });

  it('takes the first colour when two appear', () => {
    expect(classifyOrderLine({ details: 'Magenta/Yellow twin pack' }).colour).toBe('magenta');
    expect(classifyOrderLine({ details: 'Yellow and Magenta twin pack' }).colour).toBe('yellow');
  });

  it('treats a standalone K or BK as black but never a letter inside a word', () => {
    expect(classifyOrderLine({ details: 'TN713 K Toner' }).colour).toBe('black');
    expect(classifyOrderLine({ details: 'Toner BK' }).colour).toBe('black');
    // "CMYK", "Konica" and "bizhub C3351i" must not read as black/cyan.
    expect(classifyOrderLine({ details: 'Konica Minolta C3351i toner kit CMYK' }).colour).toBe('unknown');
  });

  it('ignores case', () => {
    expect(classifyOrderLine({ details: 'XEROX B310 BLACK TONER' }).colour).toBe('black');
    expect(classifyOrderLine({ details: 'waste toner' }).colour).toBe('waste');
  });

  it('never classifies from the part number alone', () => {
    // Part numbers like MISC or MIN90014 carry no reliable colour; guessing from them would
    // mislabel lines the operator relies on.
    expect(classifyOrderLine({ partNumber: 'TN328K' })).toEqual({ colour: 'unknown', source: 'none' });
  });

  it('exports the display colours in K/C/M/Y then waste order', () => {
    expect(ORDER_COLOURS).toEqual(['black', 'cyan', 'magenta', 'yellow', 'waste']);
  });
});
