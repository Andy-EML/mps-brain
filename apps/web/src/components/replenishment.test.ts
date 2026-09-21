import { describe, expect, it } from 'vitest';
import { colourLabel, orderStatusTone, settingOrigin, sourceLabel, triggerLabel } from './replenishment';

describe('colourLabel', () => {
  it('names each consumable', () => {
    expect(colourLabel('black')).toBe('Black');
    expect(colourLabel('cyan')).toBe('Cyan');
    expect(colourLabel('magenta')).toBe('Magenta');
    expect(colourLabel('yellow')).toBe('Yellow');
    expect(colourLabel('waste')).toBe('Waste toner box');
  });
});

describe('triggerLabel', () => {
  it('shows the level against the threshold for a threshold proposal', () => {
    expect(triggerLabel({ trigger: 'threshold', level: 4, threshold: 10 })).toBe('4% · below 10%');
  });

  it('quotes the DRMS alarm for an alarm proposal', () => {
    expect(triggerLabel({ trigger: 'alarm', alarmDescription: 'Toner Near Empty(C)' })).toBe(
      'DRMS alarm: Toner Near Empty(C)',
    );
  });

  it('still reads when a value is missing', () => {
    expect(triggerLabel({ trigger: 'alarm', alarmDescription: null })).toBe('DRMS alarm');
    expect(triggerLabel({ trigger: 'threshold', level: null, threshold: 10 })).toBe('— · below 10%');
    expect(triggerLabel({ trigger: 'threshold', level: 4, threshold: null })).toBe('4%');
  });
});

describe('sourceLabel', () => {
  it('says where the threshold came from', () => {
    expect(sourceLabel('device')).toBe('device setting');
    expect(sourceLabel('customer')).toBe('customer setting');
    expect(sourceLabel('default')).toBe('default setting');
  });
});

describe('orderStatusTone', () => {
  it('flags orders a person has to look at', () => {
    expect(orderStatusTone('uncertain')).toBe('critical');
    expect(orderStatusTone('failed')).toBe('critical');
  });

  it('shows in-flight orders as warn and sent ones as ok', () => {
    expect(orderStatusTone('queued')).toBe('warn');
    expect(orderStatusTone('submitting')).toBe('warn');
    expect(orderStatusTone('submitted')).toBe('ok');
  });
});

describe('settingOrigin', () => {
  // 30 Jun 2026 23:30 UTC is already 1 July in London (BST).
  const at = new Date('2026-06-30T23:30:00Z');
  const rows = { deviceRow: { updatedAt: at, updatedBy: 'admin' }, customerRow: { updatedAt: at, updatedBy: 'jo' } };

  it('says who set a device override and when, in London time', () => {
    expect(settingOrigin('device', rows)).toBe('set on this device by admin, 1 Jul 2026');
  });

  it('names the customer setting and who set it', () => {
    expect(settingOrigin('customer', rows)).toBe('customer setting · by jo, 1 Jul 2026');
  });

  it('says default for the global value', () => {
    expect(settingOrigin('default', rows)).toBe('default');
  });

  it('still reads when the user or the row is gone', () => {
    const orphan = { deviceRow: { updatedAt: at, updatedBy: null }, customerRow: null };
    expect(settingOrigin('device', orphan)).toBe('set on this device, 1 Jul 2026');
    expect(settingOrigin('customer', orphan)).toBe('customer setting');
    expect(settingOrigin('device', { deviceRow: null, customerRow: null })).toBe('set on this device');
  });
});
