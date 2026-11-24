import { describe, expect, it } from 'vitest';
import type { UpcomingPanelView } from './planner-upcoming';
import { PM_IDS_MIME, dayPanel, dragIds, dragPayload } from './planner-pms-in-area';

describe('dragPayload / dragIds', () => {
  it('uses its own MIME type', () => {
    expect(PM_IDS_MIME).toBe('application/x-pm-ids');
  });

  it('round-trips ids', () => {
    expect(dragPayload([1, 22, 333])).toBe('ids:1,22,333');
    expect(dragIds('ids:1,22,333')).toEqual([1, 22, 333]);
  });

  it('de-duplicates and tolerates surrounding space', () => {
    expect(dragIds(' ids:5,5,6 ')).toEqual([5, 6]);
  });

  it('rejects junk', () => {
    for (const junk of ['', 'ids:', 'ids:,1', 'ids:1,,2', 'ids:0', 'ids:-1', 'ids:1.5', 'ids:abc', '1,2', 'ids:12345678901', 'IDS:1', 'ids:1;2']) {
      expect(dragIds(junk)).toEqual([]);
    }
  });

  it('rejects more ids than an action takes', () => {
    const many = Array.from({ length: 501 }, (_, i) => i + 1);
    expect(dragIds(dragPayload(many))).toEqual([]);
    expect(dragIds(dragPayload(many.slice(0, 500)))).toHaveLength(500);
  });
});

const panel = (over: Partial<UpcomingPanelView> = {}): UpcomingPanelView => ({
  empty: null,
  showsError: false,
  dayLabels: { today: 'Today 24 Nov', tomorrow: 'Tomorrow 25 Nov' },
  engineers: [
    {
      key: '3',
      name: 'Dave',
      canAsk: true,
      days: [
        { which: 'today', heading: 'Today 24 Nov', emptyText: 'No booked calls today', calls: [{ workUnitId: 10 } as never] },
        { which: 'tomorrow', heading: 'Tomorrow 25 Nov', emptyText: 'No booked calls tomorrow', calls: [] },
      ],
    },
    {
      key: '4',
      name: 'Sam',
      canAsk: true,
      days: [
        { which: 'today', heading: 'Today 24 Nov', emptyText: 'No booked calls today', calls: [] },
        { which: 'tomorrow', heading: 'Tomorrow 25 Nov', emptyText: 'No booked calls tomorrow', calls: [] },
      ],
    },
  ],
  ...over,
});

describe('dayPanel', () => {
  it("keeps only the engineers with calls that day", () => {
    const d = dayPanel(panel(), 'today');
    expect(d.empty).toBeNull();
    expect(d.engineers.map((e) => [e.name, e.calls.length])).toEqual([['Dave', 1]]);
  });

  it('says there are no booked calls on an empty day', () => {
    expect(dayPanel(panel(), 'tomorrow')).toEqual({ empty: 'No booked calls tomorrow', engineers: [] });
  });

  it("passes the panel's own empty text through (the diary staleness note)", () => {
    expect(dayPanel(panel({ empty: "Engineers' diary hasn't refreshed yet", engineers: [] }), 'today')).toEqual({
      empty: "Engineers' diary hasn't refreshed yet",
      engineers: [],
    });
  });
});
