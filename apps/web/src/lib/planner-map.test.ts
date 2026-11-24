import { describe, expect, it } from 'vitest';
import type { MapPin, MapPlanResult } from '@mps/db/queries';
import { MAP_IDS_MAX, farFromCall, mapResultText, parseMapIds, pinTone, selectInBox } from './planner-map';

function pin(over: Partial<MapPin> = {}): MapPin {
  return {
    vantageEquipmentId: 1, customerId: 1, customerName: 'A', town: null, serial: null, model: null,
    status: 'overdue', overdueMonths: 2, priority: false, whenInArea: false, boardColumn: null,
    district: null, at: { lat: 52, lng: -1 }, approximate: false, ...over,
  } as MapPin;
}

describe('pinTone', () => {
  it('overdue', () => expect(pinTone(pin({ status: 'overdue' }))).toBe('overdue'));
  it('due soon', () => expect(pinTone(pin({ status: 'due_soon' }))).toBe('due_soon'));
  it('when in area wins over status', () => expect(pinTone(pin({ status: 'overdue', whenInArea: true }))).toBe('when_in_area'));
  it('other', () => expect(pinTone(pin({ status: 'ok' as MapPin['status'] }))).toBe('other'));
});

describe('selectInBox', () => {
  const box = { south: 51, west: -2, north: 53, east: 0 };
  it('box with no pins selects nothing', () => expect(selectInBox([], box)).toEqual([]));
  it('stacked pins all inside box', () => {
    const pins = [1, 2, 3].map((id) => pin({ vantageEquipmentId: id }));
    expect(selectInBox(pins, box)).toEqual([1, 2, 3]);
  });
  it('edges are inclusive', () => {
    const p = pin({ vantageEquipmentId: 9, at: { lat: 51, lng: 0 } });
    expect(selectInBox([p, pin({ vantageEquipmentId: 10, at: { lat: 50.99, lng: 0 } })], box)).toEqual([9]);
  });
});

describe('farFromCall', () => {
  const at = { lat: 52, lng: -1 };
  const near = pin({ vantageEquipmentId: 1, at: { lat: 52 + 5 / 69.05, lng: -1 } });
  const far = pin({ vantageEquipmentId: 2, at: { lat: 52 + 20 / 69.05, lng: -1 } });
  it('counts pins over miles', () => expect(farFromCall([near, far], { at }, 10)).toBe(1));
  it('call without at is 0', () => expect(farFromCall([near, far], { at: null }, 10)).toBe(0));
});

describe('parseMapIds', () => {
  it('rejects bad input', () => {
    for (const bad of ['1', [0], [1.5], null, Array.from({ length: MAP_IDS_MAX + 1 }, (_, i) => i + 1)]) {
      expect(() => parseMapIds(bad)).toThrow('bad ids');
    }
  });
  it('rejects empty', () => expect(() => parseMapIds([])).toThrow('bad ids'));
  it('de-dups', () => expect(parseMapIds([3, 3, 4])).toEqual([3, 4]));
});

describe('mapResultText', () => {
  it('add', () => expect(mapResultText({ done: [1, 2, 3, 4], skipped: [] }, 'add')).toBe('4 added to plan'));
  it('ask with skip', () => {
    const r: MapPlanResult = {
      done: [1, 2, 3],
      skipped: [{ vantageEquipmentId: 9, reason: 'not_on_map' }],
      call: { engineerName: 'Dave', start: new Date('2026-11-25T10:00:00Z') },
    };
    expect(mapResultText(r, 'ask')).toBe('3 asked Dave for Wed 25 Nov · 1 skipped: no longer due');
  });
});
