import { describe, expect, it } from 'vitest';
import { alarmColour, evaluateDevice, isRecovered, type DeviceReplenishInput } from './replenishment';

const NOW = new Date('2026-09-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function input(over: Partial<DeviceReplenishInput> = {}): DeviceReplenishInput {
  return {
    vantageEquipmentId: 100,
    isColour: true,
    autoReplenish: true,
    thresholds: { black: 15, cyan: 10, magenta: 10, yellow: 10 },
    levels: { black: 50, cyan: 50, magenta: 50, yellow: 50 },
    alarms: [],
    history: {},
    now: NOW,
    ...over,
  };
}
const alarm = (description: string, category: string, receivedAt = daysAgo(1), status = 'ReadyForErpDelivery') => ({
  alarmId: `a-${description}`, receivedAt, category, status, description, fcCode: null,
});

describe('alarmColour', () => {
  it('reads the colour from the toner alarm bracket', () => {
    expect(alarmColour({ category: 'toner', description: 'Toner Near Empty(K)' })).toBe('black');
    expect(alarmColour({ category: 'toner', description: 'Toner Empty(BK)' })).toBe('black');
    expect(alarmColour({ category: 'toner', description: 'Toner Delivery(C)' })).toBe('cyan');
    expect(alarmColour({ category: 'toner', description: 'Toner Near Empty(M)' })).toBe('magenta');
    expect(alarmColour({ category: 'toner', description: 'Toner Delivery(Y)' })).toBe('yellow');
  });
  it('maps any waste alarm to waste and never proposes parts', () => {
    expect(alarmColour({ category: 'waste', description: 'Waste Toner Bottle Almost Full' })).toBe('waste');
    expect(alarmColour({ category: 'parts', description: 'TP-01 PartsLife(IU_M) 2nd Call' })).toBeNull();
    expect(alarmColour({ category: 'toner', description: 'Toner Near Empty' })).toBeNull();
  });
});

describe('evaluateDevice', () => {
  it('proposes a colour strictly below its threshold', () => {
    const r = evaluateDevice(input({ levels: { black: 14, cyan: 10, magenta: 9, yellow: 50 } }));
    expect(r.candidates.map((c) => [c.colour, c.trigger, c.level, c.threshold])).toEqual([
      ['black', 'threshold', 14, 15],
      ['magenta', 'threshold', 9, 10],
    ]);
  });

  it('ignores CMY on a mono device, including CMY alarms', () => {
    const r = evaluateDevice(
      input({ isColour: false, levels: { black: 50, cyan: 0, magenta: 0, yellow: 0 }, alarms: [alarm('Toner Near Empty(C)', 'toner')] }),
    );
    expect(r.candidates).toEqual([]);
  });

  it('proposes from a ready alarm inside the window, including waste', () => {
    const r = evaluateDevice(input({ alarms: [alarm('Toner Near Empty(Y)', 'toner'), alarm('Waste Toner Bottle Full', 'waste')] }));
    expect(r.candidates.map((c) => [c.colour, c.trigger])).toEqual([
      ['yellow', 'alarm'],
      ['waste', 'alarm'],
    ]);
    expect(r.candidates[1]).toMatchObject({ level: null, threshold: null, alarmDescription: 'Waste Toner Bottle Full' });
  });

  it('ignores alarms that are old or not ready for ERP delivery', () => {
    const r = evaluateDevice(
      input({ alarms: [alarm('Toner Near Empty(K)', 'toner', daysAgo(8)), alarm('Toner Near Empty(C)', 'toner', daysAgo(1), 'EquipmentDiscovered')] }),
    );
    expect(r.candidates).toEqual([]);
  });

  it('prefers the threshold trigger but keeps the alarm on the candidate', () => {
    const r = evaluateDevice(input({ levels: { black: 3, cyan: 50, magenta: 50, yellow: 50 }, alarms: [alarm('Toner Empty(BK)', 'toner')] }));
    expect(r.candidates).toEqual([
      { colour: 'black', trigger: 'threshold', level: 3, threshold: 15, alarmId: 'a-Toner Empty(BK)', alarmDescription: 'Toner Empty(BK)' },
    ]);
  });

  it('skips a device with auto-replenish off or no Vantage link', () => {
    expect(evaluateDevice(input({ autoReplenish: false, levels: { black: 1, cyan: 1, magenta: 1, yellow: 1 } }))).toMatchObject({ candidates: [], skipped: 'auto_off' });
    expect(evaluateDevice(input({ vantageEquipmentId: null, levels: { black: 1, cyan: 50, magenta: 50, yellow: 50 } }))).toMatchObject({ candidates: [], skipped: 'unlinked' });
  });

  it('suppresses on a live proposal, an open order, a recent completion and a recent rejection', () => {
    const low = { black: 1, cyan: 1, magenta: 1, yellow: 1 };
    const r = evaluateDevice(
      input({
        levels: low,
        history: {
          black: { liveProposal: true, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: null },
          cyan: { liveProposal: false, hasOpenOrder: true, lastCompletedAt: null, lastRejectedAt: null },
          magenta: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: daysAgo(13), lastRejectedAt: null },
          yellow: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: daysAgo(6) },
        },
      }),
    );
    expect(r.candidates).toEqual([]);
    expect(r.suppressed).toEqual([
      { colour: 'black', reason: 'live_proposal' },
      { colour: 'cyan', reason: 'open_order' },
      { colour: 'magenta', reason: 'recently_completed' },
      { colour: 'yellow', reason: 'recently_rejected' },
    ]);
  });

  it('lets suppression windows expire', () => {
    const r = evaluateDevice(
      input({
        levels: { black: 50, cyan: 50, magenta: 1, yellow: 1 },
        history: {
          magenta: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: daysAgo(15), lastRejectedAt: null },
          yellow: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: daysAgo(8) },
        },
      }),
    );
    expect(r.candidates.map((c) => c.colour)).toEqual(['magenta', 'yellow']);
  });

  it('lets a new alarm after a rejection through', () => {
    const r = evaluateDevice(
      input({
        alarms: [alarm('Toner Near Empty(C)', 'toner', daysAgo(1))],
        history: { cyan: { liveProposal: false, hasOpenOrder: false, lastCompletedAt: null, lastRejectedAt: daysAgo(3) } },
      }),
    );
    expect(r.candidates.map((c) => c.colour)).toEqual(['cyan']);
  });
});

describe('isRecovered', () => {
  it('is true at or above the threshold and false without a reading', () => {
    expect(isRecovered(10, 10)).toBe(true);
    expect(isRecovered(9, 10)).toBe(false);
    expect(isRecovered(null, 10)).toBe(false);
  });
});
