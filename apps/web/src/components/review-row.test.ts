import { describe, expect, it } from 'vitest';
import type { QueueDevice, QueueProposal } from '@mps/db/queries';
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
  const levels = (over: Partial<QueueDevice['tonerLevels']> = {}): QueueDevice['tonerLevels'] => ({
    black: null, cyan: null, magenta: null, yellow: null, ...over,
  });
  const row = (chips: ReturnType<typeof reviewChips>) => chips.map((c) => [c.letter, c.levelText, c.proposed, c.alarm]);

  it('shows every cartridge of a colour device in K C M Y order, flagging the proposed ones', () => {
    const chips = reviewChips({
      isColour: true,
      tonerLevels: levels({ black: 40, cyan: 1, magenta: 77 }),
      proposals: [proposal({ id: 2, colour: 'cyan', currentLevel: 1 })],
    });
    expect(row(chips)).toEqual([
      ['K', '40%', false, false],
      ['C', '1%', true, false],
      ['M', '77%', false, false],
      ['Y', '—', false, false],
    ]);
    expect(chips.map((c) => c.label)).toEqual(['Black 40%', 'Cyan 1% (proposed)', 'Magenta 77%', 'Yellow no reading']);
  });

  it('shows only black on a mono device', () => {
    const chips = reviewChips({ isColour: false, tonerLevels: levels({ black: 3 }), proposals: [proposal()] });
    expect(row(chips)).toEqual([['K', '3%', true, false]]);
  });

  it('falls back to the level at proposal time for a proposed colour with no reading', () => {
    const chips = reviewChips({ isColour: false, tonerLevels: levels(), proposals: [proposal({ currentLevel: null, level: 6 })] });
    expect(chips[0]).toMatchObject({ letter: 'K', levelText: '6%' });
  });

  it('marks an alarm-raised colour with the bell, and adds waste only when proposed', () => {
    const chips = reviewChips({
      isColour: false,
      tonerLevels: levels({ black: 12 }),
      proposals: [proposal({ trigger: 'alarm' }), proposal({ id: 5, colour: 'waste', level: null, currentLevel: null, trigger: 'alarm' })],
    });
    expect(row(chips)).toEqual([
      ['K', '12%', true, true],
      ['W', null, true, true],
    ]);
    expect(chips.map((c) => c.label)).toEqual(['Black 12% (proposed, DRMS alarm)', 'Waste toner box (proposed, DRMS alarm)']);
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
