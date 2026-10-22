import { describe, expect, it } from 'vitest';
import type { QueueDevice, QueueProposal } from '@mps/db/queries';
import { approveAllFields, pagesSinceText, proposalGroups, reviewChips, reviewOrderLines, topUpChips, topUpWhy } from './review-row';

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
  shelfId: null,
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

describe('site stock top-ups', () => {
  const shelf = { id: 4, siteName: 'Hereford', familyName: 'C450i / C550i / C650i', machines: 2 };
  const topUp = (over: Partial<QueueProposal>) =>
    proposal({ trigger: 'site_stock', shelfId: 4, level: null, currentLevel: null, ...over });

  it("splits the top-up lines from the device's own proposals", () => {
    const own = proposal({ id: 1, colour: 'magenta' });
    const k = topUp({ id: 2, colour: 'black', quantity: 3 });
    expect(proposalGroups({ shelf, proposals: [k, own] })).toEqual({ topUp: [k], own: [own] });
  });

  it("treats every proposal as the device's own when the shelf is missing (dangling) or another one", () => {
    const k = topUp({ id: 2 });
    expect(proposalGroups({ shelf: null, proposals: [k] })).toEqual({ topUp: [], own: [k] });
    expect(proposalGroups({ shelf: { ...shelf, id: 9 }, proposals: [k] })).toEqual({ topUp: [], own: [k] });
  });

  it('shows one chip per top-up line with the cartridges to send, in K C M Y W order', () => {
    const chips = topUpChips([
      topUp({ id: 3, colour: 'yellow', quantity: 1 }),
      topUp({ id: 2, colour: 'black', quantity: 3 }),
      topUp({ id: 5, colour: 'waste', quantity: 2 }),
      topUp({ id: 4, colour: 'cyan', quantity: 1 }),
    ]);
    expect(chips.map((c) => [c.colour, c.text])).toEqual([
      ['black', 'K × 3'],
      ['cyan', 'C × 1'],
      ['yellow', 'Y × 1'],
      ['waste', 'W × 2'],
    ]);
    expect(chips[0]!.label).toBe('Black × 3 (site stock top-up)');
  });

  it('clamps a stored quantity on the chip to what the form will post', () => {
    expect(topUpChips([topUp({ quantity: 40 })])[0]!.text).toBe('K × 20');
  });

  it('explains the top-up by its newest line', () => {
    const lines = [
      topUp({ id: 2, colour: 'black', createdAt: new Date('2026-10-19T10:00:00Z') }),
      topUp({ id: 3, colour: 'cyan', createdAt: new Date('2026-10-12T10:00:00Z') }),
    ];
    expect(topUpWhy(lines, 'Reception C450i')).toBe('Last black spare went in 19 Oct 2026 (Reception C450i)');
    expect(topUpWhy([], 'Reception C450i')).toBeNull();
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

describe('reviewOrderLines', () => {
  it('splits toner/waste chips from the other lines, in order', () => {
    const out = reviewOrderLines([
      { kind: 'toner', colour: 'black', quantity: 1 },
      { kind: 'other', text: 'Drum unit', quantity: 1 },
      { kind: 'toner', colour: 'waste', quantity: 2 },
      { kind: 'other', text: 'Fuser', quantity: 3 },
      { kind: 'other', text: 'No quantity', quantity: null },
    ]);
    expect(out.toner).toEqual([
      { colour: 'black', quantity: 1 },
      { colour: 'waste', quantity: 2 },
    ]);
    expect(out.other).toEqual([
      { text: 'Drum unit', title: 'Drum unit' },
      { text: 'Fuser ×3', title: 'Fuser ×3' },
      { text: 'No quantity', title: 'No quantity' },
    ]);
    expect(out.hidden).toBe(0);
  });

  it('shortens a long line and keeps the full text for the hover', () => {
    const long = 'Engineer visit to replace the fuser unit and clean the paper path after repeated jams on tray 2';
    const [line] = reviewOrderLines([{ kind: 'other', text: long, quantity: 2 }]).other;
    expect(line!.text.length).toBeLessThanOrEqual(60 + ' ×2'.length);
    expect(line!.text.endsWith('… ×2')).toBe(true);
    expect(line!.title).toBe(`${long} ×2`);
  });

  it('shows at most three other lines and counts the rest', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'].map((text) => ({ kind: 'other' as const, text, quantity: 1 }));
    const out = reviewOrderLines(lines);
    expect(out.other.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    expect(out.hidden).toBe(2);
  });
});
