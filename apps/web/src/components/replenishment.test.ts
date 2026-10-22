import { describe, expect, it } from 'vitest';
import {
  colourLabel,
  decisionBackPath,
  orderStatusTone,
  proposalStatusLink,
  replenishmentErrorMessage,
  settingOrigin,
  sourceLabel,
  supersededText,
  triggerLabel,
} from './replenishment';

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

  it('says when and where the last spare went in for a site stock top-up, on the London date', () => {
    // 23:30 UTC on 19 Oct is 00:30 on 20 Oct in London (BST).
    const createdAt = new Date('2026-10-19T23:30:00Z');
    expect(triggerLabel({ trigger: 'site_stock', colour: 'black', createdAt }, 'Reception C450i')).toBe(
      'Last black spare went in 20 Oct 2026 (Reception C450i)',
    );
    expect(triggerLabel({ trigger: 'site_stock', colour: 'waste', createdAt }, 'Reception C450i')).toBe(
      'Last waste toner box spare went in 20 Oct 2026 (Reception C450i)',
    );
  });

  it('drops the device for a top-up when no name is given', () => {
    expect(triggerLabel({ trigger: 'site_stock', colour: 'cyan', createdAt: new Date('2026-10-01T09:00:00Z') })).toBe(
      'Last cyan spare went in 1 Oct 2026',
    );
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

describe('decisionBackPath', () => {
  it('sends an error back to the page the decision was made on', () => {
    expect(decisionBackPath(null, 'd1')).toBe('/orders');
    expect(decisionBackPath('in-progress', 'd1')).toBe('/orders?tab=in-progress');
    expect(decisionBackPath('device', 'abc/1')).toBe('/devices/abc%2F1');
  });

  it('falls back to the queue for a device page without a device', () => {
    expect(decisionBackPath('device', '')).toBe('/orders');
    expect(decisionBackPath('device', null)).toBe('/orders');
  });
});

describe('replenishmentErrorMessage', () => {
  it('turns a known code into a sentence and anything else into a generic one', () => {
    expect(replenishmentErrorMessage('empty')).toMatch(/Nothing was selected/);
    expect(replenishmentErrorMessage('what')).toBe('That did not work. Refresh the page and try again.');
  });
});

describe('supersededText', () => {
  it('says why the proposal was superseded, including an order raised in Vantage', () => {
    expect(supersededText('ordered in Vantage (SO123)')).toBe('Superseded: ordered in Vantage (SO123)');
    expect(supersededText('level recovered')).toBe('Superseded: level recovered');
    expect(supersededText(null)).toBe('Superseded');
  });
});

describe('proposalStatusLink', () => {
  it("says where a device card's proposal stands and which queue tab holds it", () => {
    expect(proposalStatusLink({ status: 'pending', note: null })).toEqual({ text: 'Awaiting review', href: '/orders' });
    expect(proposalStatusLink({ status: 'approved', note: null })).toEqual({ text: 'Approved', href: '/orders?tab=in-progress' });
    expect(proposalStatusLink({ status: 'rejected', note: 'dup' })).toEqual({ text: 'Rejected', href: '/orders?tab=rejected' });
    expect(proposalStatusLink({ status: 'superseded', note: 'ordered in Vantage (SO9)' })).toEqual({
      text: 'Superseded: ordered in Vantage (SO9)',
      href: '/orders?tab=rejected',
    });
    expect(proposalStatusLink({ status: 'ordered', note: null })).toEqual({ text: 'Ordered', href: '/orders?tab=ordered' });
  });
});
