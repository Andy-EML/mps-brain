import type { DeviceRow } from '@mps/db/queries';
import { describe, expect, it } from 'vitest';
import {
  attentionRank,
  deviceNameAddsInfo,
  deviceStatusLabel,
  hasRecentAlarm,
  tonerHealth,
  tonerState,
  topIssueType,
} from './toner';

const NOW = new Date('2026-09-18T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function row(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    drmsId: 'd1',
    serial: 'A1B2C3D4E',
    name: 'Reception',
    model: 'bizhub C458',
    status: 'Registered',
    customerName: 'Customer A',
    vantageCustomerName: 'Customer A',
    vantageEquipmentId: 10,
    linkMethod: 'serial',
    lastCounterAt: hoursAgo(2),
    offline: false,
    lastAlarmAt: null,
    toner: { black: 50, cyan: 50, magenta: 50, yellow: 50 },
    meters: { black: null, colour: null, scan: null },
    ...over,
  };
}

describe('tonerState', () => {
  it('is unknown for a missing level', () => {
    expect(tonerState(null)).toBe('unknown');
  });

  it('is unknown for a non-finite level', () => {
    expect(tonerState(Number.NaN)).toBe('unknown');
  });

  it('is critical under 5%', () => {
    expect(tonerState(0)).toBe('critical');
    expect(tonerState(4.9)).toBe('critical');
  });

  it('is low from 5% up to (but not including) 20%', () => {
    expect(tonerState(5)).toBe('low');
    expect(tonerState(19.9)).toBe('low');
  });

  it('is ok from 20% up', () => {
    expect(tonerState(20)).toBe('ok');
    expect(tonerState(100)).toBe('ok');
  });
});

describe('deviceStatusLabel', () => {
  it('reports an unlinked device first, even with no meter reading and no toner', () => {
    const label = deviceStatusLabel(
      row({ vantageEquipmentId: null, offline: true, toner: { black: 1, cyan: null, magenta: null, yellow: null } }),
      NOW,
    );
    expect(label).toEqual({ text: 'Not linked', tone: 'muted' });
  });

  it('reports the missing meter reading ahead of a critical toner level, with the hours since the last counter', () => {
    const label = deviceStatusLabel(
      row({ offline: true, lastCounterAt: hoursAgo(6), toner: { black: 1, cyan: 50, magenta: 50, yellow: 50 } }),
      NOW,
    );
    expect(label).toEqual({ text: 'No meter reading · 6h', tone: 'critical' });
  });

  it('switches the age to whole days past 48 hours', () => {
    const label = deviceStatusLabel(row({ offline: true, lastCounterAt: hoursAgo(72) }), NOW);
    expect(label).toEqual({ text: 'No meter reading · 3d', tone: 'critical' });
  });

  it('falls back to a bare "No meter reading" when the device has never reported', () => {
    const label = deviceStatusLabel(row({ offline: true, lastCounterAt: null }), NOW);
    expect(label).toEqual({ text: 'No meter reading', tone: 'critical' });
  });

  it('softens to amber when an alarm proves the device is still reaching CSRC', () => {
    const label = deviceStatusLabel(row({ offline: true, lastCounterAt: hoursAgo(31), lastAlarmAt: hoursAgo(1) }), NOW);
    expect(label).toEqual({ text: 'No meter reading · reaching CSRC', tone: 'warn' });
  });

  it('stays red when the last alarm is older than the threshold too', () => {
    const label = deviceStatusLabel(row({ offline: true, lastCounterAt: hoursAgo(31), lastAlarmAt: hoursAgo(30) }), NOW);
    expect(label).toEqual({ text: 'No meter reading · 31h', tone: 'critical' });
  });

  it('ignores an alarm dated in the future rather than calling the device healthy', () => {
    const label = deviceStatusLabel(
      row({ offline: true, lastCounterAt: hoursAgo(31), lastAlarmAt: new Date(NOW.getTime() + 3_600_000) }),
      NOW,
    );
    expect(label).toEqual({ text: 'No meter reading · 31h', tone: 'critical' });
  });

  it('reports critical toner ahead of low toner', () => {
    const label = deviceStatusLabel(row({ toner: { black: 4, cyan: 15, magenta: 50, yellow: 50 } }), NOW);
    expect(label).toEqual({ text: 'Toner critical', tone: 'critical' });
  });

  it('reports low toner when nothing is critical', () => {
    const label = deviceStatusLabel(row({ toner: { black: 50, cyan: 15, magenta: 50, yellow: 50 } }), NOW);
    expect(label).toEqual({ text: 'Toner low', tone: 'warn' });
  });

  it('reports "No counters" when the device has no toner readings at all', () => {
    const label = deviceStatusLabel(row({ toner: { black: null, cyan: null, magenta: null, yellow: null } }), NOW);
    expect(label).toEqual({ text: 'No counters', tone: 'muted' });
  });

  it('treats a mono device with only a black reading as online', () => {
    const label = deviceStatusLabel(row({ toner: { black: 88, cyan: null, magenta: null, yellow: null } }), NOW);
    expect(label).toEqual({ text: 'Online', tone: 'ok' });
  });

  it('reports online when everything is healthy', () => {
    expect(deviceStatusLabel(row(), NOW)).toEqual({ text: 'Online', tone: 'ok' });
  });
});

describe('hasRecentAlarm', () => {
  it('is false without an alarm', () => {
    expect(hasRecentAlarm(row({ lastAlarmAt: null }), NOW)).toBe(false);
  });

  it('is true inside the 24h window and false outside it', () => {
    expect(hasRecentAlarm(row({ lastAlarmAt: hoursAgo(23) }), NOW)).toBe(true);
    expect(hasRecentAlarm(row({ lastAlarmAt: hoursAgo(25) }), NOW)).toBe(false);
  });

  it('is false for a timestamp in the future, which can only be bad data', () => {
    expect(hasRecentAlarm(row({ lastAlarmAt: new Date(NOW.getTime() + 60_000) }), NOW)).toBe(false);
  });
});

describe('attentionRank', () => {
  const rank = (over: Partial<DeviceRow>) => attentionRank(row(over));

  it('puts toner first, because that is what the overview table is about', () => {
    const critical = rank({ toner: { black: 2, cyan: 50, magenta: 50, yellow: 50 } });
    const low = rank({ toner: { black: 12, cyan: 50, magenta: 50, yellow: 50 } });
    const offline = rank({ offline: true });
    const unlinked = rank({ vantageEquipmentId: null });
    const online = rank({});
    const noCounters = rank({ toner: { black: null, cyan: null, magenta: null, yellow: null } });

    expect(critical).toBeLessThan(low);
    expect(low).toBeLessThan(offline);
    expect(offline).toBeLessThan(unlinked);
    expect(unlinked).toBeLessThan(online);
    expect(online).toBeLessThan(noCounters);
  });

  it('ranks an offline device by its toner when it still has readings', () => {
    expect(rank({ offline: true, toner: { black: 2, cyan: 50, magenta: 50, yellow: 50 } })).toBe(
      rank({ toner: { black: 2, cyan: 50, magenta: 50, yellow: 50 } }),
    );
  });
});

describe('tonerHealth', () => {
  it('tallies every known cartridge and ignores the unknown ones', () => {
    const tally = tonerHealth([
      row({ toner: { black: 2, cyan: 12, magenta: 50, yellow: null } }),
      row({ toner: { black: null, cyan: null, magenta: null, yellow: null } }),
      row({ toner: { black: 100, cyan: 100, magenta: 100, yellow: 100 } }),
    ]);
    expect(tally).toEqual({ critical: 1, low: 1, ok: 5, total: 7 });
  });

  it('is all zeroes for a fleet with no readings', () => {
    expect(tonerHealth([])).toEqual({ critical: 0, low: 0, ok: 0, total: 0 });
  });
});

describe('topIssueType', () => {
  it('picks the biggest type', () => {
    expect(topIssueType({ link_broken: 5, no_match_drms: 996 })).toEqual({ type: 'no_match_drms', count: 996 });
  });

  it('breaks ties by name so the line does not flicker between renders', () => {
    expect(topIssueType({ b_type: 3, a_type: 3 })).toEqual({ type: 'a_type', count: 3 });
  });

  it('is null when nothing is open', () => {
    expect(topIssueType({})).toBeNull();
    expect(topIssueType({ link_broken: 0 })).toBeNull();
  });
});

describe('deviceNameAddsInfo', () => {
  it('is false when there is no name to show', () => {
    expect(deviceNameAddsInfo(null, 'bizhub C3351i')).toBe(false);
    expect(deviceNameAddsInfo('   ', 'bizhub C3351i')).toBe(false);
  });

  it('is true when there is a name but no model to compare it against', () => {
    expect(deviceNameAddsInfo('Reception', null)).toBe(true);
  });

  it('is false when the name is just the model with a version suffix', () => {
    expect(deviceNameAddsInfo('ineo+458_Ver42', 'ineo+458')).toBe(false);
    expect(deviceNameAddsInfo('ineo+458Ver2', 'ineo+458')).toBe(false);
  });

  it('is false when the name and the model are the same thing punctuated differently', () => {
    expect(deviceNameAddsInfo('bizhub C3351i', 'bizhub-C3351i')).toBe(false);
    expect(deviceNameAddsInfo('BIZHUB C3351I', 'bizhub C3351i')).toBe(false);
  });

  it('is false when the name is only part of the model', () => {
    expect(deviceNameAddsInfo('C3351i', 'bizhub C3351i')).toBe(false);
  });

  it('is true when the name carries a site the model does not', () => {
    expect(deviceNameAddsInfo('Little Heath School (Maths) C3351i', 'bizhub C3351i')).toBe(true);
    expect(deviceNameAddsInfo('Reception', 'bizhub C458')).toBe(true);
  });

  it('keeps a site name that wraps the whole model, which plain containment would have hidden', () => {
    expect(deviceNameAddsInfo('A-Plan (Southampton) MF3303', 'MF3303')).toBe(true);
  });

  it('only drops a trailing version suffix, not a version in the middle of a name', () => {
    expect(deviceNameAddsInfo('Ver42 Studio ineo+458', 'ineo+458')).toBe(true);
  });
});
