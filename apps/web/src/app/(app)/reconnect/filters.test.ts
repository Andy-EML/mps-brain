import { describe, expect, it } from 'vitest';
import { reconnectSortKeys } from './filters';

describe('reconnectSortKeys', () => {
  it('is Last contact on the silent lists, First connected / Last alarm on Not monitored yet', () => {
    for (const filter of ['all', 'new', 'long'] as const) {
      expect(reconnectSortKeys(filter)).toEqual(['customer', 'location', 'device', 'serial', 'status', 'lastContact']);
    }
    expect(reconnectSortKeys('unmonitored')).toEqual([
      'customer',
      'location',
      'device',
      'serial',
      'status',
      'firstConnected',
      'lastAlarm',
    ]);
  });
});
