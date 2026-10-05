import { describe, expect, it } from 'vitest';
import type { QueueProposal } from '@mps/db/queries';
import { approveAllFields, pagesSinceText, reviewChips } from './review-row';

const proposal = (over: Partial<QueueProposal> = {}): QueueProposal => ({
  id: 1,
  colour: 'black',
  trigger: 'threshold',
  level: 4,
  threshold: 10,
  thresholdSource: 'default',
  currentLevel: 3,
  alarmDescription: null,
  quantity: 1,
  status: 'pending',
  createdAt: new Date('2026-09-20T00:00:00Z'),
  decidedAt: null,
  decidedBy: null,
  note: null,
  orderId: null,
  lastOrder: null,
  openOrder: null,
  ...over,
});

describe('reviewChips', () => {
  it('gives one chip per proposed colour with its letter and current level, in K C M Y waste order', () => {
    const chips = reviewChips([
      proposal({ id: 2, colour: 'cyan', currentLevel: 1 }),
      proposal({ id: 1, colour: 'black', currentLevel: 0 }),
    ]);
    expect(chips.map((c) => [c.key, c.letter, c.levelText, c.alarm])).toEqual([
      [1, 'K', '0%', false],
      [2, 'C', '1%', false],
    ]);
    expect(chips[1]!.label).toBe('Cyan 1%');
  });

  it('falls back to the level at proposal time, and shows waste without a level', () => {
    const [chip] = reviewChips([proposal({ colour: 'magenta', currentLevel: null, level: 6 })]);
    expect(chip).toMatchObject({ letter: 'M', levelText: '6%' });
    const [waste] = reviewChips([proposal({ colour: 'waste', level: null, currentLevel: null, trigger: 'alarm' })]);
    expect(waste).toMatchObject({ letter: 'W', levelText: null, alarm: true, label: 'Waste toner box (DRMS alarm)' });
  });

  it('marks a chip raised by a DRMS alarm', () => {
    const [chip] = reviewChips([proposal({ colour: 'yellow', trigger: 'alarm', currentLevel: 12 })]);
    expect(chip).toMatchObject({ alarm: true, label: 'Yellow 12% (DRMS alarm)' });
  });
});

describe('approveAllFields', () => {
  it('posts every proposal id with its current quantity, as the per-line form does', () => {
    expect(approveAllFields('d1', [proposal({ id: 7, quantity: 2 }), proposal({ id: 9, quantity: 1 })])).toEqual([
      ['drmsId', 'd1'],
      ['proposalId', '7'],
      ['qty-7', '2'],
      ['proposalId', '9'],
      ['qty-9', '1'],
    ]);
  });

  it('clamps a stored quantity into the 1–20 range the server accepts', () => {
    expect(approveAllFields('d1', [proposal({ id: 3, quantity: 40 })])).toContainEqual(['qty-3', '20']);
    expect(approveAllFields('d1', [proposal({ id: 3, quantity: 0 })])).toContainEqual(['qty-3', '1']);
  });
});

describe('pagesSinceText', () => {
  const orderDate = new Date('2026-08-01T10:00:00Z');
  it('reads each outcome as a short phrase', () => {
    expect(
      pagesSinceText({ kind: 'pages', pages: 12_345, orderDate, baselineAt: orderDate, currentAt: orderDate }),
    ).toBe('12,345 pages since 1 Aug 2026');
    expect(pagesSinceText({ kind: 'no-reading', orderDate })).toBe('no reading at order time (1 Aug 2026)');
    expect(pagesSinceText({ kind: 'meter-reset', orderDate })).toBe('meter reset? (ordered 1 Aug 2026)');
    expect(pagesSinceText({ kind: 'no-order' })).toBe('no previous order');
  });
});
