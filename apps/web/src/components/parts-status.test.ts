import { describe, expect, it } from 'vitest';
import type { PartStatusRow } from '@mps/db/queries';
import {
  lastFittedText,
  lastVisitLine,
  partPagesText,
  partAlarmDateText,
  partRowLabel,
  partStateLabel,
  partStateTitle,
  partStateTone,
  pctLeftText,
  pctLeftTone,
  ratedLifeNote,
} from './parts-status';

const row = (over: Partial<PartStatusRow> = {}): PartStatusRow => ({
  part: 'drum',
  colour: 'K',
  state: 'ok',
  alarm: null,
  lastFitted: null,
  pagesSince: null,
  pagesSinceEstimated: false,
  ratedLife: null,
  pctLeft: null,
  ...over,
});

describe('partRowLabel', () => {
  it('adds the colour for drum and developer', () => {
    expect(partRowLabel({ part: 'drum', colour: 'K' })).toBe('Drum K');
    expect(partRowLabel({ part: 'developer', colour: 'C' })).toBe('Developer C');
  });
  it('names one-per-machine parts alone', () => {
    expect(partRowLabel({ part: 'transfer_belt', colour: null })).toBe('Transfer belt');
    expect(partRowLabel({ part: 'transfer_roller', colour: null })).toBe('Transfer roller');
    expect(partRowLabel({ part: 'fuser', colour: null })).toBe('Fuser');
  });
});

describe('part state', () => {
  it('labels and tones each state', () => {
    expect(partStateLabel('end')).toBe('End');
    expect(partStateLabel('near_end')).toBe('Near end');
    expect(partStateLabel('predicted')).toBe('Predicted');
    expect(partStateLabel('cleared')).toBe('Cleared');
    expect(partStateLabel('ok')).toBe('OK');
    expect(partStateTone('end')).toBe('critical');
    expect(partStateTone('near_end')).toBe('warn');
    expect(partStateTone('predicted')).toBe('warn');
    expect(partStateTone('cleared')).toBe('muted');
    expect(partStateTone('ok')).toBe('ok');
  });
  it('puts the alarm date in the tooltip', () => {
    expect(partStateTitle(row({ state: 'end', alarm: { level: 'end', receivedAt: new Date('2026-11-02T10:00:00Z') } }))).toBe(
      'End of life — DRMS 2nd call (alarm 2 Nov 2026)',
    );
    expect(partStateTitle(row())).toBe('No parts alarm');
  });
});

describe('pctLeftText / pctLeftTone', () => {
  it('rounds to a whole percent with a tilde', () => {
    expect(pctLeftText(0.123)).toBe('~12%');
    expect(pctLeftText(1)).toBe('~100%');
    expect(pctLeftText(0)).toBe('~0%');
  });
  it('is blank when unknown', () => {
    expect(pctLeftText(null)).toBe('');
    expect(pctLeftText(Number.NaN)).toBe('');
  });
  it('tones low life', () => {
    expect(pctLeftTone(0.05)).toBe('critical');
    expect(pctLeftTone(0.1)).toBe('critical');
    expect(pctLeftTone(0.2)).toBe('warn');
    expect(pctLeftTone(0.5)).toBeNull();
    expect(pctLeftTone(null)).toBeNull();
  });
});

describe('lastFittedText', () => {
  it('shows the fit date', () => {
    expect(lastFittedText({ day: '2026-03-04', at: new Date('2026-03-04T11:00:00Z') })).toBe('4 Mar 2026');
  });
  it('says when no fit is in the history', () => {
    expect(lastFittedText(null)).toBe('not seen in 36 months');
  });
});

describe('partPagesText', () => {
  it('formats pages, marking interpolated ones', () => {
    expect(partPagesText(12345, false)).toBe('12,345');
    expect(partPagesText(12345.4, true)).toBe('~12,345');
  });
  it('is blank when unknown', () => {
    expect(partPagesText(null, false)).toBe('');
  });
});

describe('lastVisitLine', () => {
  it('gives the date and pages since', () => {
    expect(lastVisitLine({ day: '2026-11-03', at: new Date('2026-11-03T10:00:00Z'), pagesSince: 4200 })).toBe(
      'Last visit 3 Nov 2026 · 4,200 pages since',
    );
  });
  it('leaves out unknown pages', () => {
    expect(lastVisitLine({ day: '2026-11-03', at: new Date('2026-11-03T10:00:00Z'), pagesSince: null })).toBe('Last visit 3 Nov 2026');
  });
  it('says when there is none', () => {
    expect(lastVisitLine(null)).toBe('No field visit on record');
  });
});

describe('ratedLifeNote', () => {
  it('explains a machine with no family', () => {
    expect(ratedLifeNote({ familyName: null, parts: [row()] })).toMatch(/not in a cartridge family/);
  });
  it('explains a family with no lives set', () => {
    expect(ratedLifeNote({ familyName: 'C300i', parts: [row()] })).toMatch(/No rated part lives set for C300i/);
  });
  it('is null when a life is set', () => {
    expect(ratedLifeNote({ familyName: 'C300i', parts: [row({ ratedLife: 100000 })] })).toBeNull();
  });
});

describe('partAlarmDateText', () => {
  it('shows the alarm date, blank when none', () => {
    expect(partAlarmDateText(row({ state: 'end', alarm: { level: 'end', receivedAt: new Date('2026-11-02T10:00:00Z') } }))).toBe('2 Nov 2026');
    expect(partAlarmDateText(row())).toBe('');
  });
});
