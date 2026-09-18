import { describe, expect, it } from 'vitest';
import type { DeviceAlarmRow } from '@mps/db/queries';
import {
  alarmCode,
  alarmStatusLabel,
  counterHistoryRows,
  groupAlarms,
  meterChannels,
  orderStatus,
  rawString,
} from './device-detail';

const at = (iso: string) => new Date(iso);

function alarm(over: Partial<DeviceAlarmRow> & { alarmId: string }): DeviceAlarmRow {
  return {
    receivedTime: at('2026-09-17T12:00:00Z'),
    fcCode: null,
    scCode: null,
    description: null,
    status: null,
    category: null,
    totalCount: null,
    totalColorCount: null,
    ...over,
  };
}

describe('rawString', () => {
  it('reads a string field out of a DRMS/Vantage raw blob', () => {
    expect(rawString({ CsrcComServerId: 'COM_GB502' }, 'CsrcComServerId')).toBe('COM_GB502');
  });

  it('returns null for missing, blank, non-string and non-object input', () => {
    expect(rawString({ CsrcId: '' }, 'CsrcId')).toBeNull();
    expect(rawString({ CsrcId: '  ' }, 'CsrcId')).toBeNull();
    expect(rawString({}, 'CsrcId')).toBeNull();
    expect(rawString({ CsrcId: 42 }, 'CsrcId')).toBeNull();
    expect(rawString(null, 'CsrcId')).toBeNull();
    expect(rawString(undefined, 'CsrcId')).toBeNull();
    expect(rawString('not an object', 'CsrcId')).toBeNull();
    expect(rawString([1, 2, 3], 'CsrcId')).toBeNull();
  });

  it('trims what it returns, so a padded value does not render as padded', () => {
    expect(rawString({ CsrcId: ' A93E021244196 ' }, 'CsrcId')).toBe('A93E021244196');
  });
});

describe('groupAlarms', () => {
  const rows = [
    alarm({ alarmId: 'a', category: 'toner', receivedTime: at('2026-09-18T09:00:00Z') }),
    alarm({ alarmId: 'b', category: 'waste', receivedTime: at('2026-09-17T09:00:00Z') }),
    alarm({ alarmId: 'c', category: 'toner', receivedTime: at('2026-09-16T09:00:00Z') }),
    alarm({ alarmId: 'd', category: 'jam', receivedTime: at('2026-09-15T09:00:00Z') }),
    alarm({ alarmId: 'e', category: 'service', receivedTime: at('2026-09-14T09:00:00Z') }),
    alarm({ alarmId: 'f', category: 'parts', receivedTime: at('2026-09-13T09:00:00Z') }),
    alarm({ alarmId: 'g', category: null, receivedTime: at('2026-09-12T09:00:00Z') }),
  ];

  it('orders the groups waste, parts, toner, other and drops empty ones', () => {
    const { groups } = groupAlarms(rows, false);
    expect(groups.map((g) => g.key)).toEqual(['waste', 'parts', 'toner', 'other']);
    expect(groups.map((g) => g.label)).toEqual(['Waste toner bottle', 'Parts life', 'Toner', 'Other']);
  });

  it('hides jam and service by default and counts what it hid', () => {
    const { groups, hiddenCount } = groupAlarms(rows, false);
    expect(groups.some((g) => g.key === 'jam' || g.key === 'service')).toBe(false);
    expect(hiddenCount).toBe(2);
  });

  it('shows jam and service last when asked, and then hides nothing', () => {
    const { groups, hiddenCount } = groupAlarms(rows, true);
    expect(groups.map((g) => g.key)).toEqual(['waste', 'parts', 'toner', 'other', 'jam', 'service']);
    expect(hiddenCount).toBe(0);
  });

  it('puts an unrecognised category into Other rather than dropping the alarm', () => {
    const { groups } = groupAlarms([alarm({ alarmId: 'x', category: 'brand-new-thing' })], false);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('other');
    expect(groups[0]!.rows[0]!.alarmId).toBe('x');
  });

  it('sorts each group newest first even if the input is not', () => {
    const jumbled = [
      alarm({ alarmId: 'old', category: 'toner', receivedTime: at('2026-09-01T09:00:00Z') }),
      alarm({ alarmId: 'new', category: 'toner', receivedTime: at('2026-09-18T09:00:00Z') }),
    ];
    expect(groupAlarms(jumbled, false).groups[0]!.rows.map((r) => r.alarmId)).toEqual(['new', 'old']);
  });

  it('returns no groups for a device with no alarms', () => {
    expect(groupAlarms([], true)).toEqual({ groups: [], hiddenCount: 0 });
  });
});

describe('alarmCode', () => {
  it('shows the FC code, adding the SC code when there is one', () => {
    expect(alarmCode(alarm({ alarmId: 'a', fcCode: 'TN-00', scCode: '06' }))).toBe('TN-00 · SC 06');
    expect(alarmCode(alarm({ alarmId: 'a', fcCode: 'JF-01', scCode: null }))).toBe('JF-01');
  });

  it('falls back to the SC code alone, then to an em dash', () => {
    expect(alarmCode(alarm({ alarmId: 'a', fcCode: null, scCode: '541' }))).toBe('SC 541');
    expect(alarmCode(alarm({ alarmId: 'a' }))).toBe('—');
  });
});

describe('alarmStatusLabel', () => {
  it('turns the DRMS PascalCase statuses into a sentence', () => {
    expect(alarmStatusLabel('ReadyForErpDelivery')).toBe('Ready for ERP delivery');
    expect(alarmStatusLabel('EquipmentDiscovered')).toBe('Equipment discovered');
    expect(alarmStatusLabel('UnknownFcScCode')).toBe('Unknown FC/SC code');
    expect(alarmStatusLabel('BlockedBySuccessfulServiceCallInPeriod')).toBe(
      'Blocked by successful service call in period',
    );
  });

  it('leaves an unknown status readable and handles nothing at all', () => {
    expect(alarmStatusLabel('SomethingNewEntirely')).toBe('Something new entirely');
    expect(alarmStatusLabel(null)).toBe('—');
    expect(alarmStatusLabel('')).toBe('—');
  });
});

describe('meterChannels', () => {
  it('gives a colour device the black, colour and scan meters', () => {
    expect(meterChannels(true).map((c) => c.label)).toEqual(['Black', 'Colour', 'Scan']);
  });

  it('drops the colour meter for a mono device, which never reports one', () => {
    expect(meterChannels(false).map((c) => c.label)).toEqual(['Black', 'Scan']);
  });
});

describe('counterHistoryRows', () => {
  const COLOUR = meterChannels(true);
  const MONO = meterChannels(false);
  const history = {
    'Black:Total': [
      { at: at('2026-09-01T10:00:00Z'), value: 8000 },
      { at: at('2026-09-10T10:00:00Z'), value: 8200 },
      { at: at('2026-09-17T10:00:00Z'), value: 8319 },
    ],
    'Full Color:Total': [
      { at: at('2026-09-01T10:00:00Z'), value: 6000 },
      { at: at('2026-09-17T10:00:00Z'), value: 6424 },
    ],
    'Scanner/FAX:Scan': [{ at: at('2026-09-17T10:00:00Z'), value: 436 }],
  };

  it('merges the three meters onto one row per snapshot, newest first', () => {
    const rows = counterHistoryRows(history, COLOUR);
    expect(rows.map((r) => r.at.toISOString())).toEqual([
      '2026-09-17T10:00:00.000Z',
      '2026-09-10T10:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
    ]);
    expect(rows[0]).toMatchObject({ black: 8319, colour: 6424, scan: 436 });
  });

  it('leaves a meter null on a snapshot that did not report it', () => {
    const rows = counterHistoryRows(history, COLOUR);
    expect(rows[1]).toMatchObject({ black: 8200, colour: null, scan: null });
  });

  it('computes each delta against the previous snapshot, and null when either side is missing', () => {
    const rows = counterHistoryRows(history, COLOUR);
    expect(rows[0]!.deltas).toEqual({ black: 119, colour: null, scan: null });
    expect(rows[1]!.deltas).toEqual({ black: 200, colour: null, scan: null });
    // The oldest row has nothing to compare against.
    expect(rows[2]!.deltas).toEqual({ black: null, colour: null, scan: null });
  });

  it('applies the limit to the newest rows but still deltas the last one against the row before it', () => {
    const rows = counterHistoryRows(history, COLOUR, 2);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.deltas.black).toBe(200);
  });

  it('leaves the colour meter out for a mono device, even when the history holds one', () => {
    // `Full Color:Total` on a mono device can only be a leftover from before the model was known:
    // the page does not ask for it, and a column of em dashes for ever is worse than no column.
    const rows = counterHistoryRows(history, MONO);
    expect(rows[0]).toMatchObject({ black: 8319, colour: null, scan: 436 });
    expect(rows[0]!.deltas).toEqual({ black: 119, colour: null, scan: null });
    expect(rows.every((r) => r.colour === null)).toBe(true);
  });

  it('returns nothing for a device with no counter history', () => {
    expect(counterHistoryRows({}, COLOUR)).toEqual([]);
    expect(counterHistoryRows({ 'Black:Total': [] }, COLOUR)).toEqual([]);
  });

  it('survives a device with exactly one snapshot, which is what the live data mostly has', () => {
    const rows = counterHistoryRows({ 'Black:Total': [{ at: at('2026-09-17T10:00:00Z'), value: 8319 }] }, COLOUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deltas.black).toBeNull();
  });
});

describe('orderStatus', () => {
  it('reads Open while completedDate is null', () => {
    expect(orderStatus({ completedDate: null, isOnHold: false })).toEqual({ text: 'Open', tone: 'warn' });
    expect(orderStatus({ completedDate: null, isOnHold: null })).toEqual({ text: 'Open', tone: 'warn' });
  });

  it('reads Completed once Vantage sets completedDate, even if the hold flag lingers', () => {
    expect(orderStatus({ completedDate: at('2026-09-10T00:00:00Z'), isOnHold: true })).toEqual({
      text: 'Completed',
      tone: 'ok',
    });
  });

  it('reads On hold for an uncompleted order that is held', () => {
    expect(orderStatus({ completedDate: null, isOnHold: true })).toEqual({ text: 'On hold', tone: 'muted' });
  });
});
